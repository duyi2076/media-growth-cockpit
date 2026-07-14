import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createSafeStatePaths } from "../lib/safe-state-paths.mjs";
import { runWithSharedWriteQueue } from "../lib/shared-write-queue.mjs";
import {
  AI_RUN_PERMISSION_MODES,
  AI_RUN_PROVIDERS,
  AI_RUN_TEMPLATE_IDS,
} from "./run-workspace-store.mjs";

export const AI_CONVERSATION_STATUSES = Object.freeze(["open", "closed"]);
export const AI_CONVERSATION_TEMPLATE_IDS = Object.freeze(["collaborate", ...AI_RUN_TEMPLATE_IDS]);
export const AI_CONVERSATION_TURN_STATUSES = Object.freeze([
  "queued", "running", "waiting_permission", "completed", "failed", "cancelled",
]);

const CONVERSATION_ID_RE = /^conv-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TURN_ID_RE = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PERMISSION_ID_RE = /^perm-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_SOURCE_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_CONVERSATIONS = 1_000;
const MAX_TURNS = 1_000;
const MAX_TEXT_CHARS = 200_000;
const MAX_ASSISTANT_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SESSION_BYTES = 256 * 1024;
const MAX_TURN_BYTES = MAX_ASSISTANT_BYTES + 256 * 1024;
const MAX_EVENTS_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_SOURCE_REFS = 25;
const MAX_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 20 * 1024 * 1024;

export class AiConversationValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "AiConversationValidationError";
  }
}
export class AiConversationSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiConversationSecurityError";
  }
}
export class AiConversationNotFoundError extends Error {
  constructor(message = "AI 会话不存在") {
    super(message);
    this.name = "AiConversationNotFoundError";
  }
}
export class AiConversationConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiConversationConflictError";
  }
}
export class AiConversationLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiConversationLimitError";
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new AiConversationValidationError(`${label}必须是普通对象`);
  return value;
}

function assertOnlyKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AiConversationValidationError(`${label}包含未知字段：${unknown.join("、")}`);
}

function assertText(value, label, { min = 0, max = MAX_TEXT_CHARS, multiline = true } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new AiConversationValidationError(`${label}长度无效`);
  }
  if (value.includes("\0") || /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    throw new AiConversationValidationError(`${label}包含控制字符`);
  }
  if (!multiline && /[\r\n]/.test(value)) throw new AiConversationValidationError(`${label}不能换行`);
  return value;
}

function assertIso(value, label) {
  assertText(value, label, { min: 20, max: 40, multiline: false });
  if (new Date(value).toISOString() !== value) throw new AiConversationValidationError(`${label}必须是 ISO 时间`);
  return value;
}

