import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hasSecret } from "../scripts/lib/security.mjs";
import { readCockpitSettingsSync } from "./cockpit-settings-store.mjs";
import { createSafeStatePaths } from "./lib/safe-state-paths.mjs";
import { runWithSharedWriteQueue } from "./lib/shared-write-queue.mjs";

export const ACTION_TARGETS_RELATIVE_PATH = path.join(
  "50-进行中项目",
  "自媒体增长计划",
  "01-目标与验收.md",
);

export const ACTION_TARGET_DEFINITIONS = [
  { id: "article-output", label: "文章", unit: "篇", countRule: "completed_article_assets" },
  { id: "video-output", label: "视频", unit: "条", countRule: "completed_video_assets" },
  { id: "platform-publish", label: "发布", unit: "次", countRule: "platform_publication_records" },
  { id: "content-review", label: "复盘", unit: "次", countRule: "confirmed_daily_reviews" },
  { id: "account-breakdown", label: "账号拆解", unit: "个", countRule: "confirmed_account_breakdowns" },
];

const ACTION_IDS = ACTION_TARGET_DEFINITIONS.map((item) => item.id);
const ACTION_TARGET_SOURCES = {
  "article-output": "项目期内已人工确认成稿的文章内容资产；同一 family_id 只计一次",
  "video-output": "项目期内已人工确认成片的短视频内容资产；同一 family_id 只计一次",
  "platform-publish": "已核验的平台发布记录；多平台分别计数，重复记录不计",
  "content-review": "已确认的每日整体复盘；单条内容复盘不重复计数",
  "account-breakdown": "已确认且标记为账号拆解或对标账号的知识资产",
};
const HASH_RE = /^[a-f0-9]{64}$/;
const targetSchema = z.number().int().min(1).max(1_000_000).nullable();
const actionTargetSchema = z.object({
  id: z.enum(ACTION_IDS),
  target: targetSchema,
}).strict();

export const actionTargetsInputSchema = z.array(actionTargetSchema).length(ACTION_IDS.length).superRefine((items, context) => {
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== ACTION_IDS.length) {
    context.addIssue({ code: "custom", message: "行动目标不能重复" });
  }
  for (const id of ACTION_IDS) {
    if (!ids.has(id)) context.addIssue({ code: "custom", message: `行动目标缺少 ${id}` });
  }
});

export class ActionTargetsValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "ActionTargetsValidationError";
  }
}

export class ActionTargetsSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ActionTargetsSecurityError";
  }
}

export class ActionTargetsConflictError extends Error {
  constructor(current) {
    super("目标文件已经被其他操作修改，请加载最新内容后重试");
    this.name = "ActionTargetsConflictError";
    this.current = current;
  }
}

export class ActionTargetsCommitError extends Error {
  constructor(message, { cause, rollbackError } = {}) {
    super(message, { cause });
    this.name = "ActionTargetsCommitError";
    this.rollbackError = rollbackError;
  }
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function splitFrontmatter(markdown) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new ActionTargetsValidationError("目标文件缺少 frontmatter");
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw new ActionTargetsValidationError("目标文件的 frontmatter 未闭合");
  let frontmatter;
  try {
    frontmatter = parseYaml(normalized.slice(4, end)) ?? {};
  } catch (error) {
    throw new ActionTargetsValidationError("目标文件的 frontmatter 无法解析", error);
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new ActionTargetsValidationError("目标文件的 frontmatter 必须是对象");
  }
  return { frontmatter, body: normalized.slice(end + 5) };
}

