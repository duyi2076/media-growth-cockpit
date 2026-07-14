import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { hasSecret } from "../../scripts/lib/security.mjs";
import { readCockpitSettingsSync } from "../cockpit-settings-store.mjs";
import { rebuildAndValidateIndex } from "../daily-tasks-api.mjs";
import { createSafeStatePaths } from "../lib/safe-state-paths.mjs";
import { runWithSharedWriteQueue } from "../lib/shared-write-queue.mjs";
import {
  AI_RUN_PROVIDERS,
  AI_RUN_TEMPLATE_IDS,
} from "./run-workspace-store.mjs";
import { redactSensitiveString } from "./redaction.mjs";

export const AI_RESULT_IMPORT_RELATIVE_SUFFIX = path.join("03-工作过程", "AI协作");

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const RUN_ID_RE = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXECUTABLE_HTML_RE = /(?:<\s*\/?\s*(?:script|iframe|object|embed|svg|math|link|meta|style|form|input|button|textarea|select|video|audio|img)\b|<\s*[a-z][^>]*\son[a-z]+\s*=|\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*text\/html)/i;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i;
const SINGLE_LINE_CONTROL_RE = /[\u0000-\u001F\u007F]/;
const MULTILINE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const TEMPLATE_LABELS = Object.freeze({
  "analyze-topic": "选题分析",
  "break-down-content": "内容拆解",
  "draft-article": "文章初稿",
  "draft-video": "视频初稿",
  "review-content": "内容复盘",
  "analyze-account": "账号拆解",
  "review-day": "每日复盘",
  "plan-tomorrow": "明日计划",
});

export class AiResultImportValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "AiResultImportValidationError";
  }
}

export class AiResultImportSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiResultImportSecurityError";
  }
}

export class AiResultImportDuplicateError extends Error {
  constructor(message = "该 AI 协作结果已经导入 Obsidian") {
    super(message);
    this.name = "AiResultImportDuplicateError";
  }
}

export class AiResultImportCommitError extends Error {
  constructor(message, { cause, rollbackError } = {}) {
    super(message, { cause });
    this.name = "AiResultImportCommitError";
    this.rollbackError = rollbackError;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertCanonicalAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new AiResultImportValidationError(`${label}必须是绝对路径`);
  }
  const parsed = path.parse(value);
  const segments = value.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new AiResultImportSecurityError(`${label}不能包含 . 或 .. 路径段`);
  }
  return path.resolve(value);
}

function assertInsideRoot(root, target, label = "目标路径") {
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new AiResultImportSecurityError(`${label}超出允许目录`);
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertCreateTargetAbsent(filePath) {
  const existing = await lstatOrNull(filePath);
  if (!existing) return;
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new AiResultImportSecurityError("AI 协作导入目标不能是软链接或非普通文件");
  }
  throw new AiResultImportDuplicateError();
}

async function assertExistingAncestorChainNoSymlinks(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const rootStat = await fs.lstat(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new AiResultImportSecurityError(`${label}根节点无效`);
  }
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new AiResultImportSecurityError(`${label}路径包含软链接或非目录节点`);
    }
  }
}

async function captureVaultIdentity(root) {
  await assertExistingAncestorChainNoSymlinks(root, "V2 根目录");
  const stat = await lstatOrNull(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new AiResultImportSecurityError("V2 根目录不存在、不是目录或为软链接");
  }
  const real = await fs.realpath(root);
  if (real !== root) throw new AiResultImportSecurityError("V2 根目录必须是无软链接的规范路径");
  return { real, dev: stat.dev, ino: stat.ino };
}

async function assertVaultIdentity(root, identity) {
  await assertExistingAncestorChainNoSymlinks(root, "V2 根目录");
  const stat = await lstatOrNull(root);
  if (
    !stat?.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== identity.dev
    || stat.ino !== identity.ino
    || await fs.realpath(root) !== identity.real
  ) {
    throw new AiResultImportSecurityError("V2 根目录在导入期间发生变化");
  }
}