function assertId(value, regex, label) {
  assertText(value, label, { min: 1, max: 140, multiline: false });
  if (String(value).split(/[\\/]+/).includes("..") || !regex.test(value)) {
    throw new AiConversationValidationError(`${label}格式无效`);
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeContext(value) {
  if (value === null || value === undefined) return null;
  const context = assertPlainObject(value, "context");
  assertOnlyKeys(context, ["type", "id", "title", "summary"], "context");
  return {
    type: assertText(context.type, "context.type", { min: 1, max: 80, multiline: false }),
    id: assertText(context.id, "context.id", { min: 1, max: 300, multiline: false }),
    title: assertText(context.title, "context.title", { min: 1, max: 500, multiline: false }),
    ...(context.summary === undefined ? {} : {
      summary: assertText(context.summary, "context.summary", { max: 4_000 }),
    }),
  };
}

function normalizeSourceTask(value) {
  if (value === null || value === undefined) return null;
  const task = assertPlainObject(value, "sourceTask");
  const id = assertText(task.id, "sourceTask.id", { min: 1, max: 80, multiline: false });
  if (!SAFE_SOURCE_TASK_ID_RE.test(id)) throw new AiConversationValidationError("sourceTask.id 无效");
  const result = {
    id,
    date: assertText(task.date, "sourceTask.date", { min: 10, max: 10, multiline: false }),
    title: assertText(task.title, "sourceTask.title", { min: 1, max: 300, multiline: false }),
    linkType: assertText(task.linkType, "sourceTask.linkType", { min: 1, max: 40, multiline: false }),
    linkId: assertText(task.linkId, "sourceTask.linkId", { min: 1, max: 160, multiline: false }),
  };
  for (const key of ["fingerprint", "assetSha256"]) {
    if (task[key] !== undefined) {
      if (!SHA256_RE.test(task[key])) throw new AiConversationValidationError(`sourceTask.${key} 无效`);
      result[key] = task[key];
    }
  }
  return result;
}

function normalizeSourceRefs(value) {
  const refs = value ?? [];
  if (!Array.isArray(refs) || refs.length > MAX_SOURCE_REFS) throw new AiConversationValidationError("sourceRefs 无效");
  const names = new Set();
  return refs.map((entry, index) => {
    const ref = assertPlainObject(entry, `sourceRefs[${index}]`);
    const sourcePath = assertText(ref.sourcePath, `sourceRefs[${index}].sourcePath`, { min: 1, max: 4_096, multiline: false });
    if (!path.isAbsolute(sourcePath) || sourcePath.split(/[\\/]+/).includes("..")) throw new AiConversationSecurityError("sourcePath 必须是无越界段的绝对路径");
    const inputName = assertText(ref.inputName, `sourceRefs[${index}].inputName`, { min: 1, max: 120, multiline: false });
    if (inputName === "." || inputName === ".." || inputName.includes("/") || inputName.includes("\\")) throw new AiConversationSecurityError("inputName 必须是单一文件名");
    if (names.has(inputName)) throw new AiConversationValidationError("sourceRefs.inputName 不能重复");
    names.add(inputName);
    if (!SHA256_RE.test(ref.expectedSha256)) throw new AiConversationValidationError("sourceRefs.expectedSha256 无效");
    return {
      ref: assertText(ref.ref, `sourceRefs[${index}].ref`, { min: 1, max: 1_000, multiline: false }),
      sourcePath: path.resolve(sourcePath), inputName, expectedSha256: ref.expectedSha256,
    };
  });
}

function validateStoredSourceRefs(value) {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_REFS) {
    throw new AiConversationValidationError("manifest.sourceRefs 无效");
  }
  const names = new Set();
  return value.map((entry, index) => {
    const ref = assertPlainObject(entry, `manifest.sourceRefs[${index}]`);
    assertOnlyKeys(ref, ["ref", "inputName", "relativePath", "sha256", "size"], `manifest.sourceRefs[${index}]`);
    const inputName = assertText(ref.inputName, `manifest.sourceRefs[${index}].inputName`, {
      min: 1, max: 120, multiline: false,
    });
    if (inputName === "." || inputName === ".." || inputName.includes("/") || inputName.includes("\\")) {
      throw new AiConversationSecurityError("manifest.sourceRefs.inputName 必须是单一文件名");
    }
    if (names.has(inputName)) throw new AiConversationValidationError("manifest.sourceRefs.inputName 不能重复");
    names.add(inputName);
    if (ref.relativePath !== `workspace/inputs/${inputName}`) {
      throw new AiConversationSecurityError("manifest.sourceRefs.relativePath 无效");
    }
    if (!SHA256_RE.test(ref.sha256)) throw new AiConversationValidationError("manifest.sourceRefs.sha256 无效");
    if (!Number.isSafeInteger(ref.size) || ref.size < 0 || ref.size > MAX_SOURCE_FILE_BYTES) {
      throw new AiConversationValidationError("manifest.sourceRefs.size 无效");
    }
    return {
      ref: assertText(ref.ref, `manifest.sourceRefs[${index}].ref`, { min: 1, max: 1_000, multiline: false }),
      inputName,
      relativePath: ref.relativePath,
      sha256: ref.sha256,
      size: ref.size,
    };
  });
}

function normalizeRuntime(value) {
  if (value === null || value === undefined) return null;
  const runtime = assertPlainObject(value, "runtime");
  const result = {};
  for (const key of ["providerVersion", "adapterPackage", "adapterVersion", "protocolVersion", "versionStatus"]) {
    if (runtime[key] !== undefined) result[key] = runtime[key];
  }
  return result;
}

function normalizeCreate(value) {
  const input = assertPlainObject(value, "创建参数");
  assertOnlyKeys(input, [
    "provider", "templateId", "context", "sourceTask", "sourceRefs", "permissionMode", "runtime", "message", "clientRequestId",
    "createRequestSha256",
  ], "创建参数");
  if (!AI_RUN_PROVIDERS.includes(input.provider)) throw new AiConversationValidationError("provider 无效");
  const templateId = input.templateId ?? "collaborate";
  if (!AI_CONVERSATION_TEMPLATE_IDS.includes(templateId)) throw new AiConversationValidationError("templateId 无效");
  if (!AI_RUN_PERMISSION_MODES.includes(input.permissionMode)) throw new AiConversationValidationError("permissionMode 无效");
  const clientRequestId = input.clientRequestId ?? `create-${crypto.randomUUID()}`;
  assertId(clientRequestId, CLIENT_REQUEST_ID_RE, "clientRequestId");
  const normalized = {
    provider: input.provider,
    templateId,
    context: normalizeContext(input.context),
    sourceTask: normalizeSourceTask(input.sourceTask),
    sourceRefs: normalizeSourceRefs(input.sourceRefs),
    permissionMode: input.permissionMode,
    runtime: normalizeRuntime(input.runtime),
    message: assertText(input.message, "message", { min: 1, max: 20_000 }),
    clientRequestId,
  };
  const fallbackFingerprint = sha256(JSON.stringify({
    provider: normalized.provider,
    templateId: normalized.templateId,
    context: normalized.context,
    sourceTask: normalized.sourceTask,
    sourceRefs: normalized.sourceRefs.map(({ ref, inputName, expectedSha256 }) => ({ ref, inputName, expectedSha256 })),
    permissionMode: normalized.permissionMode,
    message: normalized.message,
  }));
  const createRequestSha256 = input.createRequestSha256 ?? fallbackFingerprint;
  if (!SHA256_RE.test(createRequestSha256)) throw new AiConversationValidationError("createRequestSha256 无效");
  return { ...normalized, createRequestSha256 };
}

function validateError(value) {
  if (value === null) return null;
  const error = assertPlainObject(value, "turn.error");
  return {
    code: assertText(error.code, "turn.error.code", { min: 1, max: 200, multiline: false }),
    message: assertText(error.message, "turn.error.message", { min: 1, max: 4_000 }),
    at: assertIso(error.at, "turn.error.at"),
  };
}

function validateTurn(value, expectedId) {
  const turn = assertPlainObject(value, "turn");
  assertId(turn.id, TURN_ID_RE, "turn.id");
  if (turn.id !== expectedId) throw new AiConversationSecurityError("turn.id 与文件名不一致");
  if (!Number.isSafeInteger(turn.seq) || turn.seq < 1 || turn.seq > MAX_TURNS) throw new AiConversationValidationError("turn.seq 无效");
  assertId(turn.clientRequestId, CLIENT_REQUEST_ID_RE, "turn.clientRequestId");
  if (!AI_CONVERSATION_TURN_STATUSES.includes(turn.status)) throw new AiConversationValidationError("turn.status 无效");
  const assistantText = assertText(turn.assistantText ?? "", "turn.assistantText", { max: MAX_TEXT_CHARS });
  if (Buffer.byteLength(assistantText, "utf8") > MAX_ASSISTANT_BYTES) throw new AiConversationLimitError("AI 输出超过 2MiB");
  const outputSha256 = turn.outputSha256;
  if (outputSha256 !== null && !SHA256_RE.test(outputSha256)) throw new AiConversationValidationError("turn.outputSha256 无效");
  if (turn.status === "completed" && outputSha256 !== sha256(assistantText)) {
    throw new AiConversationValidationError("turn.outputSha256 与正文不一致");
  }
  return {
    id: turn.id,
    seq: turn.seq,
    clientRequestId: turn.clientRequestId,
    userText: assertText(turn.userText, "turn.userText", { min: 1, max: 20_000 }),
    status: turn.status,
    assistantText,
    outputSha256,
    stopReason: turn.stopReason === null ? null : assertText(turn.stopReason, "turn.stopReason", { min: 1, max: 100, multiline: false }),
    error: validateError(turn.error),
    eventCount: (() => {
      if (!Number.isSafeInteger(turn.eventCount) || turn.eventCount < 0 || turn.eventCount > 100_000) {
        throw new AiConversationValidationError("turn.eventCount 无效");
      }
      return turn.eventCount;
    })(),
    eventBytes: (() => {
      if (!Number.isSafeInteger(turn.eventBytes) || turn.eventBytes < 0 || turn.eventBytes > MAX_EVENTS_BYTES) {
        throw new AiConversationValidationError("turn.eventBytes 无效");
      }
      return turn.eventBytes;
    })(),
    createdAt: assertIso(turn.createdAt, "turn.createdAt"),
    startedAt: turn.startedAt === null ? null : assertIso(turn.startedAt, "turn.startedAt"),
    completedAt: turn.completedAt === null ? null : assertIso(turn.completedAt, "turn.completedAt"),
  };
}

function validatePermission(value, activeTurnId) {
  if (value === null) return null;
  const permission = assertPlainObject(value, "pendingPermission");
  assertId(permission.id, PERMISSION_ID_RE, "pendingPermission.id");
  assertId(permission.turnId, TURN_ID_RE, "pendingPermission.turnId");
  if (permission.turnId !== activeTurnId) throw new AiConversationValidationError("权限请求未绑定当前 turn");
  if (!Array.isArray(permission.options) || !permission.options.length || permission.options.length > 10) {
    throw new AiConversationValidationError("权限选项无效");
  }
  return {
    id: permission.id,
    turnId: permission.turnId,
    toolCallId: assertText(permission.toolCallId, "pendingPermission.toolCallId", { min: 1, max: 200, multiline: false }),
    title: assertText(permission.title, "pendingPermission.title", { min: 1, max: 500, multiline: false }),
    kind: permission.kind ?? null,
    scope: (() => {
      const scope = permission.scope ?? [];
      if (!Array.isArray(scope) || scope.length > 10) throw new AiConversationValidationError("权限范围无效");
      return scope.map((item) => assertText(item, "permission.scope", { min: 1, max: 500, multiline: false }));
    })(),
    options: permission.options.map((option) => ({
      optionId: assertText(option.optionId, "permission.optionId", { min: 1, max: 200, multiline: false }),
      name: assertText(option.name, "permission.name", { min: 1, max: 200, multiline: false }),
      kind: option.kind,
    })),
    createdAt: assertIso(permission.createdAt, "pendingPermission.createdAt"),
    expiresAt: assertIso(permission.expiresAt, "pendingPermission.expiresAt"),
  };
}

function validateManifest(value, expectedId, expectedCwd) {
  const manifest = assertPlainObject(value, "manifest");
  if (manifest.schemaVersion !== 1) throw new AiConversationValidationError("manifest.schemaVersion 无效");
  assertId(manifest.id, CONVERSATION_ID_RE, "manifest.id");
  if (manifest.id !== expectedId) throw new AiConversationSecurityError("manifest.id 与目录不一致");
  if (manifest.cwd !== expectedCwd) throw new AiConversationSecurityError("manifest.cwd 与固定目录不一致");
  if (!AI_RUN_PROVIDERS.includes(manifest.provider)) throw new AiConversationValidationError("manifest.provider 无效");
  if (!AI_CONVERSATION_TEMPLATE_IDS.includes(manifest.templateId)) throw new AiConversationValidationError("manifest.templateId 无效");
  if (!AI_RUN_PERMISSION_MODES.includes(manifest.permissionMode)) throw new AiConversationValidationError("manifest.permissionMode 无效");
  if (!AI_CONVERSATION_STATUSES.includes(manifest.status)) throw new AiConversationValidationError("manifest.status 无效");
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1) throw new AiConversationValidationError("manifest.revision 无效");
  if (!Array.isArray(manifest.turnIds) || manifest.turnIds.length > MAX_TURNS) throw new AiConversationValidationError("manifest.turnIds 无效");
  for (const turnId of manifest.turnIds) assertId(turnId, TURN_ID_RE, "turnId");
  if (new Set(manifest.turnIds).size !== manifest.turnIds.length) throw new AiConversationValidationError("turnId 重复");
  if (!Number.isSafeInteger(manifest.nextTurnSeq) || manifest.nextTurnSeq !== manifest.turnIds.length + 1) {
    throw new AiConversationValidationError("manifest.nextTurnSeq 无效");
  }
  const activeTurnId = manifest.activeTurnId;
  if (activeTurnId !== null) {
    assertId(activeTurnId, TURN_ID_RE, "activeTurnId");
    if (!manifest.turnIds.includes(activeTurnId)) throw new AiConversationValidationError("activeTurnId 不属于当前会话");
  }
  const acceptedTurnId = manifest.acceptedTurnId;
  if (acceptedTurnId !== null) {
    assertId(acceptedTurnId, TURN_ID_RE, "acceptedTurnId");
    if (!manifest.turnIds.includes(acceptedTurnId)) throw new AiConversationValidationError("acceptedTurnId 不属于当前会话");
  }
  const acceptedAt = manifest.acceptedAt === null ? null : assertIso(manifest.acceptedAt, "acceptedAt");
  if ((acceptedTurnId === null) !== (acceptedAt === null)) throw new AiConversationValidationError("acceptedAt 与 acceptedTurnId 不一致");
  const pendingPermission = validatePermission(manifest.pendingPermission, activeTurnId);
  if ((pendingPermission !== null) !== (activeTurnId !== null)) {
    if (pendingPermission !== null) throw new AiConversationValidationError("权限请求没有活动 turn");
  }
  const clientRequests = assertPlainObject(manifest.clientRequests, "clientRequests");
  if (Object.keys(clientRequests).length > MAX_TURNS) throw new AiConversationLimitError("幂等键超过安全上限");
  const validatedClientRequests = {};
  const mappedTurnIds = new Set();
  for (const [clientRequestId, rawRequest] of Object.entries(clientRequests)) {
    assertId(clientRequestId, CLIENT_REQUEST_ID_RE, "clientRequests key");
    const request = assertPlainObject(rawRequest, `clientRequests.${clientRequestId}`);
    assertOnlyKeys(
      request,
      ["turnId", "messageSha256", "createRequestSha256"],
      `clientRequests.${clientRequestId}`,
    );
    const turnId = assertId(request.turnId, TURN_ID_RE, `clientRequests.${clientRequestId}.turnId`);
    if (!manifest.turnIds.includes(turnId)) {
      throw new AiConversationValidationError(`clientRequests.${clientRequestId}.turnId 不属于当前会话`);
    }
    if (mappedTurnIds.has(turnId)) throw new AiConversationValidationError("同一 turn 不能绑定多个幂等键");
    mappedTurnIds.add(turnId);
    if (!SHA256_RE.test(request.messageSha256)) {
      throw new AiConversationValidationError(`clientRequests.${clientRequestId}.messageSha256 无效`);
    }
    if (request.createRequestSha256 !== undefined) {
      if (turnId !== manifest.turnIds[0] || !SHA256_RE.test(request.createRequestSha256)) {
        throw new AiConversationValidationError(`clientRequests.${clientRequestId}.createRequestSha256 无效`);
      }
    }
    validatedClientRequests[clientRequestId] = {
      turnId,
      messageSha256: request.messageSha256,
      ...(request.createRequestSha256 === undefined ? {} : { createRequestSha256: request.createRequestSha256 }),
    };
  }
  if (mappedTurnIds.size !== manifest.turnIds.length) {
    throw new AiConversationValidationError("每个 turn 必须且只能绑定一个幂等键");
  }
  return {
    ...manifest,
    context: normalizeContext(manifest.context),
    sourceTask: normalizeSourceTask(manifest.sourceTask),
    runtime: normalizeRuntime(manifest.runtime),
    sourceRefs: validateStoredSourceRefs(manifest.sourceRefs ?? []),
    clientRequests: validatedClientRequests,
    pendingPermission,
    acceptedAt,
    createdAt: assertIso(manifest.createdAt, "manifest.createdAt"),
    updatedAt: assertIso(manifest.updatedAt, "manifest.updatedAt"),
  };
}

