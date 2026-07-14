import crypto from "node:crypto";
import fs, { constants as fsConstants } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  AI_RUN_EVENT_TYPES,
  AI_RUN_PERMISSION_MODES,
  AI_RUN_PROVIDERS,
  AI_RUN_STATUSES,
  AI_RUN_TEMPLATE_IDS,
} from "./run-workspace-store.mjs";
import { redactAiLogValue, redactSensitiveString } from "./redaction.mjs";

export {
  AI_RUN_EVENT_TYPES,
  AI_RUN_PERMISSION_MODES,
  AI_RUN_PROVIDERS,
  AI_RUN_STATUSES,
  AI_RUN_TEMPLATE_IDS,
};

export const AI_RUN_METADATA_SCHEMA_VERSION = 2;
export const AI_RUN_METADATA_DATABASE_NAME = "ai-runs.sqlite";

const RUN_ID_RE = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERMISSION_ID_RE = /^perm-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IMPORT_ID_RE = /^import-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const RAW_ENV_KEY_RE = /^(?:env|environment|raw(?:[-_]?env|environment)|process(?:[-_]?env|environment)|runtime(?:[-_]?env|environment))$/i;
const PERSISTED_SENSITIVE_KEY_RE = /(?:authorization|cookie|token|secret|password|passwd|api[-_]?key)$/i;
const RESIDUAL_SECRET_ASSIGNMENT_RE = /\b([A-Za-z0-9_-]*(?:token|secret|cookie|password|passwd))\s*([:=])\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PERMISSION_DECISIONS = Object.freeze(["allow_once", "reject_once"]);
const IMPORT_STATUSES = Object.freeze(["confirmed", "failed"]);
const MAX_TITLE_LENGTH = 500;
const MAX_WORKSPACE_PATH_LENGTH = 4_096;
const MAX_ERROR_SUMMARY_LENGTH = 2_000;
const MAX_TOOL_CALL_ID_LENGTH = 500;
const MAX_PERMISSION_KIND_LENGTH = 100;
const MAX_TARGET_REF_LENGTH = 2_000;
const MAX_RUN_METADATA_BYTES = 32 * 1024;
const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
const MAX_PERMISSION_JSON_BYTES = 32 * 1024;
const MAX_IMPORT_JSON_BYTES = 32 * 1024;
const BUSY_TIMEOUT_MS = 5_000;

const RUN_TRANSITIONS = Object.freeze({
  queued: new Set(["running", "failed", "cancelled"]),
  running: new Set(["waiting_permission", "completed", "failed", "cancelled"]),
  waiting_permission: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});

export class AiRunMetadataValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "AiRunMetadataValidationError";
  }
}

export class AiRunMetadataSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiRunMetadataSecurityError";
  }
}

export class AiRunMetadataNotFoundError extends Error {
  constructor(kind, id) {
    super(`${kind}不存在：${id}`);
    this.name = "AiRunMetadataNotFoundError";
  }
}

export class AiRunMetadataStateError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiRunMetadataStateError";
  }
}

export class AiRunPermissionResolvedError extends Error {
  constructor(permissionId) {
    super(`权限请求已经解决，不能重复操作：${permissionId}`);
    this.name = "AiRunPermissionResolvedError";
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new AiRunMetadataValidationError(`${label}必须是普通对象`);
  return value;
}

function assertOnlyKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new AiRunMetadataValidationError(`${label}包含未知字段：${unexpected.join("、")}`);
  }
}

function assertText(value, label, { min = 0, max = 20_000, multiline = true } = {}) {
  if (typeof value !== "string") throw new AiRunMetadataValidationError(`${label}必须是文本`);
  if (value.length < min || value.length > max) {
    throw new AiRunMetadataValidationError(`${label}长度必须在 ${min} 到 ${max} 个字符之间`);
  }
  if (CONTROL_CHARACTER_RE.test(value)) throw new AiRunMetadataValidationError(`${label}包含控制字符`);
  if (!multiline && /[\r\n]/.test(value)) throw new AiRunMetadataValidationError(`${label}不能换行`);
  return value;
}

function assertOptionalText(value, label, options) {
  if (value === null || value === undefined) return null;
  return assertText(value, label, options);
}

function assertIsoTimestamp(value, label) {
  assertText(value, label, { min: 20, max: 40, multiline: false });
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new AiRunMetadataValidationError(`${label}必须是完整 ISO 时间`);
  }
  return value;
}

function assertRunId(runId) {
  assertText(runId, "runId", { min: 40, max: 40, multiline: false });
  if (!RUN_ID_RE.test(runId)) throw new AiRunMetadataValidationError("runId 格式无效");
  return runId;
}

function assertPermissionId(permissionId) {
  assertText(permissionId, "permissionId", { min: 6, max: 133, multiline: false });
  if (!PERMISSION_ID_RE.test(permissionId)) {
    throw new AiRunMetadataValidationError("permissionId 格式无效");
  }
  return permissionId;
}