async function ensureVaultDirectory(root, target, identity) {
  const resolved = assertInsideRoot(root, target, "AI 协作导入目录");
  await assertVaultIdentity(root, identity);
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = await lstatOrNull(current);
    if (!stat) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      stat = await lstatOrNull(current);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new AiResultImportSecurityError("AI 协作导入目录不能包含软链接或非目录节点");
    }
  }
  const real = await fs.realpath(resolved);
  if (real !== path.resolve(identity.real, path.relative(root, resolved))) {
    throw new AiResultImportSecurityError("AI 协作导入目录 realpath 超出固定目录");
  }
  return real;
}

function assertSafeSingleLine(value, label, maxLength) {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new AiResultImportValidationError(`${label}无效`);
  }
  if (SINGLE_LINE_CONTROL_RE.test(value)) {
    throw new AiResultImportSecurityError(`${label}包含控制字符`);
  }
  return value;
}

function assertNoExecutableHtmlOrCredentials(value, label) {
  if (EXECUTABLE_HTML_RE.test(value)) {
    throw new AiResultImportSecurityError(`${label}包含可执行 HTML 或危险 URL`);
  }
  if (hasSecret(value) || redactSensitiveString(value) !== value || PRIVATE_KEY_RE.test(value)) {
    throw new AiResultImportSecurityError(`${label}疑似包含密钥或凭证`);
  }
}

function normalizeContext(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new AiResultImportValidationError("context 必须是对象或 null");
  const context = {
    type: assertSafeSingleLine(value.type, "context.type", 80),
    id: assertSafeSingleLine(value.id, "context.id", 300),
    title: assertSafeSingleLine(value.title, "context.title", 500),
  };
  if (value.summary !== undefined) {
    if (typeof value.summary !== "string" || value.summary.length > 4_000) {
      throw new AiResultImportValidationError("context.summary 无效");
    }
    const summary = value.summary.replace(/\r\n/g, "\n");
    if (summary.includes("\r") || MULTILINE_CONTROL_RE.test(summary)) {
      throw new AiResultImportSecurityError("context.summary 包含控制字符");
    }
    assertNoExecutableHtmlOrCredentials(summary, "context.summary");
    context.summary = summary;
  }
  assertNoExecutableHtmlOrCredentials(JSON.stringify(context), "context");
  return context;
}

function normalizeRuntime(value) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new AiResultImportValidationError("runtime 必须是对象或 null");
  const unknown = Object.keys(value).filter((key) => ![
    "providerVersion", "adapterPackage", "adapterVersion", "protocolVersion", "versionStatus",
  ].includes(key));
  if (unknown.length > 0) throw new AiResultImportValidationError("runtime 包含未知字段");
  const version = (raw, label) => {
    if (raw === null || raw === undefined) return null;
    const result = assertSafeSingleLine(raw, label, 64);
    if (!/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/.test(result)) {
      throw new AiResultImportValidationError(`${label}格式无效`);
    }
    return result;
  };
  const adapterPackage = value.adapterPackage === null || value.adapterPackage === undefined
    ? null
    : assertSafeSingleLine(value.adapterPackage, "runtime.adapterPackage", 200);
  if (adapterPackage !== null && !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(adapterPackage)) {
    throw new AiResultImportValidationError("runtime.adapterPackage 格式无效");
  }
  const protocolVersion = value.protocolVersion === null || value.protocolVersion === undefined
    ? null
    : value.protocolVersion;
  if (protocolVersion !== null && (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1 || protocolVersion > 1_000)) {
    throw new AiResultImportValidationError("runtime.protocolVersion 无效");
  }
  const versionStatus = value.versionStatus ?? "unknown";
  if (!["current", "outdated", "newer", "unknown"].includes(versionStatus)) {
    throw new AiResultImportValidationError("runtime.versionStatus 无效");
  }
  return {
    providerVersion: version(value.providerVersion, "runtime.providerVersion"),
    adapterPackage,
    adapterVersion: version(value.adapterVersion, "runtime.adapterVersion"),
    protocolVersion,
    versionStatus,
  };
}