function validateSession(value, expectedId) {
  if (value === null) return null;
  const session = assertPlainObject(value, "session");
  if (session.schemaVersion !== 1 || session.conversationId !== expectedId) {
    throw new AiConversationSecurityError("session 与 conversation 不一致");
  }
  return session;
}

async function lstatOrNull(filePath) {
  try { return await fs.lstat(filePath); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function atomicWriteJson(safeState, filePath, value, maxBytes) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > maxBytes) throw new AiConversationLimitError("会话状态超过安全上限");
  const directory = path.dirname(filePath);
  await safeState.ensureDirectory(directory);
  const current = await lstatOrNull(filePath);
  if (current && (!current.isFile() || current.isSymbolicLink())) throw new AiConversationSecurityError("状态文件不能是软链接或非普通文件");
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(tempPath, flags, 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    const beforeRename = await lstatOrNull(filePath);
    if (beforeRename && (!beforeRename.isFile() || beforeRename.isSymbolicLink())) {
      throw new AiConversationSecurityError("状态文件在写入期间被替换");
    }
    await fs.rename(tempPath, filePath);
    const final = await fs.lstat(filePath);
    if (!final.isFile() || final.isSymbolicLink()) throw new AiConversationSecurityError("状态文件写入结果无效");
    const dirHandle = await fs.open(directory, "r");
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

function parseJson(contents, label) {
  try { return JSON.parse(contents); } catch (error) { throw new AiConversationValidationError(`${label}无法解析`, error); }
}

export function createAiConversationWorkspaceStore(options = {}) {
  const stateRoot = path.resolve(options.stateRoot);
  const now = options.now ?? (() => new Date());
  const conversationsRoot = path.join(stateRoot, "ai-conversations");
  const safeState = createSafeStatePaths({
    stateRoot,
    label: "AI 会话状态",
    createSecurityError: (message) => new AiConversationSecurityError(message),
  });

  const pathsFor = (conversationId) => {
    assertId(conversationId, CONVERSATION_ID_RE, "conversationId");
    const root = path.join(conversationsRoot, conversationId);
    const workspace = path.join(root, "workspace");
    return {
      root,
      workspace,
      manifest: path.join(root, "manifest.json"),
      session: path.join(root, "session.json"),
      inputs: path.join(workspace, "inputs"),
      turns: path.join(root, "turns"),
      events: path.join(root, "events"),
    };
  };
  const turnPath = (paths, turnId) => path.join(paths.turns, `${assertId(turnId, TURN_ID_RE, "turnId")}.json`);
  const eventPath = (paths, turnId) => path.join(paths.events, `${assertId(turnId, TURN_ID_RE, "turnId")}.jsonl`);
  const timestamp = () => {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new AiConversationValidationError("now 必须返回有效 Date");
    return value.toISOString();
  };

  async function readManifest(conversationId) {
    const paths = pathsFor(conversationId);
    const contents = await safeState.readFile(paths.manifest, { maxBytes: MAX_MANIFEST_BYTES, missing: null });
    if (contents === null) throw new AiConversationNotFoundError();
    return validateManifest(parseJson(contents, "manifest"), conversationId, paths.workspace);
  }

  async function readTurn(conversationId, turnId) {
    const paths = pathsFor(conversationId);
    const contents = await safeState.readFile(turnPath(paths, turnId), { maxBytes: MAX_TURN_BYTES, missing: null });
    if (contents === null) throw new AiConversationNotFoundError("AI turn 不存在");
    return validateTurn(parseJson(contents, "turn"), turnId);
  }

  async function readEvents(conversationId, turnId) {
    const paths = pathsFor(conversationId);
    const contents = await safeState.readFile(eventPath(paths, turnId), { maxBytes: MAX_EVENTS_BYTES, missing: "" });
    if (!contents) return [];
    return contents.trimEnd().split("\n").map((line, index) => {
      const event = parseJson(line, `event ${index + 1}`);
      if (!Number.isSafeInteger(event.seq) || event.seq !== index + 1) throw new AiConversationValidationError("event.seq 不连续");
      if (event.id !== `event-${turnId}-${event.seq}`) throw new AiConversationValidationError("event.id 与 turn/seq 不一致");
      return event;
    });
  }

  async function hydrate(manifest) {
    const turns = [];
    for (const turnId of manifest.turnIds) {
      const turn = await readTurn(manifest.id, turnId);
      const request = manifest.clientRequests[turn.clientRequestId];
      if (
        !request
        || request.turnId !== turn.id
        || request.messageSha256 !== sha256(turn.userText)
      ) {
        throw new AiConversationValidationError("turn 与 manifest.clientRequests 不一致");
      }
      const events = await readEvents(manifest.id, turnId);
      if (events.length !== turn.eventCount) throw new AiConversationValidationError("turn.eventCount 与事件文件不一致");
      turns.push({ ...turn, events });
    }
    return { ...manifest, turns };
  }

  async function verifyInputsUnlocked(manifest, paths) {
    const workspaceStat = await lstatOrNull(paths.workspace);
    if (!workspaceStat?.isDirectory() || workspaceStat.isSymbolicLink()) {
      throw new AiConversationSecurityError("会话 workspace 不存在、不是目录或为软链接");
    }
    const expectedWorkspaceReal = path.join(await fs.realpath(paths.root), "workspace");
    if (await fs.realpath(paths.workspace) !== expectedWorkspaceReal) {
      throw new AiConversationSecurityError("会话 workspace 路径发生跳转");
    }
    if (!manifest.sourceRefs.length) return true;

    const inputsStat = await lstatOrNull(paths.inputs);
    if (!inputsStat?.isDirectory() || inputsStat.isSymbolicLink()) {
      throw new AiConversationSecurityError("会话 inputs 快照不存在、不是目录或为软链接");
    }
    const expectedNames = new Set(manifest.sourceRefs.map((source) => source.inputName));
    const entries = await fs.readdir(paths.inputs, { withFileTypes: true });
    if (
      entries.length !== expectedNames.size
      || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink() || !expectedNames.has(entry.name))
    ) {
      throw new AiConversationSecurityError("会话 inputs 快照文件集合已经漂移");
    }
    for (const source of manifest.sourceRefs) {
      const contents = await safeState.readFile(path.join(paths.inputs, source.inputName), {
        maxBytes: MAX_SOURCE_FILE_BYTES,
        missing: null,
      });
      if (contents === null) throw new AiConversationSecurityError("会话 inputs 快照缺失");
      const buffer = Buffer.from(contents, "utf8");
      const currentHash = crypto.createHash("sha256").update(buffer).digest("hex");
      if (buffer.byteLength !== source.size || currentHash !== source.sha256) {
        throw new AiConversationConflictError("会话 inputs 快照已经变化，请关闭后新建会话");
      }
    }
    return true;
  }

  async function prepareSourceRefs(refs) {
    const prepared = [];
    let totalBytes = 0;
    for (const ref of refs) {
      const before = await lstatOrNull(ref.sourcePath);
      if (!before?.isFile() || before.isSymbolicLink() || before.size > MAX_SOURCE_FILE_BYTES) {
        throw new AiConversationSecurityError("权威上下文源文件不存在、不是普通文件或超过 5MiB");
      }
      const real = await fs.realpath(ref.sourcePath);
      if (real !== ref.sourcePath) throw new AiConversationSecurityError("权威上下文源文件路径包含软链接");
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      const handle = await fs.open(ref.sourcePath, flags);
      let buffer;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > MAX_SOURCE_FILE_BYTES) throw new AiConversationSecurityError("权威上下文源文件无效");
        buffer = await handle.readFile();
        const after = await fs.lstat(ref.sourcePath);
        if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
          throw new AiConversationSecurityError("权威上下文源文件在复制期间被替换");
        }
      } finally { await handle.close(); }
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_SOURCE_TOTAL_BYTES) throw new AiConversationLimitError("权威上下文总大小超过 20MiB");
      const currentHash = crypto.createHash("sha256").update(buffer).digest("hex");
      if (currentHash !== ref.expectedSha256) throw new AiConversationConflictError("权威上下文原文已经变化，请刷新后重试");
      const text = buffer.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(buffer)) throw new AiConversationSecurityError("权威上下文不是有效 UTF-8 文本");
      prepared.push({ ...ref, text, sha256: currentHash, bytes: buffer.byteLength });
    }
    return prepared;
  }

  async function findConversationByClientRequest(value) {
    const input = assertPlainObject(value, "创建幂等查询");
    assertOnlyKeys(input, ["clientRequestId", "message", "createRequestSha256"], "创建幂等查询");
    const clientRequestId = assertId(input.clientRequestId, CLIENT_REQUEST_ID_RE, "clientRequestId");
    const message = assertText(input.message, "message", { min: 1, max: 20_000 });
    if (!SHA256_RE.test(input.createRequestSha256)) {
      throw new AiConversationValidationError("createRequestSha256 无效");
    }
    await safeState.ensureDirectory(conversationsRoot);
    const entries = await fs.readdir(conversationsRoot, { withFileTypes: true });
    let matched = null;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !CONVERSATION_ID_RE.test(entry.name)) continue;
      let manifest;
      try { manifest = await readManifest(entry.name); }
      catch { continue; }
      const request = manifest.clientRequests[clientRequestId];
      if (!request || request.turnId !== manifest.turnIds[0]) continue;
      if (request.messageSha256 !== sha256(message)) {
        throw new AiConversationConflictError("clientRequestId 已用于其他创建请求");
      }
      if (request.createRequestSha256 === undefined) {
        throw new AiConversationConflictError("clientRequestId 已存在于旧会话，无法安全重放");
      }
      if (request.createRequestSha256 !== input.createRequestSha256) {
        throw new AiConversationConflictError("clientRequestId 已用于其他创建请求");
      }
      if (matched) throw new AiConversationConflictError("clientRequestId 对应多个历史会话，拒绝重放");
      matched = await hydrate(manifest);
    }
    return matched;
  }

  async function create(value) {
    const input = normalizeCreate(value);
    return runWithSharedWriteQueue(path.join(stateRoot, ".conversation-create-store"), async () => {
      const existing = await findConversationByClientRequest({
        clientRequestId: input.clientRequestId,
        message: input.message,
        createRequestSha256: input.createRequestSha256,
      });
      if (existing) return existing;
      const preparedSources = await prepareSourceRefs(input.sourceRefs);
      await safeState.ensureDirectory(conversationsRoot);
      const entries = await fs.readdir(conversationsRoot, { withFileTypes: true });
      const conversationCount = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && CONVERSATION_ID_RE.test(entry.name)).length;
      if (conversationCount >= MAX_CONVERSATIONS) throw new AiConversationLimitError("会话数量超过安全上限");
      const id = `conv-${crypto.randomUUID()}`;
      const turnId = `turn-${crypto.randomUUID()}`;
      const paths = pathsFor(id);
      const at = timestamp();
      const messageHash = sha256(input.message);
      const turn = {
        id: turnId, seq: 1, clientRequestId: input.clientRequestId, userText: input.message,
        status: "queued", assistantText: "", outputSha256: null, stopReason: null, error: null,
        eventCount: 0, eventBytes: 0,
        createdAt: at, startedAt: null, completedAt: null,
      };
      const manifest = {
        schemaVersion: 1, id, provider: input.provider, status: "open", templateId: input.templateId,
        context: input.context, sourceTask: input.sourceTask, permissionMode: input.permissionMode,
        runtime: input.runtime, revision: 1, activeTurnId: turnId, acceptedTurnId: null,
        acceptedOutputSha256: null, acceptedAt: null, importedAt: null, importedRelativePath: null,
        importedTurnId: null, importedOutputSha256: null,
        pendingPermission: null, turnIds: [turnId], nextTurnSeq: 2,
        clientRequests: {
          [input.clientRequestId]: {
            turnId,
            messageSha256: messageHash,
            createRequestSha256: input.createRequestSha256,
          },
        },
        sourceRefs: preparedSources.map(({ ref, inputName, sha256: sourceSha256, bytes }) => ({
          ref,
          inputName,
          relativePath: `workspace/inputs/${inputName}`,
          sha256: sourceSha256,
          size: bytes,
        })),
        cwd: paths.workspace, createdAt: at, updatedAt: at,
      };
      return runWithSharedWriteQueue(paths.manifest, async () => {
        if (await lstatOrNull(paths.root)) throw new AiConversationConflictError("会话目录已经存在");
        await safeState.ensureDirectory(paths.workspace);
        await safeState.ensureDirectory(paths.turns);
        await safeState.ensureDirectory(paths.events);
        if (preparedSources.length) {
          await safeState.ensureDirectory(paths.inputs);
          for (const source of preparedSources) {
            await safeState.writeNewFile(path.join(paths.inputs, source.inputName), source.text);
            await fs.chmod(path.join(paths.inputs, source.inputName), 0o400);
          }
          await fs.chmod(paths.inputs, 0o500);
        }
        await safeState.writeNewFile(turnPath(paths, turnId), `${JSON.stringify(turn, null, 2)}\n`);
        await safeState.writeNewFile(eventPath(paths, turnId), "");
        await safeState.writeNewFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
        return hydrate(validateManifest(manifest, id, paths.workspace));
      });
    });
  }

  async function list() {
    await safeState.ensureDirectory(conversationsRoot);
    const entries = await fs.readdir(conversationsRoot, { withFileTypes: true });
    const conversations = [];
    const errors = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !CONVERSATION_ID_RE.test(entry.name)) continue;
      try {
        conversations.push(await repair(entry.name));
      } catch (error) {
        // One corrupt or crash-orphaned historical conversation must not make
        // the whole service unavailable. Keep the directory untouched for
        // diagnosis and expose only a path-free error summary internally.
        errors.push({ conversationId: entry.name, code: error?.name ?? "ConversationReadError" });
      }
    }
    conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { conversations, errors };
  }

  async function get(conversationId) {
    const paths = pathsFor(conversationId);
    return runWithSharedWriteQueue(paths.manifest, async () => hydrate(await readManifest(conversationId)));
  }

  async function verifyInputs(conversationId) {
    const paths = pathsFor(conversationId);
    return runWithSharedWriteQueue(paths.manifest, async () => {
      const manifest = await readManifest(conversationId);
      await verifyInputsUnlocked(manifest, paths);
      return true;
    });
  }

  async function mutate(conversationId, expectedRevision, operation) {
    const paths = pathsFor(conversationId);
    return runWithSharedWriteQueue(paths.manifest, async () => {
      const manifest = await readManifest(conversationId);
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== manifest.revision) {
        throw new AiConversationConflictError("会话版本已变化，请刷新后重试");
      }
      const result = await operation(manifest, paths);
      if (!result?.changed) return result?.value ?? hydrate(manifest);
      result.manifest.revision = manifest.revision + 1;
      result.manifest.updatedAt = timestamp();
      await atomicWriteJson(safeState, paths.manifest, result.manifest, MAX_MANIFEST_BYTES);
      return result.value ?? hydrate(validateManifest(result.manifest, conversationId, paths.workspace));
    });
  }

  async function createTurn(conversationId, { message, clientRequestId, expectedRevision }) {
    const userText = assertText(message, "message", { min: 1, max: 20_000 });
    assertId(clientRequestId, CLIENT_REQUEST_ID_RE, "clientRequestId");
    const messageSha256 = sha256(userText);
    const paths = pathsFor(conversationId);
    return runWithSharedWriteQueue(paths.manifest, async () => {
      const manifest = await readManifest(conversationId);
      const existing = manifest.clientRequests[clientRequestId];
      if (existing) {
        if (existing.messageSha256 !== messageSha256) throw new AiConversationConflictError("clientRequestId 已用于其他消息");
        return { conversation: await hydrate(manifest), turn: await readTurn(conversationId, existing.turnId), created: false };
      }
      if (expectedRevision !== manifest.revision) throw new AiConversationConflictError("会话版本已变化，请刷新后重试");
      if (manifest.status !== "open") throw new AiConversationConflictError("只有 open 会话可以继续提问");
      if (manifest.activeTurnId) throw new AiConversationConflictError("当前会话已有正在执行的 turn");
      if (manifest.turnIds.length >= MAX_TURNS) throw new AiConversationLimitError("会话 turn 数量超过安全上限");
      const turnId = `turn-${crypto.randomUUID()}`;
      const at = timestamp();
      const turn = {
        id: turnId, seq: manifest.nextTurnSeq, clientRequestId, userText,
        status: "queued", assistantText: "", outputSha256: null, stopReason: null, error: null,
        eventCount: 0, eventBytes: 0,
        createdAt: at, startedAt: null, completedAt: null,
      };
      await safeState.writeNewFile(turnPath(paths, turnId), `${JSON.stringify(turn, null, 2)}\n`);
      await safeState.writeNewFile(eventPath(paths, turnId), "");
      manifest.turnIds.push(turnId);
      manifest.nextTurnSeq += 1;
      manifest.activeTurnId = turnId;
      manifest.pendingPermission = null;
      manifest.clientRequests[clientRequestId] = { turnId, messageSha256 };
      manifest.revision += 1;
      manifest.updatedAt = at;
      await atomicWriteJson(safeState, paths.manifest, manifest, MAX_MANIFEST_BYTES);
      return { conversation: await hydrate(manifest), turn, created: true };
    });
  }

  async function findTurnByClientRequest(conversationId, { message, clientRequestId }) {
    const userText = assertText(message, "message", { min: 1, max: 20_000 });
    assertId(clientRequestId, CLIENT_REQUEST_ID_RE, "clientRequestId");
    const paths = pathsFor(conversationId);
    return runWithSharedWriteQueue(paths.manifest, async () => {
      const manifest = await readManifest(conversationId);
      const existing = manifest.clientRequests[clientRequestId];
      if (!existing) return null;
      if (existing.messageSha256 !== sha256(userText)) {
        throw new AiConversationConflictError("clientRequestId 已用于其他消息");
      }
      return {
        conversation: await hydrate(manifest),
        turn: await readTurn(conversationId, existing.turnId),
      };
    });
  }

  async function updateTurn(conversationId, turnId, updater, { clearActive = false } = {}) {
    const paths = pathsFor(conversationId);
    return runWithSharedWriteQueue(paths.manifest, async () => {
      const manifest = await readManifest(conversationId);
      if (!manifest.turnIds.includes(turnId)) throw new AiConversationNotFoundError("AI turn 不存在");
      const current = await readTurn(conversationId, turnId);
      const next = validateTurn(updater({ ...current }), turnId);
      await atomicWriteJson(safeState, turnPath(paths, turnId), next, MAX_TURN_BYTES);
      if (clearActive && manifest.activeTurnId === turnId) {
        manifest.activeTurnId = null;
        manifest.pendingPermission = null;
      }
      manifest.revision += 1;
      manifest.updatedAt = timestamp();
      await atomicWriteJson(safeState, paths.manifest, manifest, MAX_MANIFEST_BYTES);
      return { conversation: await hydrate(manifest), turn: next };
    });
  }

  async function startTurn(conversationId, turnId) {
    return updateTurn(conversationId, turnId, (turn) => {
      if (turn.status !== "queued") throw new AiConversationConflictError("只有 queued turn 可以开始");
      turn.status = "running";
      turn.startedAt = timestamp();
      return turn;
    });
  }

  async function completeTurn(conversationId, turnId, { assistantText, stopReason }) {
    const text = assertText(assistantText ?? "", "assistantText", { max: MAX_TEXT_CHARS });
    if (Buffer.byteLength(text, "utf8") > MAX_ASSISTANT_BYTES) throw new AiConversationLimitError("AI 输出超过 2MiB");
    return updateTurn(conversationId, turnId, (turn) => {
      if (!["running", "waiting_permission"].includes(turn.status)) throw new AiConversationConflictError("turn 不能完成");
      turn.status = "completed";
      turn.assistantText = text;
      turn.outputSha256 = sha256(text);
      turn.stopReason = assertText(stopReason ?? "end_turn", "stopReason", { min: 1, max: 100, multiline: false });
      turn.error = null;
      turn.completedAt = timestamp();
      return turn;
    }, { clearActive: true });
  }

  async function failTurn(conversationId, turnId, error) {
    return updateTurn(conversationId, turnId, (turn) => {
      if (TERMINAL_TURN_STATUSES.has(turn.status)) return turn;
      turn.status = "failed";
      turn.error = {
        code: assertText(error.code ?? "agent_failed", "error.code", { min: 1, max: 200, multiline: false }),
        message: assertText(error.message ?? "Agent 运行失败", "error.message", { min: 1, max: 4_000 }),
        at: timestamp(),
      };
      turn.completedAt = timestamp();
      return turn;
    }, { clearActive: true });
  }

  async function cancelTurn(conversationId, turnId) {
    return updateTurn(conversationId, turnId, (turn) => {
      if (TERMINAL_TURN_STATUSES.has(turn.status)) return turn;
      turn.status = "cancelled";
      turn.error = null;
      turn.stopReason = "cancelled";
      turn.completedAt = timestamp();
      return turn;
    }, { clearActive: true });
  }

  async function appendEvent(conversationId, turnId, value) {
    const paths = pathsFor(conversationId);
    return runWithSharedWriteQueue(paths.manifest, async () => {
      const manifest = await readManifest(conversationId);
      if (!manifest.turnIds.includes(turnId)) throw new AiConversationNotFoundError("AI turn 不存在");
      const turn = await readTurn(conversationId, turnId);
      const seq = turn.eventCount + 1;
      const event = { ...assertPlainObject(value, "event"), id: `event-${turnId}-${seq}`, seq };
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) throw new AiConversationLimitError("单条事件超过 64KiB");
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (turn.eventBytes + lineBytes > MAX_EVENTS_BYTES) throw new AiConversationLimitError("turn 事件超过 4MiB");
      await safeState.appendFile(eventPath(paths, turnId), line);
      turn.eventCount = seq;
      turn.eventBytes += lineBytes;
      await atomicWriteJson(safeState, turnPath(paths, turnId), turn, MAX_TURN_BYTES);
      return event;
    });
  }

  async function setPendingPermission(conversationId, turnId, permission) {
    return mutate(conversationId, null, async (manifest, paths) => {
      if (manifest.activeTurnId !== turnId) throw new AiConversationConflictError("权限请求不属于当前活动 turn");
      const turn = await readTurn(conversationId, turnId);
      if (turn.status !== "running") throw new AiConversationConflictError("只有 running turn 可以等待权限");
      const nextPermission = validatePermission({ ...permission, turnId }, turnId);
      turn.status = "waiting_permission";
      await atomicWriteJson(safeState, turnPath(paths, turnId), turn, MAX_TURN_BYTES);
      manifest.pendingPermission = nextPermission;
      return { changed: true, manifest };
    });
  }

  async function resolvePermission(conversationId, turnId, permissionId, optionId) {
    return mutate(conversationId, null, async (manifest, paths) => {
      const pending = manifest.pendingPermission;
      if (!pending || pending.id !== permissionId || pending.turnId !== turnId) {
        throw new AiConversationConflictError("权限请求已经失效");
      }
      if (!pending.options.some((option) => option.optionId === optionId)) throw new AiConversationValidationError("权限选项无效");
      const turn = await readTurn(conversationId, turnId);
      if (turn.status !== "waiting_permission") throw new AiConversationConflictError("turn 当前不等待权限");
      turn.status = "running";
      await atomicWriteJson(safeState, turnPath(paths, turnId), turn, MAX_TURN_BYTES);
      manifest.pendingPermission = null;
      return { changed: true, manifest };
    });
  }

  async function expirePermission(conversationId, turnId, permissionId) {
    return mutate(conversationId, null, async (manifest, paths) => {
      const pending = manifest.pendingPermission;
      if (!pending) return { changed: false };
      if (pending.id !== permissionId || pending.turnId !== turnId) {
        throw new AiConversationConflictError("权限请求已经失效");
      }
      const turn = await readTurn(conversationId, turnId);
      if (turn.status === "waiting_permission") {
        turn.status = "running";
        await atomicWriteJson(safeState, turnPath(paths, turnId), turn, MAX_TURN_BYTES);
      }
      manifest.pendingPermission = null;
      return { changed: true, manifest };
    });
  }

  async function accept(conversationId, { turnId, outputSha256, expectedRevision }) {
    return mutate(conversationId, expectedRevision, async (manifest) => {
      if (manifest.status !== "open") throw new AiConversationConflictError("该会话不能再确认结果");
      if (manifest.activeTurnId) throw new AiConversationConflictError("当前 turn 尚未结束");
      const turn = await readTurn(conversationId, turnId);
      if (turn.status !== "completed") throw new AiConversationConflictError("只能确认 completed turn");
      if (turn.outputSha256 !== outputSha256 || !SHA256_RE.test(outputSha256)) throw new AiConversationConflictError("结果正文已变化，请刷新后重试");
      if (manifest.acceptedTurnId === turnId && manifest.acceptedOutputSha256 === outputSha256) return { changed: false };
      manifest.acceptedTurnId = turnId;
      manifest.acceptedOutputSha256 = outputSha256;
      manifest.acceptedAt = timestamp();
      return { changed: true, manifest };
    });
  }

  async function recordImport(conversationId, {
    turnId, outputSha256, expectedRevision, relativePath, sha256: importedSha256,
  }) {
    assertId(turnId, TURN_ID_RE, "turnId");
    if (!SHA256_RE.test(outputSha256)) throw new AiConversationValidationError("outputSha256 无效");
    return mutate(conversationId, expectedRevision, async (manifest) => {
      if (!manifest.acceptedTurnId || !manifest.acceptedOutputSha256) throw new AiConversationConflictError("请先确认一个 turn");
      if (manifest.acceptedTurnId !== turnId || manifest.acceptedOutputSha256 !== outputSha256) {
        throw new AiConversationConflictError("导入期间已确认成果发生变化");
      }
      if (
        manifest.importedTurnId === turnId
        && manifest.importedOutputSha256 === outputSha256
      ) return { changed: false };
      assertText(relativePath, "relativePath", { min: 1, max: 500, multiline: false });
      if (!SHA256_RE.test(importedSha256)) throw new AiConversationValidationError("导入文件 sha256 无效");
      manifest.importedAt = timestamp();
      manifest.importedRelativePath = relativePath;
      manifest.importedTurnId = turnId;
      manifest.importedOutputSha256 = outputSha256;
      return { changed: true, manifest };
    });
  }

  async function close(conversationId) {
    return mutate(conversationId, null, async (manifest) => {
      if (manifest.status === "closed") return { changed: false };
      if (manifest.activeTurnId) throw new AiConversationConflictError("请先取消当前 turn 再关闭会话");
      manifest.status = "closed";
      manifest.pendingPermission = null;
      return { changed: true, manifest };
    });
  }

  async function setSession(conversationId, session) {
    const paths = pathsFor(conversationId);
    const value = { ...assertPlainObject(session, "session"), schemaVersion: 1, conversationId };
    return runWithSharedWriteQueue(paths.session, async () => {
      await readManifest(conversationId);
      await atomicWriteJson(safeState, paths.session, value, MAX_SESSION_BYTES);
      return validateSession(value, conversationId);
    });
  }

  async function getSession(conversationId) {
    const paths = pathsFor(conversationId);
    await readManifest(conversationId);
    const contents = await safeState.readFile(paths.session, { maxBytes: MAX_SESSION_BYTES, missing: null });
    return contents === null ? null : validateSession(parseJson(contents, "session"), conversationId);
  }

  async function repair(conversationId) {
    const paths = pathsFor(conversationId);
    return runWithSharedWriteQueue(paths.manifest, async () => {
      const manifest = await readManifest(conversationId);
      let changed = false;
      for (const turnId of manifest.turnIds) {
        const turn = await readTurn(conversationId, turnId);
        const events = await readEvents(conversationId, turnId);
        const eventBytes = events.reduce((sum, event) => sum + Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8"), 0);
        if (turn.eventCount !== events.length || turn.eventBytes !== eventBytes) {
          turn.eventCount = events.length;
          turn.eventBytes = eventBytes;
          await atomicWriteJson(safeState, turnPath(paths, turnId), turn, MAX_TURN_BYTES);
        }
      }
      if (manifest.activeTurnId) {
        let active = null;
        try { active = await readTurn(conversationId, manifest.activeTurnId); }
        catch (error) {
          if (!(error instanceof AiConversationNotFoundError)) throw error;
          const index = manifest.turnIds.indexOf(manifest.activeTurnId);
          if (index !== manifest.turnIds.length - 1) throw new AiConversationSecurityError("缺失的 active turn 不是最后一轮，拒绝自动修复");
          manifest.turnIds.splice(index, 1);
          for (const [key, request] of Object.entries(manifest.clientRequests)) {
            if (request.turnId === manifest.activeTurnId) delete manifest.clientRequests[key];
          }
          manifest.nextTurnSeq = manifest.turnIds.length + 1;
          changed = true;
        }
        if (!active || TERMINAL_TURN_STATUSES.has(active.status)) {
          manifest.activeTurnId = null;
          manifest.pendingPermission = null;
          changed = true;
        } else if (manifest.pendingPermission && active.status !== "waiting_permission") {
          manifest.pendingPermission = null;
          changed = true;
        }
      } else if (manifest.pendingPermission) {
        manifest.pendingPermission = null;
        changed = true;
      }
      if (changed) {
        manifest.revision += 1;
        manifest.updatedAt = timestamp();
        await atomicWriteJson(safeState, paths.manifest, manifest, MAX_MANIFEST_BYTES);
      }
      return hydrate(validateManifest(manifest, conversationId, paths.workspace));
    });
  }

  return {
    stateRoot, conversationsRoot, create, list, get, createTurn, findTurnByClientRequest,
    findConversationByClientRequest,
    startTurn, completeTurn, failTurn, cancelTurn,
    appendEvent, setPendingPermission, resolvePermission, expirePermission, accept, recordImport, close, setSession, getSession, repair,
    verifyInputs,
  };
}