function assertImportId(importId) {
  assertText(importId, "importId", { min: 8, max: 135, multiline: false });
  if (!IMPORT_ID_RE.test(importId)) throw new AiRunMetadataValidationError("importId 格式无效");
  return importId;
}

function assertNoRawEnvironment(value, label, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry) => assertNoRawEnvironment(entry, label, seen));
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (RAW_ENV_KEY_RE.test(key)) {
        throw new AiRunMetadataSecurityError(`${label}不能包含原始环境变量字段`);
      }
      assertNoRawEnvironment(entry, label, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function redactPersistedString(value) {
  // The shared redactor remains the first pass. This local second pass covers
  // generic token=/secret= assignments in otherwise free-form UI text.
  return redactSensitiveString(value).replace(
    RESIDUAL_SECRET_ASSIGNMENT_RE,
    (_match, key, separator) => `${key}${separator}[REDACTED]`,
  );
}

function redactResidualStrings(value) {
  if (typeof value === "string") return redactPersistedString(value);
  if (Array.isArray(value)) return value.map(redactResidualStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        PERSISTED_SENSITIVE_KEY_RE.test(key) ? "[REDACTED]" : redactResidualStrings(entry),
      ]),
    );
  }
  return value;
}

function encodeRedactedJsonObject(value, label, maxBytes) {
  const input = value ?? {};
  assertPlainObject(input, label);
  const redacted = redactResidualStrings(redactAiLogValue(input));
  // Redaction always runs before the explicit raw-environment rejection.
  assertNoRawEnvironment(redacted, label);
  const serialized = JSON.stringify(redacted);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new AiRunMetadataValidationError(`${label}超过 ${maxBytes} 字节上限`);
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new AiRunMetadataValidationError(`${label}无法序列化为 JSON`, error);
  }
  if (!isPlainObject(parsed)) throw new AiRunMetadataValidationError(`${label}必须序列化为 JSON 对象`);
  return { serialized, value: parsed };
}

function parseStoredJsonObject(value, label, maxBytes) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new AiRunMetadataValidationError(`${label}不是有效的受限 JSON 文本`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new AiRunMetadataValidationError(`${label}无法解析`, error);
  }
  if (!isPlainObject(parsed)) throw new AiRunMetadataValidationError(`${label}必须是 JSON 对象`);
  assertNoRawEnvironment(parsed, label);
  return parsed;
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AiRunMetadataValidationError("now() 返回了无效时间");
  return date.toISOString();
}

function assertAbsoluteWorkspacePath(value) {
  assertText(value, "workspacePath", { min: 1, max: MAX_WORKSPACE_PATH_LENGTH, multiline: false });
  if (!path.isAbsolute(value) || value.split(/[\\/]+/).includes("..")) {
    throw new AiRunMetadataSecurityError("workspacePath 必须是无 .. 路径段的绝对路径");
  }
  return path.normalize(value);
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function prepareDatabaseFile(stateRootInput) {
  if (typeof stateRootInput !== "string" || !path.isAbsolute(stateRootInput)) {
    throw new AiRunMetadataValidationError("stateRoot 必须是绝对路径");
  }
  if (stateRootInput.split(/[\\/]+/).includes("..")) {
    throw new AiRunMetadataSecurityError("stateRoot 不能包含 .. 路径段");
  }
  const stateRoot = path.resolve(stateRootInput);
  const directParent = path.dirname(stateRoot);
  const parentStat = lstatOrNull(directParent);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) {
    throw new AiRunMetadataSecurityError("stateRoot 的父目录不能缺失、为软链接或非目录");
  }

  let rootStat = lstatOrNull(stateRoot);
  if (!rootStat) {
    try {
      fs.mkdirSync(stateRoot, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    rootStat = lstatOrNull(stateRoot);
  }
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new AiRunMetadataSecurityError("stateRoot 不能是软链接或非目录");
  }
  fs.chmodSync(stateRoot, 0o700);
  const canonicalRoot = fs.realpathSync(stateRoot);
  const checkedRoot = lstatOrNull(stateRoot);
  if (!checkedRoot?.isDirectory() || checkedRoot.isSymbolicLink()) {
    throw new AiRunMetadataSecurityError("stateRoot 在建库前发生替换");
  }

  const dbPath = path.join(stateRoot, AI_RUN_METADATA_DATABASE_NAME);
  let dbStat = lstatOrNull(dbPath);
  if (!dbStat) {
    const flags = fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0);
    const descriptor = fs.openSync(dbPath, flags, 0o600);
    fs.closeSync(descriptor);
    dbStat = lstatOrNull(dbPath);
  }
  if (!dbStat?.isFile() || dbStat.isSymbolicLink()) {
    throw new AiRunMetadataSecurityError("SQLite 文件不能是软链接或非普通文件");
  }
  if (fs.realpathSync(dbPath) !== path.join(canonicalRoot, AI_RUN_METADATA_DATABASE_NAME)) {
    throw new AiRunMetadataSecurityError("SQLite 文件超出 stateRoot");
  }
  fs.chmodSync(dbPath, 0o600);
  return { stateRoot, dbPath, dbStat };
}