function normalizeCompletedRun(value) {
  if (!isPlainObject(value)) throw new AiResultImportValidationError("AI 协作运行结果必须是对象");
  const runId = assertSafeSingleLine(value.runId, "runId", 40);
  if (!RUN_ID_RE.test(runId)) throw new AiResultImportValidationError("runId 格式无效");
  if (value.status !== "completed") {
    throw new AiResultImportValidationError("只有 completed 的 AI 协作任务可以导入");
  }
  if (!AI_RUN_PROVIDERS.includes(value.provider)) {
    throw new AiResultImportValidationError("provider 不在允许列表中");
  }
  if (!AI_RUN_TEMPLATE_IDS.includes(value.templateId)) {
    throw new AiResultImportValidationError("templateId 不在允许列表中");
  }
  if (!Array.isArray(value.imports)) throw new AiResultImportValidationError("imports 必须是数组");
  if (value.imports.length > 0) throw new AiResultImportDuplicateError();
  if (typeof value.finalText !== "string" || !value.finalText.trim()) {
    throw new AiResultImportValidationError("completed 任务必须包含非空 finalText");
  }
  const finalText = value.finalText.replace(/\r\n/g, "\n");
  if (finalText.includes("\r") || MULTILINE_CONTROL_RE.test(finalText)) {
    throw new AiResultImportSecurityError("finalText 包含 NUL 或控制字符");
  }
  assertNoExecutableHtmlOrCredentials(finalText, "finalText");
  const context = normalizeContext(value.context);
  const runtime = normalizeRuntime(value.runtime);
  return {
    runId,
    provider: value.provider,
    templateId: value.templateId,
    context,
    runtime,
    finalText,
  };
}

function assertSafeProjectRelativeDir(value) {
  if (
    typeof value !== "string"
    || !value.startsWith("50-进行中项目/")
    || value.includes("\\")
    || value.includes("\0")
    || path.isAbsolute(value)
  ) {
    throw new AiResultImportSecurityError("驾驶舱项目目录不在允许范围内");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new AiResultImportSecurityError("驾驶舱项目目录包含无效路径段");
  }
  return parts;
}

function serializeResult(run, confirmedAt) {
  const frontmatter = {
    id: `ai-collaboration-result-${run.runId}`,
    type: "AI协作结果",
    status: "已完成",
    created_at: confirmedAt,
    updated_at: confirmedAt,
    source_run: run.runId,
    provider: run.provider,
    provider_version: run.runtime?.providerVersion ?? null,
    adapter_package: run.runtime?.adapterPackage ?? null,
    adapter_version: run.runtime?.adapterVersion ?? null,
    acp_protocol_version: run.runtime?.protocolVersion ?? null,
    provider_version_status: run.runtime?.versionStatus ?? "unknown",
    template: run.templateId,
    context: run.context,
    confirmation: "已确认",
    confirmed_at: confirmedAt,
    sensitivity: "内部",
    origin_owner: "AI协作",
    processed_by: "人机协作",
    topics: ["AI协作"],
  };
  const heading = run.context?.title ?? TEMPLATE_LABELS[run.templateId] ?? "AI 协作结果";
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  const body = run.finalText.trimEnd();
  const contents = `---\n${yaml}\n---\n\n# ${heading}\n\n${body}\n`;
  assertNoExecutableHtmlOrCredentials(contents, "AI 协作结果");
  if (Buffer.byteLength(contents, "utf8") > MAX_MARKDOWN_BYTES) {
    throw new AiResultImportValidationError("AI 协作结果超过 2MiB 安全上限");
  }
  return contents;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents, "utf8").digest("hex");
}

function normalizeImportOptions(value) {
  if (value === undefined) return { recoverExisting: false };
  if (!isPlainObject(value)) throw new AiResultImportValidationError("导入选项必须是对象");
  const unknownKeys = Object.keys(value).filter((key) => key !== "recoverExisting");
  if (unknownKeys.length > 0) throw new AiResultImportValidationError("导入选项包含未知字段");
  if (value.recoverExisting !== undefined && typeof value.recoverExisting !== "boolean") {
    throw new AiResultImportValidationError("recoverExisting 必须是布尔值");
  }
  return { recoverExisting: value.recoverExisting === true };
}

