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
import { redactSensitiveString } from "./redaction.mjs";

const RELATIVE_SUFFIX = path.join("03-工作过程", "AI协作");
const CONVERSATION_ID_RE = /^conv-[0-9a-f-]{36}$/i;
const TURN_ID_RE = /^turn-[0-9a-f-]{36}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const DANGEROUS_HTML_RE = /(?:<\s*\/?\s*(?:script|iframe|object|embed|svg|math|style|form|input|button|textarea|select)\b|\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*text\/html)/i;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export class AiConversationImportValidationError extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = "AiConversationImportValidationError"; }
}
export class AiConversationImportSecurityError extends Error {
  constructor(message) { super(message); this.name = "AiConversationImportSecurityError"; }
}
export class AiConversationImportConflictError extends Error {
  constructor(message = "该成果已经导入或目标文件冲突") { super(message); this.name = "AiConversationImportConflictError"; }
}
export class AiConversationImportCommitError extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = "AiConversationImportCommitError"; }
}

function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new AiConversationImportValidationError(`${label}必须是绝对路径`);
  const parsed = path.parse(value);
  if (value.slice(parsed.root.length).split(/[\\/]+/).some((segment) => segment === "." || segment === "..")) {
    throw new AiConversationImportSecurityError(`${label}包含越界路径段`);
  }
  return path.resolve(value);
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new AiConversationImportSecurityError("导入路径超出 V2 根目录");
}