function parseTargets(frontmatter) {
  if (frontmatter.type !== "项目目标" || frontmatter.confirmation !== "已确认") {
    throw new ActionTargetsValidationError("目标文件必须是已确认的项目目标");
  }
  if (frontmatter.sensitivity === "敏感") {
    throw new ActionTargetsSecurityError("敏感目标文件不会同步到驾驶舱");
  }
  if (!Array.isArray(frontmatter.action_targets)) {
    throw new ActionTargetsValidationError("目标文件缺少 action_targets");
  }
  const items = frontmatter.action_targets.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ActionTargetsValidationError(`action_targets[${index}] 必须是对象`);
    }
    return { id: item.id, target: item.target ?? null };
  });
  const result = actionTargetsInputSchema.safeParse(items);
  if (!result.success) throw new ActionTargetsValidationError("目标文件包含无效目标", result.error);
  return result.data;
}

function parseCampaignStartedAt(frontmatter) {
  const value = frontmatter.campaign_started_at;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ActionTargetsValidationError("campaign_started_at 必须是有效时间");
  }
  return value;
}

function synchronizeActionTargetTable(body, targets) {
  const pattern = /\| 动作 \| 目标 \| 完成数来源 \|\n\|---\|---:\|---\|\n(?:\|[^\n]*\|\n){5}/;
  if (!pattern.test(body)) return body;
  const targetById = new Map(targets.map((item) => [item.id, item.target]));
  const table = [
    "| 动作 | 目标 | 完成数来源 |",
    "|---|---:|---|",
    ...ACTION_TARGET_DEFINITIONS.map((definition) => {
      const target = targetById.get(definition.id);
      const display = target === null ? "待填写" : `${target} ${definition.unit}`;
      return `| ${definition.label} | ${display} | ${ACTION_TARGET_SOURCES[definition.id]} |`;
    }),
    "",
  ].join("\n");
  return body.replace(pattern, table);
}