function configureDatabase(db) {
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  if (db.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new AiRunMetadataSecurityError("SQLite foreign_keys 未成功启用");
  }
  if (String(db.pragma("journal_mode", { simple: true })).toLowerCase() !== "wal") {
    throw new AiRunMetadataSecurityError("SQLite WAL 未成功启用");
  }
}

function runMigration(db) {
  const version = db.pragma("user_version", { simple: true });
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new AiRunMetadataValidationError("SQLite user_version 无效");
  }
  if (version > AI_RUN_METADATA_SCHEMA_VERSION) {
    throw new AiRunMetadataValidationError(
      `SQLite schema ${version} 高于当前支持版本 ${AI_RUN_METADATA_SCHEMA_VERSION}`,
    );
  }
  if (version === AI_RUN_METADATA_SCHEMA_VERSION) return;

  const providerChecks = AI_RUN_PROVIDERS.map((value) => `'${value}'`).join(", ");
  const templateChecks = AI_RUN_TEMPLATE_IDS.map((value) => `'${value}'`).join(", ");
  const permissionModeChecks = AI_RUN_PERMISSION_MODES.map((value) => `'${value}'`).join(", ");
  const statusChecks = AI_RUN_STATUSES.map((value) => `'${value}'`).join(", ");
  const eventChecks = AI_RUN_EVENT_TYPES.map((value) => `'${value}'`).join(", ");

  if (version === 1) {
    db.pragma("foreign_keys = OFF");
    try {
      const migration = db.transaction(() => {
        db.exec(`
          CREATE TABLE runs_v2 (
            run_id TEXT PRIMARY KEY CHECK(length(run_id) = 40),
            provider TEXT NOT NULL CHECK(provider IN (${providerChecks})),
            template_id TEXT CHECK(template_id IS NULL OR template_id IN (${templateChecks})),
            permission_mode TEXT NOT NULL CHECK(permission_mode IN (${permissionModeChecks})),
            status TEXT NOT NULL CHECK(status IN (${statusChecks})),
            workspace_path TEXT NOT NULL CHECK(length(workspace_path) BETWEEN 1 AND ${MAX_WORKSPACE_PATH_LENGTH}),
            title TEXT CHECK(title IS NULL OR length(title) <= ${MAX_TITLE_LENGTH}),
            metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND json_type(metadata_json) = 'object' AND length(metadata_json) <= ${MAX_RUN_METADATA_BYTES}),
            error_summary TEXT CHECK(error_summary IS NULL OR length(error_summary) <= ${MAX_ERROR_SUMMARY_LENGTH}),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT
          ) STRICT;
          INSERT INTO runs_v2 SELECT * FROM runs;
          DROP TABLE runs;
          ALTER TABLE runs_v2 RENAME TO runs;
          CREATE INDEX runs_updated ON runs(updated_at DESC, run_id);
          CREATE INDEX runs_provider_status ON runs(provider, status, updated_at DESC);
        `);
        db.pragma(`user_version = ${AI_RUN_METADATA_SCHEMA_VERSION}`);
      });
      migration.immediate();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    if (db.pragma("foreign_key_check").length > 0) {
      throw new AiRunMetadataValidationError("SQLite provider 迁移后外键校验失败");
    }
    return;
  }

  const migration = db.transaction(() => {
    db.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY CHECK(length(run_id) = 40),
        provider TEXT NOT NULL CHECK(provider IN (${providerChecks})),
        template_id TEXT CHECK(template_id IS NULL OR template_id IN (${templateChecks})),
        permission_mode TEXT NOT NULL CHECK(permission_mode IN (${permissionModeChecks})),
        status TEXT NOT NULL CHECK(status IN (${statusChecks})),
        workspace_path TEXT NOT NULL CHECK(length(workspace_path) BETWEEN 1 AND ${MAX_WORKSPACE_PATH_LENGTH}),
        title TEXT CHECK(title IS NULL OR length(title) <= ${MAX_TITLE_LENGTH}),
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND json_type(metadata_json) = 'object' AND length(metadata_json) <= ${MAX_RUN_METADATA_BYTES}),
        error_summary TEXT CHECK(error_summary IS NULL OR length(error_summary) <= ${MAX_ERROR_SUMMARY_LENGTH}),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;

      CREATE TABLE events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL CHECK(seq > 0),
        type TEXT NOT NULL CHECK(type IN (${eventChecks})),
        payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object' AND length(payload_json) <= ${MAX_EVENT_PAYLOAD_BYTES}),
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE permissions (
        permission_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL CHECK(length(tool_call_id) BETWEEN 1 AND ${MAX_TOOL_CALL_ID_LENGTH}),
        title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND ${MAX_TITLE_LENGTH}),
        kind TEXT CHECK(kind IS NULL OR length(kind) <= ${MAX_PERMISSION_KIND_LENGTH}),
        request_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(request_json) AND json_type(request_json) = 'object' AND length(request_json) <= ${MAX_PERMISSION_JSON_BYTES}),
        status TEXT NOT NULL CHECK(status IN ('pending', 'allowed', 'rejected')),
        decision TEXT CHECK(decision IS NULL OR decision IN ('allow_once', 'reject_once')),
        resolution_json TEXT CHECK(resolution_json IS NULL OR (json_valid(resolution_json) AND json_type(resolution_json) = 'object' AND length(resolution_json) <= ${MAX_PERMISSION_JSON_BYTES})),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        CHECK((status = 'pending' AND decision IS NULL AND resolution_json IS NULL AND resolved_at IS NULL)
          OR (status <> 'pending' AND decision IS NOT NULL AND resolution_json IS NOT NULL AND resolved_at IS NOT NULL)),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      ) STRICT;

      CREATE UNIQUE INDEX permissions_one_pending_per_run
        ON permissions(run_id) WHERE status = 'pending';
      CREATE INDEX permissions_run_created ON permissions(run_id, created_at DESC);

      CREATE TABLE imports (
        import_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        target_ref TEXT NOT NULL CHECK(length(target_ref) BETWEEN 1 AND ${MAX_TARGET_REF_LENGTH}),
        status TEXT NOT NULL CHECK(status IN ('confirmed', 'failed')),
        sha256 TEXT CHECK(sha256 IS NULL OR length(sha256) = 64),
        details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json) AND json_type(details_json) = 'object' AND length(details_json) <= ${MAX_IMPORT_JSON_BYTES}),
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX runs_updated ON runs(updated_at DESC, run_id);
      CREATE INDEX runs_provider_status ON runs(provider, status, updated_at DESC);
      CREATE INDEX imports_run_created ON imports(run_id, created_at DESC);
    `);
    db.pragma(`user_version = ${AI_RUN_METADATA_SCHEMA_VERSION}`);
  });
  migration.immediate();
}

function validateRunRow(row) {
  if (!row) return null;
  const runId = assertRunId(row.run_id);
  if (!AI_RUN_PROVIDERS.includes(row.provider)) throw new AiRunMetadataValidationError("数据库 provider 无效");
  if (row.template_id !== null && !AI_RUN_TEMPLATE_IDS.includes(row.template_id)) {
    throw new AiRunMetadataValidationError("数据库 template_id 无效");
  }
  if (!AI_RUN_PERMISSION_MODES.includes(row.permission_mode)) {
    throw new AiRunMetadataValidationError("数据库 permission_mode 无效");
  }
  if (!AI_RUN_STATUSES.includes(row.status)) throw new AiRunMetadataValidationError("数据库 status 无效");
  const metadata = parseStoredJsonObject(row.metadata_json, "runs.metadata_json", MAX_RUN_METADATA_BYTES);
  return {
    runId,
    provider: row.provider,
    templateId: row.template_id,
    permissionMode: row.permission_mode,
    status: row.status,
    workspacePath: assertAbsoluteWorkspacePath(row.workspace_path),
    title: assertOptionalText(row.title, "runs.title", { max: MAX_TITLE_LENGTH }),
    metadata,
    errorSummary: assertOptionalText(row.error_summary, "runs.error_summary", { max: MAX_ERROR_SUMMARY_LENGTH }),
    createdAt: assertIsoTimestamp(row.created_at, "runs.created_at"),
    updatedAt: assertIsoTimestamp(row.updated_at, "runs.updated_at"),
    startedAt: row.started_at === null ? null : assertIsoTimestamp(row.started_at, "runs.started_at"),
    completedAt: row.completed_at === null ? null : assertIsoTimestamp(row.completed_at, "runs.completed_at"),
  };
}

function validateEventPayload(input) {
  const candidate = assertPlainObject(input, "事件");
  assertOnlyKeys(candidate, ["type", "text", "title", "status", "toolCallId", "permissionId", "details"], "事件");
  if (!AI_RUN_EVENT_TYPES.includes(candidate.type)) throw new AiRunMetadataValidationError("事件 type 无效");
  const payload = {};
  for (const key of ["text", "title", "toolCallId", "permissionId"]) {
    if (candidate[key] !== undefined) {
      const max = key === "text" ? 50_000 : 500;
      payload[key] = assertText(candidate[key], `event.${key}`, { max });
    }
  }
  if (candidate.status !== undefined) {
    payload.status = assertText(candidate.status, "event.status", {
      min: 1,
      max: 100,
      multiline: false,
    });
  }
  if (candidate.details !== undefined) {
    if (!isPlainObject(candidate.details)) throw new AiRunMetadataValidationError("event.details 必须是普通对象");
    payload.details = candidate.details;
  }
  if (candidate.type === "status" && payload.status === undefined) {
    throw new AiRunMetadataValidationError("status 事件必须包含 status");
  }
  if (candidate.type === "permission" && payload.permissionId === undefined) {
    throw new AiRunMetadataValidationError("permission 事件必须包含 permissionId");
  }
  const encoded = encodeRedactedJsonObject(payload, "事件 payload", MAX_EVENT_PAYLOAD_BYTES);
  return { type: candidate.type, ...encoded };
}

function eventRowToPublic(row) {
  const payload = parseStoredJsonObject(row.payload_json, "events.payload_json", MAX_EVENT_PAYLOAD_BYTES);
  return {
    seq: row.seq,
    id: `event-${row.run_id}-${row.seq}`,
    runId: assertRunId(row.run_id),
    type: row.type,
    createdAt: assertIsoTimestamp(row.created_at, "events.created_at"),
    ...payload,
  };
}

function permissionRowToPublic(row) {
  if (!row) return null;
  return {
    permissionId: assertPermissionId(row.permission_id),
    runId: assertRunId(row.run_id),
    toolCallId: assertText(row.tool_call_id, "permissions.tool_call_id", { min: 1, max: MAX_TOOL_CALL_ID_LENGTH }),
    title: assertText(row.title, "permissions.title", { min: 1, max: MAX_TITLE_LENGTH }),
    kind: assertOptionalText(row.kind, "permissions.kind", { max: MAX_PERMISSION_KIND_LENGTH }),
    request: parseStoredJsonObject(row.request_json, "permissions.request_json", MAX_PERMISSION_JSON_BYTES),
    status: row.status,
    decision: row.decision,
    resolution: row.resolution_json === null
      ? null
      : parseStoredJsonObject(row.resolution_json, "permissions.resolution_json", MAX_PERMISSION_JSON_BYTES),
    createdAt: assertIsoTimestamp(row.created_at, "permissions.created_at"),
    resolvedAt: row.resolved_at === null
      ? null
      : assertIsoTimestamp(row.resolved_at, "permissions.resolved_at"),
  };
}

function importRowToPublic(row) {
  return {
    importId: assertImportId(row.import_id),
    runId: assertRunId(row.run_id),
    targetRef: assertText(row.target_ref, "imports.target_ref", { min: 1, max: MAX_TARGET_REF_LENGTH }),
    status: row.status,
    sha256: row.sha256,
    details: parseStoredJsonObject(row.details_json, "imports.details_json", MAX_IMPORT_JSON_BYTES),
    createdAt: assertIsoTimestamp(row.created_at, "imports.created_at"),
  };
}

function assertTransition(current, next) {
  if (current === next) return;
  if (!RUN_TRANSITIONS[current]?.has(next)) {
    throw new AiRunMetadataStateError(`运行状态不能从 ${current} 转换为 ${next}`);
  }
}

/**
 * Opens the local query index for AI collaboration runs. The manifest and
 * workspace files remain the evidence of record; this database only stores
 * bounded, redacted metadata used for lists, status and audit lookups.
 */
export function createAiRunMetadataDb(options = {}) {
  const { stateRoot, dbPath, dbStat } = prepareDatabaseFile(options.stateRoot);
  const now = options.now ?? (() => new Date());
  const runIdFactory = options.runIdFactory ?? (() => `run-${crypto.randomUUID()}`);
  const permissionIdFactory = options.permissionIdFactory ?? (() => `perm-${crypto.randomUUID()}`);
  const importIdFactory = options.importIdFactory ?? (() => `import-${crypto.randomUUID()}`);

  let db;
  try {
    db = new Database(dbPath, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    const afterOpen = lstatOrNull(dbPath);
    const rootAfterOpen = lstatOrNull(stateRoot);
    if (!afterOpen?.isFile() || afterOpen.isSymbolicLink()
      || afterOpen.dev !== dbStat.dev || afterOpen.ino !== dbStat.ino) {
      throw new AiRunMetadataSecurityError("SQLite 文件在打开期间被替换");
    }
    if (!rootAfterOpen?.isDirectory() || rootAfterOpen.isSymbolicLink()) {
      throw new AiRunMetadataSecurityError("stateRoot 在打开 SQLite 期间被替换");
    }
    configureDatabase(db);
    runMigration(db);
  } catch (error) {
    try { db?.close(); } catch {}
    throw error;
  }

  const statements = {
    runById: db.prepare("SELECT * FROM runs WHERE run_id = ?"),
    insertRun: db.prepare(`
      INSERT INTO runs (
        run_id, provider, template_id, permission_mode, status, workspace_path,
        title, metadata_json, error_summary, created_at, updated_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, NULL, ?, ?, NULL, NULL)
    `),
    updateRun: db.prepare(`
      UPDATE runs SET status = ?, title = ?, metadata_json = ?, error_summary = ?,
        updated_at = ?, started_at = ?, completed_at = ?
      WHERE run_id = ?
    `),
    nextEventSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?"),
    insertEvent: db.prepare("INSERT INTO events (run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)"),
    listEvents: db.prepare("SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"),
    permissionById: db.prepare("SELECT * FROM permissions WHERE permission_id = ?"),
    insertPermission: db.prepare(`
      INSERT INTO permissions (
        permission_id, run_id, tool_call_id, title, kind, request_json,
        status, decision, resolution_json, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)
    `),
    resolvePermission: db.prepare(`
      UPDATE permissions SET status = ?, decision = ?, resolution_json = ?, resolved_at = ?
      WHERE permission_id = ? AND status = 'pending'
    `),
    pendingPermissionCount: db.prepare("SELECT COUNT(*) AS count FROM permissions WHERE run_id = ? AND status = 'pending'"),
    rejectPendingPermissions: db.prepare(`
      UPDATE permissions SET status = 'rejected', decision = 'reject_once', resolution_json = ?, resolved_at = ?
      WHERE run_id = ? AND status = 'pending'
    `),
    insertImport: db.prepare(`
      INSERT INTO imports (import_id, run_id, target_ref, status, sha256, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    importById: db.prepare("SELECT * FROM imports WHERE import_id = ?"),
  };
  let closed = false;

  function timestamp() {
    return normalizeTimestamp(now());
  }

  function ensureOpen() {
    if (closed || !db.open) throw new AiRunMetadataStateError("AI 运行元数据数据库已经关闭");
  }

  function requireRun(runId) {
    ensureOpen();
    assertRunId(runId);
    const row = statements.runById.get(runId);
    if (!row) throw new AiRunMetadataNotFoundError("AI 运行", runId);
    return validateRunRow(row);
  }

  function createRun(input) {
    ensureOpen();
    const candidate = assertPlainObject(input, "创建运行参数");
    assertOnlyKeys(candidate, [
      "runId", "provider", "templateId", "permissionMode", "workspacePath", "title", "metadata",
    ], "创建运行参数");
    const runId = assertRunId(candidate.runId ?? runIdFactory());
    if (!AI_RUN_PROVIDERS.includes(candidate.provider)) {
      throw new AiRunMetadataValidationError(`provider 只能是：${AI_RUN_PROVIDERS.join("、")}`);
    }
    const templateId = candidate.templateId ?? null;
    if (templateId !== null && !AI_RUN_TEMPLATE_IDS.includes(templateId)) {
      throw new AiRunMetadataValidationError(`templateId 只能是：${AI_RUN_TEMPLATE_IDS.join("、")}`);
    }
    const permissionMode = candidate.permissionMode ?? "readonly";
    if (!AI_RUN_PERMISSION_MODES.includes(permissionMode)) {
      throw new AiRunMetadataValidationError(`permissionMode 只能是：${AI_RUN_PERMISSION_MODES.join("、")}`);
    }
    const workspacePath = assertAbsoluteWorkspacePath(candidate.workspacePath);
    const title = candidate.title === undefined
      ? null
      : (candidate.title === null
        ? null
        : redactPersistedString(assertText(candidate.title, "title", { max: MAX_TITLE_LENGTH })));
    const metadata = encodeRedactedJsonObject(candidate.metadata, "metadata", MAX_RUN_METADATA_BYTES);
    const createdAt = timestamp();
    statements.insertRun.run(
      runId,
      candidate.provider,
      templateId,
      permissionMode,
      workspacePath,
      title,
      metadata.serialized,
      createdAt,
      createdAt,
    );
    return requireRun(runId);
  }

  function getRun(runId) {
    return requireRun(runId);
  }

  function listRuns(options = {}) {
    ensureOpen();
    const candidate = assertPlainObject(options, "运行列表参数");
    assertOnlyKeys(candidate, ["provider", "status", "limit", "offset"], "运行列表参数");
    if (candidate.provider !== undefined && !AI_RUN_PROVIDERS.includes(candidate.provider)) {
      throw new AiRunMetadataValidationError("运行列表 provider 无效");
    }
    if (candidate.status !== undefined && !AI_RUN_STATUSES.includes(candidate.status)) {
      throw new AiRunMetadataValidationError("运行列表 status 无效");
    }
    const limit = candidate.limit ?? 50;
    const offset = candidate.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AiRunMetadataValidationError("limit 必须是 1 到 100 的整数");
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new AiRunMetadataValidationError("offset 必须是 0 到 1000000 的整数");
    }
    const conditions = [];
    const parameters = [];
    if (candidate.provider !== undefined) {
      conditions.push("provider = ?");
      parameters.push(candidate.provider);
    }
    if (candidate.status !== undefined) {
      conditions.push("status = ?");
      parameters.push(candidate.status);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS count FROM runs${where}`).get(...parameters).count;
    const rows = db.prepare(`
      SELECT * FROM runs${where}
      ORDER BY updated_at DESC, run_id ASC LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset);
    return { runs: rows.map(validateRunRow), total, limit, offset };
  }

  const updateRunTransaction = db.transaction((runId, patch) => {
    const current = requireRun(runId);
    const nextStatus = patch.status ?? current.status;
    if (!AI_RUN_STATUSES.includes(nextStatus)) throw new AiRunMetadataValidationError("运行 status 无效");
    assertTransition(current.status, nextStatus);
    if (nextStatus === "waiting_permission"
      && statements.pendingPermissionCount.get(runId).count === 0) {
      throw new AiRunMetadataStateError("没有待解决权限请求时不能进入 waiting_permission");
    }
    const title = patch.title === undefined
      ? current.title
      : (patch.title === null
        ? null
        : redactPersistedString(assertText(patch.title, "title", { max: MAX_TITLE_LENGTH })));
    const metadata = patch.metadata === undefined
      ? { serialized: JSON.stringify(current.metadata), value: current.metadata }
      : encodeRedactedJsonObject(patch.metadata, "metadata", MAX_RUN_METADATA_BYTES);
    const errorSummary = patch.errorSummary === undefined
      ? current.errorSummary
      : (patch.errorSummary === null
        ? null
        : redactPersistedString(assertText(patch.errorSummary, "errorSummary", { max: MAX_ERROR_SUMMARY_LENGTH })));
    const updatedAt = timestamp();
    const startedAt = current.startedAt ?? (nextStatus === "running" ? updatedAt : null);
    const completedAt = current.completedAt ?? (TERMINAL_STATUSES.has(nextStatus) ? updatedAt : null);
    if (TERMINAL_STATUSES.has(nextStatus)) {
      const resolution = encodeRedactedJsonObject(
        { reason: "run_terminal", status: nextStatus },
        "终止权限解决记录",
        MAX_PERMISSION_JSON_BYTES,
      );
      statements.rejectPendingPermissions.run(resolution.serialized, updatedAt, runId);
    }
    statements.updateRun.run(
      nextStatus,
      title,
      metadata.serialized,
      errorSummary,
      updatedAt,
      startedAt,
      completedAt,
      runId,
    );
    return requireRun(runId);
  });

  function updateRun(runId, patch) {
    ensureOpen();
    assertRunId(runId);
    const candidate = assertPlainObject(patch, "运行更新参数");
    assertOnlyKeys(candidate, ["status", "title", "metadata", "errorSummary"], "运行更新参数");
    if (Object.keys(candidate).length === 0) throw new AiRunMetadataValidationError("运行更新参数不能为空");
    return updateRunTransaction.immediate(runId, candidate);
  }

  const appendEventTransaction = db.transaction((runId, normalized) => {
    requireRun(runId);
    const seq = statements.nextEventSeq.get(runId).seq;
    const createdAt = timestamp();
    statements.insertEvent.run(runId, seq, normalized.type, normalized.serialized, createdAt);
    return eventRowToPublic({
      run_id: runId,
      seq,
      type: normalized.type,
      payload_json: normalized.serialized,
      created_at: createdAt,
    });
  });

  function appendEvent(runId, event) {
    ensureOpen();
    assertRunId(runId);
    const normalized = validateEventPayload(event);
    return appendEventTransaction.immediate(runId, normalized);
  }

  function listEvents(runId, options = {}) {
    requireRun(runId);
    const candidate = assertPlainObject(options, "事件列表参数");
    assertOnlyKeys(candidate, ["afterSeq", "limit"], "事件列表参数");
    const afterSeq = candidate.afterSeq ?? 0;
    const limit = candidate.limit ?? 500;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new AiRunMetadataValidationError("afterSeq 必须是非负整数");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new AiRunMetadataValidationError("事件 limit 必须是 1 到 1000 的整数");
    }
    return statements.listEvents.all(runId, afterSeq, limit).map(eventRowToPublic);
  }

  const createPermissionTransaction = db.transaction((normalized) => {
    const run = requireRun(normalized.runId);
    if (run.status !== "running") {
      throw new AiRunMetadataStateError(`只有 running 任务可以请求权限，当前为 ${run.status}`);
    }
    const createdAt = timestamp();
    statements.insertPermission.run(
      normalized.permissionId,
      normalized.runId,
      normalized.toolCallId,
      normalized.title,
      normalized.kind,
      normalized.request.serialized,
      createdAt,
    );
    statements.updateRun.run(
      "waiting_permission",
      run.title,
      JSON.stringify(run.metadata),
      run.errorSummary,
      createdAt,
      run.startedAt,
      run.completedAt,
      run.runId,
    );
    return permissionRowToPublic(statements.permissionById.get(normalized.permissionId));
  });

  function createPermission(input) {
    ensureOpen();
    const candidate = assertPlainObject(input, "权限请求参数");
    assertOnlyKeys(candidate, ["permissionId", "runId", "toolCallId", "title", "kind", "request"], "权限请求参数");
    const normalized = {
      permissionId: assertPermissionId(candidate.permissionId ?? permissionIdFactory()),
      runId: assertRunId(candidate.runId),
      toolCallId: redactPersistedString(assertText(candidate.toolCallId, "toolCallId", { min: 1, max: MAX_TOOL_CALL_ID_LENGTH, multiline: false })),
      title: redactPersistedString(assertText(candidate.title, "权限标题", { min: 1, max: MAX_TITLE_LENGTH })),
      kind: candidate.kind === undefined || candidate.kind === null
        ? null
        : redactPersistedString(assertText(candidate.kind, "权限 kind", { max: MAX_PERMISSION_KIND_LENGTH, multiline: false })),
      request: encodeRedactedJsonObject(candidate.request, "权限 request", MAX_PERMISSION_JSON_BYTES),
    };
    return createPermissionTransaction.immediate(normalized);
  }

  const resolvePermissionTransaction = db.transaction((permissionId, resolution) => {
    const existingRow = statements.permissionById.get(permissionId);
    if (!existingRow) throw new AiRunMetadataNotFoundError("权限请求", permissionId);
    if (existingRow.status !== "pending") throw new AiRunPermissionResolvedError(permissionId);
    const resolvedAt = timestamp();
    const nextStatus = resolution.decision === "allow_once" ? "allowed" : "rejected";
    const result = statements.resolvePermission.run(
      nextStatus,
      resolution.decision,
      resolution.details.serialized,
      resolvedAt,
      permissionId,
    );
    if (result.changes !== 1) throw new AiRunPermissionResolvedError(permissionId);
    const run = requireRun(existingRow.run_id);
    if (run.status === "waiting_permission"
      && statements.pendingPermissionCount.get(run.runId).count === 0) {
      statements.updateRun.run(
        "running",
        run.title,
        JSON.stringify(run.metadata),
        run.errorSummary,
        resolvedAt,
        run.startedAt ?? resolvedAt,
        null,
        run.runId,
      );
    }
    return permissionRowToPublic(statements.permissionById.get(permissionId));
  });

  function resolvePermission(permissionId, input) {
    ensureOpen();
    assertPermissionId(permissionId);
    const candidate = assertPlainObject(input, "权限解决参数");
    assertOnlyKeys(candidate, ["decision", "details"], "权限解决参数");
    if (!PERMISSION_DECISIONS.includes(candidate.decision)) {
      throw new AiRunMetadataValidationError(`decision 只能是：${PERMISSION_DECISIONS.join("、")}`);
    }
    const details = encodeRedactedJsonObject(candidate.details, "权限 resolution", MAX_PERMISSION_JSON_BYTES);
    return resolvePermissionTransaction.immediate(permissionId, { decision: candidate.decision, details });
  }

  const recordImportTransaction = db.transaction((normalized) => {
    requireRun(normalized.runId);
    const createdAt = timestamp();
    statements.insertImport.run(
      normalized.importId,
      normalized.runId,
      normalized.targetRef,
      normalized.status,
      normalized.sha256,
      normalized.details.serialized,
      createdAt,
    );
    return importRowToPublic(statements.importById.get(normalized.importId));
  });

  function recordImport(input) {
    ensureOpen();
    const candidate = assertPlainObject(input, "导入记录参数");
    assertOnlyKeys(candidate, ["importId", "runId", "targetRef", "status", "sha256", "details"], "导入记录参数");
    const status = candidate.status ?? "confirmed";
    if (!IMPORT_STATUSES.includes(status)) throw new AiRunMetadataValidationError("导入 status 无效");
    const sha256 = candidate.sha256 ?? null;
    if (sha256 !== null && (typeof sha256 !== "string" || !SHA256_RE.test(sha256))) {
      throw new AiRunMetadataValidationError("导入 sha256 无效");
    }
    const normalized = {
      importId: assertImportId(candidate.importId ?? importIdFactory()),
      runId: assertRunId(candidate.runId),
      targetRef: redactPersistedString(assertText(candidate.targetRef, "targetRef", { min: 1, max: MAX_TARGET_REF_LENGTH })),
      status,
      sha256,
      details: encodeRedactedJsonObject(candidate.details, "导入 details", MAX_IMPORT_JSON_BYTES),
    };
    return recordImportTransaction.immediate(normalized);
  }

  function close() {
    if (closed) return;
    if (db.open) {
      try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
      db.close();
    }
    closed = true;
  }

  return {
    stateRoot,
    dbPath,
    createRun,
    getRun,
    listRuns,
    updateRun,
    appendEvent,
    listEvents,
    createPermission,
    resolvePermission,
    recordImport,
    close,
  };
}