async function lstatOrNull(filePath) {
  try { return await fs.lstat(filePath); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function assertNoSymlinkTree(root, target, create = false) {
  assertInside(root, target);
  const rootStat = await lstatOrNull(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new AiConversationImportSecurityError("V2 根目录不存在或不安全");
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = await lstatOrNull(current);
    if (!stat && create) {
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
      stat = await lstatOrNull(current);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new AiConversationImportSecurityError("导入目录包含软链接或非目录节点");
  }
  const [rootReal, targetReal] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  if (targetReal !== path.resolve(rootReal, path.relative(root, target))) throw new AiConversationImportSecurityError("导入目录 realpath 越界");
}

function validateProjectRelativeDir(value) {
  if (typeof value !== "string" || !value.startsWith("50-进行中项目/") || value.includes("\\") || path.isAbsolute(value)) {
    throw new AiConversationImportSecurityError("驾驶舱项目目录不在允许范围内");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new AiConversationImportSecurityError("驾驶舱项目目录不安全");
  return parts;
}

function normalize(value) {
  const conversation = value?.conversation;
  const turn = value?.turn;
  if (!conversation || !turn || !CONVERSATION_ID_RE.test(conversation.id) || !TURN_ID_RE.test(turn.id)) {
    throw new AiConversationImportValidationError("会话或 turn 标识无效");
  }
  if (conversation.acceptedTurnId !== turn.id || turn.status !== "completed") {
    throw new AiConversationImportConflictError("只能导入服务端已确认的 completed turn");
  }
  if (!SHA256_RE.test(turn.outputSha256) || conversation.acceptedOutputSha256 !== turn.outputSha256) {
    throw new AiConversationImportConflictError("已确认哈希与权威正文不一致");
  }
  const authoritativeBody = String(turn.assistantText ?? "");
  if (
    crypto.createHash("sha256").update(authoritativeBody, "utf8").digest("hex") !== turn.outputSha256
  ) {
    throw new AiConversationImportConflictError("权威正文哈希不一致");
  }
  const body = authoritativeBody.replace(/\r\n/g, "\n");
  if (!body.trim() || CONTROL_RE.test(body) || DANGEROUS_HTML_RE.test(body) || hasSecret(body) || redactSensitiveString(body) !== body) {
    throw new AiConversationImportSecurityError("成果为空、包含危险内容或疑似凭证");
  }
  return { conversation, turn, body };
}

function serialize({ conversation, turn, body }) {
  const confirmedAt = conversation.acceptedAt;
  if (typeof confirmedAt !== "string" || new Date(confirmedAt).toISOString() !== confirmedAt) {
    throw new AiConversationImportValidationError("成果缺少有效确认时间");
  }
  const frontmatter = {
    id: `ai-conversation-result-${conversation.id}-${turn.id}`,
    type: "AI协作结果",
    status: "已完成",
    created_at: confirmedAt,
    updated_at: confirmedAt,
    source_conversation: conversation.id,
    source_turn: turn.id,
    source_output_sha256: turn.outputSha256,
    provider: conversation.provider,
    template: conversation.templateId,
    context: conversation.context,
    confirmation: "已确认",
    confirmed_at: confirmedAt,
    sensitivity: "内部",
    origin_owner: "AI协作",
    processed_by: "人机协作",
    topics: ["AI协作"],
  };
  const heading = conversation.context?.title ?? "AI 协作成果";
  const contents = `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n\n# ${heading}\n\n${body.trimEnd()}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_MARKDOWN_BYTES) throw new AiConversationImportValidationError("成果超过 2MiB");
  return contents;
}

function hash(contents) { return crypto.createHash("sha256").update(contents, "utf8").digest("hex"); }

async function atomicCreateOrVerify(filePath, contents) {
  const existing = await lstatOrNull(filePath);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size > MAX_MARKDOWN_BYTES) throw new AiConversationImportSecurityError("已有导入目标不安全");
    const current = await fs.readFile(filePath, "utf8");
    if (current !== contents) throw new AiConversationImportConflictError("已有导入目标与本次成果不同");
    return false;
  }
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  let linked = false;
  try {
    handle = await fs.open(tempPath, flags, 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await fs.link(tempPath, filePath);
    linked = true;
    await fs.unlink(tempPath);
    await handle.close(); handle = null;
    const dirHandle = await fs.open(directory, "r");
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") throw new AiConversationImportConflictError();
    if (linked) await fs.unlink(filePath).catch(() => {});
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

export function createAiConversationResultImporter(options = {}) {
  const root = assertAbsolute(options.root, "root");
  const stateRoot = assertAbsolute(options.stateRoot, "stateRoot");
  const afterWrite = options.afterWrite ?? rebuildAndValidateIndex;
  const safeState = createSafeStatePaths({
    stateRoot,
    label: "AI 会话导入状态",
    createSecurityError: (message) => new AiConversationImportSecurityError(message),
  });
  const auditPath = path.join(stateRoot, "audit", "ai-conversation-imports.jsonl");

  async function importConversation(value) {
    const outcome = normalize(value);
    const settings = readCockpitSettingsSync(root);
    const importRoot = path.join(root, ...validateProjectRelativeDir(settings.projectRelativeDir), ...RELATIVE_SUFFIX.split(path.sep));
    const filePath = path.join(importRoot, `${outcome.conversation.id}-${outcome.turn.id}-AI协作结果.md`);
    assertInside(root, filePath);
    const contents = serialize(outcome);
    const sha256 = hash(contents);
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    return runWithSharedWriteQueue(filePath, async () => {
      await assertNoSymlinkTree(root, importRoot, true);
      const created = await atomicCreateOrVerify(filePath, contents);
      try {
        await afterWrite({ root, action: "import-ai-conversation-result", conversationId: outcome.conversation.id, turnId: outcome.turn.id, filePath });
        const stat = await fs.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || hash(await fs.readFile(filePath, "utf8")) !== sha256) {
          throw new AiConversationImportSecurityError("导入结果复验失败");
        }
        const audit = `${JSON.stringify({ at: new Date().toISOString(), conversationId: outcome.conversation.id, turnId: outcome.turn.id, relativePath, sha256 })}\n`;
        await safeState.appendFile(auditPath, audit);
        return { relativePath, sha256 };
      } catch (error) {
        if (created) {
          await fs.unlink(filePath).catch(() => {});
          await afterWrite({ root, action: "import-ai-conversation-result", conversationId: outcome.conversation.id, turnId: outcome.turn.id, filePath, rollback: true }).catch(() => {});
        }
        if (error instanceof AiConversationImportSecurityError || error instanceof AiConversationImportConflictError) throw error;
        throw new AiConversationImportCommitError("成果导入失败，已尝试回滚", error);
      }
    });
  }
  return { root, stateRoot, importConversation };
}