function extractSerializedConfirmedAt(contents) {
  const frontmatterEnd = contents.indexOf("\n---\n\n", 4);
  if (!contents.startsWith("---\n") || frontmatterEnd < 0) {
    throw new AiResultImportDuplicateError("已有 AI 协作结果格式不匹配，拒绝覆盖");
  }
  const frontmatter = contents.slice(4, frontmatterEnd);
  const matches = [...frontmatter.matchAll(/^confirmed_at: ([^\n]+)$/gm)];
  if (matches.length !== 1) {
    throw new AiResultImportDuplicateError("已有 AI 协作结果缺少唯一确认时间，拒绝覆盖");
  }
  const confirmedAt = matches[0][1];
  let isCanonicalTimestamp = false;
  try {
    isCanonicalTimestamp = new Date(confirmedAt).toISOString() === confirmedAt;
  } catch {
    isCanonicalTimestamp = false;
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(confirmedAt)
    || !isCanonicalTimestamp
  ) {
    throw new AiResultImportDuplicateError("已有 AI 协作结果确认时间无效，拒绝覆盖");
  }
  return confirmedAt;
}

async function recoverExistingFile(filePath, run, { root, identity, expectedParentReal }) {
  const parentReal = await ensureVaultDirectory(root, path.dirname(filePath), identity);
  if (parentReal !== expectedParentReal) throw new AiResultImportSecurityError("AI 协作导入目录发生变化");
  const before = await lstatOrNull(filePath);
  if (!before?.isFile() || before.isSymbolicLink() || before.size > MAX_MARKDOWN_BYTES) {
    throw new AiResultImportSecurityError("已有 AI 协作导入结果不是安全的普通文件");
  }
  const real = await fs.realpath(filePath);
  if (real !== path.join(expectedParentReal, path.basename(filePath))) {
    throw new AiResultImportSecurityError("已有 AI 协作导入结果 realpath 超出固定目录");
  }
  const contents = await fs.readFile(filePath, "utf8");
  const after = await fs.lstat(filePath);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || after.dev !== before.dev
    || after.ino !== before.ino
  ) {
    throw new AiResultImportSecurityError("已有 AI 协作导入结果在恢复期间被替换");
  }
  const confirmedAt = extractSerializedConfirmedAt(contents);
  const expectedContents = serializeResult(run, confirmedAt);
  const existingHash = sha256(contents);
  const expectedHash = sha256(expectedContents);
  if (existingHash !== expectedHash || contents !== expectedContents) {
    throw new AiResultImportDuplicateError("已有 AI 协作结果与本次结果不一致，拒绝覆盖");
  }
  await verifyTarget(filePath, expectedHash, { root, identity, expectedParentReal });
  return {
    relativePath: path.relative(root, filePath).split(path.sep).join("/"),
    sha256: expectedHash,
    confirmedAt,
    recovered: true,
  };
}