function serializeTargets(markdown, targets, date, campaignStartedAt) {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const byId = new Map(targets.map((item) => [item.id, item.target]));
  frontmatter.updated_at = date;
  frontmatter.action_targets = ACTION_TARGET_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    target: byId.get(definition.id),
    unit: definition.unit,
    count_rule: definition.countRule,
  }));
  frontmatter.campaign_started_at = campaignStartedAt;
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${synchronizeActionTargetTable(body, targets)}`;
}

function assertInsideRoot(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new ActionTargetsSecurityError("目标路径超出 V2 白名单");
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinks(root, target) {
  assertInsideRoot(root, target);
  const rootStat = await lstatOrNull(root);
  if (!rootStat || rootStat.isSymbolicLink()) {
    throw new ActionTargetsSecurityError("V2 根目录不存在或为软链接");
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) throw new ActionTargetsSecurityError("目标文件路径不存在");
    if (stat.isSymbolicLink()) throw new ActionTargetsSecurityError("目标文件路径不能包含软链接");
  }
}

async function atomicWrite(filePath, contents, root) {
  const parent = path.dirname(filePath);
  await assertNoSymlinks(root, parent);
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertNoSymlinks(root, parent);
    const current = await lstatOrNull(filePath);
    if (!current?.isFile() || current.isSymbolicLink()) {
      throw new ActionTargetsSecurityError("目标文件不是普通文件");
    }
    await fs.rename(tempPath, filePath);
    const directoryHandle = await fs.open(parent, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

export function createActionTargetsStore(options = {}) {
  const root = path.resolve(options.root ?? process.env.V2_VAULT_ROOT ?? process.env.OBSIDIAN_VAULT_ROOT ?? path.join(os.homedir(), "第二大脑-v2"));
  const stateRoot = path.resolve(options.stateRoot ?? process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"));
  const backupRoot = path.join(stateRoot, "backups", "action-targets");
  const auditPath = path.join(stateRoot, "audit", "action-targets.jsonl");
  const now = options.now ?? (() => new Date());
  const afterWrite = options.afterWrite;
  const safeState = createSafeStatePaths({
    stateRoot,
    label: "行动目标状态",
    createSecurityError: (message) => new ActionTargetsSecurityError(message),
  });

  function resolveFilePath() {
    const projectRelativeDir = options.projectRelativeDir ?? readCockpitSettingsSync(root).projectRelativeDir;
    const target = path.resolve(root, projectRelativeDir, "01-目标与验收.md");
    assertInsideRoot(root, target);
    return target;
  }

  async function audit(action, status, hash) {
    const entry = { at: now().toISOString(), action, status, hash: hash?.slice(0, 12) ?? null };
    await safeState.appendFile(auditPath, `${JSON.stringify(entry)}\n`);
  }

  async function readFrom(filePath) {
    await assertNoSymlinks(root, filePath);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ActionTargetsSecurityError("目标文件不是普通文件");
    if (stat.size > 128 * 1024) throw new ActionTargetsSecurityError("目标文件超过 128KB 安全上限");
    const contents = await fs.readFile(filePath, "utf8");
    if (hasSecret(contents)) throw new ActionTargetsSecurityError("目标文件包含疑似密钥或凭证，已停止同步");
    const { frontmatter } = splitFrontmatter(contents);
    return {
      targets: parseTargets(frontmatter),
      campaignStartedAt: parseCampaignStartedAt(frontmatter),
      hash: sha256(contents),
      updatedAt: stat.mtime.toISOString(),
    };
  }

  async function read() {
    return readFrom(resolveFilePath());
  }

  async function writeUnlocked(filePath, targets, expectedHash, { startCampaign = false } = {}) {
    const validated = actionTargetsInputSchema.safeParse(targets);
    if (!validated.success) throw new ActionTargetsValidationError("行动目标数据无效", validated.error);
    if (typeof expectedHash !== "string" || !HASH_RE.test(expectedHash)) {
      throw new ActionTargetsValidationError("expectedHash 必须是 64 位小写 SHA-256");
    }
    await safeState.prepareAppendFile(auditPath);
    const current = await readFrom(filePath);
    if (current.hash !== expectedHash) {
      await audit(startCampaign ? "start" : "write", "conflict", current.hash);
      throw new ActionTargetsConflictError(current);
    }
    const previousContents = await fs.readFile(filePath, "utf8");
    const stamp = now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
    const backupPath = path.join(backupRoot, `${stamp}-${current.hash.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}.md`);
    await safeState.writeNewFile(backupPath, previousContents);

    const latest = await readFrom(filePath);
    if (latest.hash !== current.hash) throw new ActionTargetsConflictError(latest);
    const campaignStartedAt = startCampaign
      ? current.campaignStartedAt ?? now().toISOString()
      : current.campaignStartedAt;
    const contents = serializeTargets(previousContents, validated.data, shanghaiDate(now()), campaignStartedAt);
    await atomicWrite(filePath, contents, root);
    const writtenHash = sha256(contents);

    try {
      await afterWrite?.({ root });
      const snapshot = await readFrom(filePath);
      await audit(startCampaign ? "start" : "write", "success", snapshot.hash);
      return snapshot;
    } catch (error) {
      let rollbackError;
      try {
        const beforeRollback = await readFrom(filePath);
        if (beforeRollback.hash !== writtenHash) throw new ActionTargetsConflictError(beforeRollback);
        await atomicWrite(filePath, previousContents, root);
        await afterWrite?.({ root, rollback: true });
      } catch (rollback) {
        rollbackError = rollback;
      }
      await audit(startCampaign ? "start" : "write", rollbackError ? "rollback_failed" : "rolled_back", current.hash);
      throw new ActionTargetsCommitError("目标保存后的数据校验失败，已尝试恢复旧版本", { cause: error, rollbackError });
    }
  }

  function write(targets, expectedHash, options) {
    let filePath;
    try {
      filePath = resolveFilePath();
    } catch (error) {
      return Promise.reject(error);
    }
    return runWithSharedWriteQueue(
      filePath,
      () => writeUnlocked(filePath, targets, expectedHash, options),
    );
  }

  return {
    read,
    write,
    get filePath() {
      return resolveFilePath();
    },
  };
}