async function atomicCreate(filePath, contents, { root, identity, expectedParentReal }) {
  const parent = path.dirname(filePath);
  const parentReal = await ensureVaultDirectory(root, parent, identity);
  if (parentReal !== expectedParentReal) throw new AiResultImportSecurityError("AI 协作导入目录发生变化");
  await assertCreateTargetAbsent(filePath);
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let openedStat;
  let linked = false;
  try {
    handle = await fs.open(tempPath, flags, 0o600);
    openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new AiResultImportSecurityError("AI 协作临时文件不是普通文件");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await assertCreateTargetAbsent(filePath);
    const verifiedParent = await ensureVaultDirectory(root, parent, identity);
    if (verifiedParent !== expectedParentReal) throw new AiResultImportSecurityError("AI 协作导入目录发生变化");
    try {
      await fs.link(tempPath, filePath);
      linked = true;
    } catch (error) {
      if (error?.code === "EEXIST") throw new AiResultImportDuplicateError();
      throw error;
    }
    const targetStat = await fs.lstat(filePath);
    if (
      !targetStat.isFile()
      || targetStat.isSymbolicLink()
      || targetStat.dev !== openedStat.dev
      || targetStat.ino !== openedStat.ino
    ) {
      throw new AiResultImportSecurityError("AI 协作导入目标在创建时被替换");
    }
    await fs.unlink(tempPath);
    await handle.close();
    handle = undefined;
    const directoryHandle = await fs.open(parent, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    if (linked && openedStat) {
      const targetStat = await lstatOrNull(filePath).catch(() => null);
      if (
        targetStat?.isFile()
        && !targetStat.isSymbolicLink()
        && targetStat.dev === openedStat.dev
        && targetStat.ino === openedStat.ino
      ) {
        await fs.unlink(filePath).catch(() => {});
      }
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function verifyTarget(filePath, expectedHash, { root, identity, expectedParentReal }) {
  const parentReal = await ensureVaultDirectory(root, path.dirname(filePath), identity);
  if (parentReal !== expectedParentReal) throw new AiResultImportSecurityError("AI 协作导入目录发生变化");
  const stat = await lstatOrNull(filePath);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_MARKDOWN_BYTES) {
    throw new AiResultImportSecurityError("AI 协作导入结果不是安全的普通文件");
  }
  const real = await fs.realpath(filePath);
  if (real !== path.join(expectedParentReal, path.basename(filePath))) {
    throw new AiResultImportSecurityError("AI 协作导入结果 realpath 超出固定目录");
  }
  const contents = await fs.readFile(filePath, "utf8");
  if (sha256(contents) !== expectedHash) {
    throw new AiResultImportSecurityError("AI 协作导入结果在验证期间被修改");
  }
}

async function rollbackCreatedFile(filePath, expectedHash, context) {
  await verifyTarget(filePath, expectedHash, context);
  await fs.unlink(filePath);
  const directoryHandle = await fs.open(path.dirname(filePath), "r");
  try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  if (await lstatOrNull(filePath)) throw new AiResultImportSecurityError("AI 协作导入失败后未能删除目标文件");
  await context.afterWrite({
    root: context.root,
    action: "import-ai-result",
    runId: context.runId,
    filePath,
    rollback: true,
  });
  if (await lstatOrNull(filePath)) throw new AiResultImportSecurityError("AI 协作导入回滚复验失败");
}

export function createAiResultImporter(options = {}) {
  const root = assertCanonicalAbsolutePath(options.root, "root");
  const stateRoot = assertCanonicalAbsolutePath(options.stateRoot, "stateRoot");
  const now = options.now ?? (() => new Date());
  const afterWrite = options.afterWrite ?? rebuildAndValidateIndex;
  if (typeof now !== "function") throw new AiResultImportValidationError("now 必须是函数");
  if (typeof afterWrite !== "function") throw new AiResultImportValidationError("afterWrite 必须是函数");
  const auditPath = path.join(stateRoot, "audit", "ai-result-imports.jsonl");
  const backupRoot = path.join(stateRoot, "backups", "ai-result-imports");
  const safeState = createSafeStatePaths({
    stateRoot,
    label: "AI 协作导入状态",
    createSecurityError: (message) => new AiResultImportSecurityError(message),
  });

  async function appendAudit(event) {
    const line = `${JSON.stringify(event)}\n`;
    return runWithSharedWriteQueue(auditPath, () => safeState.appendFile(auditPath, line));
  }

  async function importRun(value, importOptions) {
    const run = normalizeCompletedRun(value);
    const { recoverExisting } = normalizeImportOptions(importOptions);
    const settings = readCockpitSettingsSync(root);
    const projectSegments = assertSafeProjectRelativeDir(settings.projectRelativeDir);
    const importRoot = path.join(root, ...projectSegments, ...AI_RESULT_IMPORT_RELATIVE_SUFFIX.split(path.sep));
    const fileName = `${run.runId}-AI协作结果.md`;
    const filePath = path.join(importRoot, fileName);
    assertInsideRoot(root, importRoot, "AI 协作导入目录");
    assertInsideRoot(importRoot, filePath, "AI 协作导入文件");

    return runWithSharedWriteQueue(filePath, async () => {
      await assertExistingAncestorChainNoSymlinks(stateRoot, "stateRoot");
      await safeState.ensureRoot();
      await safeState.ensureDirectory(backupRoot);
      await safeState.prepareAppendFile(auditPath);
      const identity = await captureVaultIdentity(root);
      const importRootReal = await ensureVaultDirectory(root, importRoot, identity);
      const existing = await lstatOrNull(filePath);
      if (existing) {
        if (!recoverExisting) await assertCreateTargetAbsent(filePath);
        const recovered = await recoverExistingFile(filePath, run, {
          root,
          identity,
          expectedParentReal: importRootReal,
        });
        try {
          await afterWrite({
            root,
            action: "import-ai-result",
            runId: run.runId,
            filePath,
            recovered: true,
          });
          await verifyTarget(filePath, recovered.sha256, {
            root,
            identity,
            expectedParentReal: importRootReal,
          });
          const recoveredAt = now();
          if (!(recoveredAt instanceof Date) || Number.isNaN(recoveredAt.getTime())) {
            throw new AiResultImportValidationError("now 必须返回有效 Date");
          }
          await appendAudit({
            at: recoveredAt.toISOString(),
            action: "import-ai-result",
            runId: run.runId,
            provider: run.provider,
            templateId: run.templateId,
            status: "recovered",
            relativePath: recovered.relativePath,
            sha256: recovered.sha256,
          });
          return recovered;
        } catch (error) {
          if (error instanceof AiResultImportSecurityError
            || error instanceof AiResultImportDuplicateError
            || error instanceof AiResultImportValidationError) throw error;
          throw new AiResultImportCommitError(
            "已有 AI 协作结果已验证，但索引刷新失败；可安全重试",
            { cause: error },
          );
        }
      }

      const timestamp = now();
      if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
        throw new AiResultImportValidationError("now 必须返回有效 Date");
      }
      const confirmedAt = timestamp.toISOString();
      const contents = serializeResult(run, confirmedAt);
      const hash = sha256(contents);
      const relativePath = path.relative(root, filePath).split(path.sep).join("/");
      let created = false;

      try {
        await atomicCreate(filePath, contents, {
          root,
          identity,
          expectedParentReal: importRootReal,
        });
        created = true;
        await afterWrite({ root, action: "import-ai-result", runId: run.runId, filePath });
        await verifyTarget(filePath, hash, { root, identity, expectedParentReal: importRootReal });
        await appendAudit({
          at: confirmedAt,
          action: "import-ai-result",
          runId: run.runId,
          provider: run.provider,
          templateId: run.templateId,
          status: "success",
          relativePath,
          sha256: hash,
        });
        return { relativePath, sha256: hash, confirmedAt };
      } catch (error) {
        if (!created || error instanceof AiResultImportDuplicateError) throw error;
        let rollbackError;
        try {
          await rollbackCreatedFile(filePath, hash, {
            root,
            identity,
            expectedParentReal: importRootReal,
            afterWrite,
            runId: run.runId,
          });
        } catch (caught) {
          rollbackError = caught;
        }
        await appendAudit({
          at: now().toISOString(),
          action: "import-ai-result",
          runId: run.runId,
          provider: run.provider,
          templateId: run.templateId,
          status: rollbackError ? "rollback_failed" : "rolled_back",
          relativePath,
          sha256: hash,
        }).catch(() => {});
        throw new AiResultImportCommitError(
          rollbackError
            ? "AI 协作结果校验失败，且未能完整回滚"
            : "AI 协作结果校验失败，已删除导入文件并复验",
          { cause: error, rollbackError },
        );
      }
    });
  }

  return {
    root,
    stateRoot,
    auditPath,
    backupRoot,
    importRun,
  };
}
