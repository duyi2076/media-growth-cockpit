import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hasSecret } from "../scripts/lib/security.mjs";
import { createSafeStatePaths } from "./lib/safe-state-paths.mjs";
import { runWithSharedWriteQueue } from "./lib/shared-write-queue.mjs";

export const COCKPIT_SETTINGS_RELATIVE_PATH = path.join(
  "99-系统",
  "自媒体驾驶舱",
  "驾驶舱设置.md",
);

export const DEFAULT_COCKPIT_SETTINGS = Object.freeze({
  productName: "自媒体增长驾驶舱",
  ownerName: "使用者",
  creatorPositioning: "内容创作者",
  campaignName: "增长计划",
  growthTarget: 10_000,
  startDate: null,
  deadline: null,
  projectRelativeDir: "50-进行中项目/自媒体增长计划",
  baselineDate: "1970-01-01",
  baselineRelativePath: "60-数据与看板/01-内容数据/平台粉丝基线.md",
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const singleLine = (label, max) => z.string()
  .trim()
  .min(1, `${label}不能为空`)
  .max(max, `${label}不能超过 ${max} 个字符`)
  .refine((value) => !/[\r\n\0]/.test(value), `${label}必须是单行文字`)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), `${label}包含控制字符`)
  .refine((value) => !/[<>]/.test(value), `${label}不能包含 HTML`)
  .refine((value) => !value.includes("[[") && !value.includes("]]"), `${label}不能包含 Obsidian 链接`)
  .refine((value) => !value.includes("---"), `${label}不能包含 frontmatter 分隔符`);

const nullableDate = z.union([
  z.string().regex(DATE_RE, "日期必须是 YYYY-MM-DD"),
  z.null(),
]);

function isSafeVaultRelativePath(value, { directory = false } = {}) {
  if (typeof value !== "string" || value.trim() !== value || !value || value.includes("\\") || value.includes("\0")) return false;
  if (path.isAbsolute(value) || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return directory ? !value.endsWith(".md") : value.endsWith(".md");
}

export const cockpitSettingsSchema = z.object({
  productName: singleLine("产品名称", 40),
  ownerName: singleLine("使用者名称", 40),
  creatorPositioning: singleLine("创作定位", 60),
  campaignName: singleLine("目标名称", 80),
  growthTarget: z.number().int().min(1, "涨粉目标至少为 1").max(100_000_000, "涨粉目标过大"),
  startDate: nullableDate,
  deadline: nullableDate,
  projectRelativeDir: z.string().max(240).refine(
    (value) => isSafeVaultRelativePath(value, { directory: true }) && value.startsWith("50-进行中项目/"),
    "项目目录必须是 50-进行中项目 下的安全相对路径",
  ),
  baselineDate: z.string().regex(DATE_RE, "基线日期必须是 YYYY-MM-DD"),
  baselineRelativePath: z.string().max(300).refine(
    (value) => isSafeVaultRelativePath(value) && value.startsWith("60-数据与看板/"),
    "基线文件必须是 60-数据与看板 下的 Markdown 相对路径",
  ),
}).strict().superRefine((value, context) => {
  if (value.startDate && value.deadline && value.deadline < value.startDate) {
    context.addIssue({ code: "custom", path: ["deadline"], message: "截止日期不能早于开始日期" });
  }
});

export class CockpitSettingsValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "CockpitSettingsValidationError";
  }
}

export class CockpitSettingsSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "CockpitSettingsSecurityError";
  }
}

export class CockpitSettingsConflictError extends Error {
  constructor(current) {
    super("驾驶舱设置已被其他操作修改，请载入最新内容后重试");
    this.name = "CockpitSettingsConflictError";
    this.current = current;
  }
}

export class CockpitSettingsCommitError extends Error {
  constructor(message, { cause, rollbackError } = {}) {
    super(message, { cause });
    this.name = "CockpitSettingsCommitError";
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
  if (!normalized.startsWith("---\n")) throw new CockpitSettingsValidationError("设置文件缺少 frontmatter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw new CockpitSettingsValidationError("设置文件的 frontmatter 未闭合");
  let frontmatter;
  try {
    frontmatter = parseYaml(normalized.slice(4, end)) ?? {};
  } catch (error) {
    throw new CockpitSettingsValidationError("设置文件的 frontmatter 无法解析", error);
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new CockpitSettingsValidationError("设置文件的 frontmatter 必须是对象");
  }
  return { frontmatter, body: normalized.slice(end + 5) };
}

export function parseCockpitSettingsFrontmatter(frontmatter) {
  if (frontmatter.type !== "驾驶舱设置" || frontmatter.confirmation !== "已确认") {
    throw new CockpitSettingsValidationError("设置文件必须是已确认的驾驶舱设置");
  }
  if (frontmatter.sensitivity === "敏感") {
    throw new CockpitSettingsSecurityError("敏感设置文件不会同步到驾驶舱");
  }
  const result = cockpitSettingsSchema.safeParse({
    productName: frontmatter.product_name,
    ownerName: frontmatter.owner_name,
    creatorPositioning: frontmatter.creator_positioning,
    campaignName: frontmatter.campaign_name,
    growthTarget: frontmatter.growth_target,
    startDate: frontmatter.start_date ?? null,
    deadline: frontmatter.deadline ?? null,
    projectRelativeDir: frontmatter.project_relative_dir,
    baselineDate: frontmatter.baseline_date,
    baselineRelativePath: frontmatter.baseline_relative_path,
  });
  if (!result.success) throw new CockpitSettingsValidationError("设置文件包含无效字段", result.error);
  return result.data;
}

function serializeSettings(previous, settings, date) {
  const frontmatter = previous ? splitFrontmatter(previous).frontmatter : {
    id: "media-growth-cockpit-settings",
    type: "驾驶舱设置",
    status: "已确认",
    confirmation: "已确认",
    sensitivity: "内部",
  };
  const body = previous ? splitFrontmatter(previous).body : "# 驾驶舱设置\n\n这些字段由驾驶舱设置页维护。\n";
  frontmatter.updated_at = date;
  frontmatter.product_name = settings.productName;
  frontmatter.owner_name = settings.ownerName;
  frontmatter.creator_positioning = settings.creatorPositioning;
  frontmatter.campaign_name = settings.campaignName;
  frontmatter.growth_target = settings.growthTarget;
  frontmatter.start_date = settings.startDate;
  frontmatter.deadline = settings.deadline;
  frontmatter.project_relative_dir = settings.projectRelativeDir;
  frontmatter.baseline_date = settings.baselineDate;
  frontmatter.baseline_relative_path = settings.baselineRelativePath;
  const yaml = stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n${body}`;
}

function assertInsideRoot(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new CockpitSettingsSecurityError("设置路径超出 V2 白名单");
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRoot(root) {
  const stat = await lstatOrNull(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new CockpitSettingsSecurityError("V2 根目录不存在或为软链接");
  }
}

async function ensureSafeDirectory(root, target) {
  assertInsideRoot(root, target);
  await assertRoot(root);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) {
      await fs.mkdir(current, { mode: 0o700 });
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CockpitSettingsSecurityError("设置路径不能包含软链接或非目录节点");
    }
  }
}

async function assertExistingPathSafe(root, target) {
  assertInsideRoot(root, target);
  await assertRoot(root);
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) throw new CockpitSettingsSecurityError("设置路径不能包含软链接");
  }
  return true;
}

async function atomicWrite(filePath, contents, root) {
  const parent = path.dirname(filePath);
  await ensureSafeDirectory(root, parent);
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await ensureSafeDirectory(root, parent);
    const current = await lstatOrNull(filePath);
    if (current && (!current.isFile() || current.isSymbolicLink())) {
      throw new CockpitSettingsSecurityError("设置目标不是普通文件");
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

function resolveVaultRoot(options = {}) {
  return path.resolve(
    options.root
      ?? process.env.V2_VAULT_ROOT
      ?? process.env.OBSIDIAN_VAULT_ROOT
      ?? path.join(os.homedir(), "第二大脑-v2"),
  );
}

export function readCockpitSettingsSync(rootInput) {
  const root = path.resolve(rootInput);
  const filePath = path.resolve(root, COCKPIT_SETTINGS_RELATIVE_PATH);
  assertInsideRoot(root, filePath);
  const rootStat = fsSync.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat) return { ...DEFAULT_COCKPIT_SETTINGS };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CockpitSettingsSecurityError("V2 根目录不存在或为软链接");
  }
  let current = root;
  for (const segment of path.relative(root, filePath).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fsSync.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return { ...DEFAULT_COCKPIT_SETTINGS };
    if (stat.isSymbolicLink()) throw new CockpitSettingsSecurityError("设置路径不能包含软链接");
  }
  const stat = fsSync.lstatSync(filePath);
  if (!stat.isFile() || stat.size > 128 * 1024) throw new CockpitSettingsSecurityError("设置文件不是安全的普通文件");
  const contents = fsSync.readFileSync(filePath, "utf8");
  if (hasSecret(contents)) throw new CockpitSettingsSecurityError("设置文件包含疑似密钥或凭证");
  return parseCockpitSettingsFrontmatter(splitFrontmatter(contents).frontmatter);
}

export function createCockpitSettingsStore(options = {}) {
  const root = resolveVaultRoot(options);
  const stateRoot = path.resolve(options.stateRoot ?? process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"));
  const filePath = path.resolve(root, COCKPIT_SETTINGS_RELATIVE_PATH);
  const backupRoot = path.join(stateRoot, "backups", "cockpit-settings");
  const auditPath = path.join(stateRoot, "audit", "cockpit-settings.jsonl");
  const now = options.now ?? (() => new Date());
  const afterWrite = options.afterWrite;
  const safeState = createSafeStatePaths({
    stateRoot,
    label: "驾驶舱设置状态",
    createSecurityError: (message) => new CockpitSettingsSecurityError(message),
  });

  assertInsideRoot(root, filePath);

  async function audit(action, status, hash) {
    await safeState.appendFile(auditPath, `${JSON.stringify({
      at: now().toISOString(),
      action,
      status,
      hash: hash?.slice(0, 12) ?? null,
    })}\n`);
  }

  async function read() {
    const exists = await assertExistingPathSafe(root, filePath);
    if (!exists) {
      return {
        settings: { ...DEFAULT_COCKPIT_SETTINGS },
        initialized: false,
        hash: null,
        updatedAt: null,
      };
    }
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new CockpitSettingsSecurityError("设置目标不是普通文件");
    if (stat.size > 128 * 1024) throw new CockpitSettingsSecurityError("设置文件超过 128KB 安全上限");
    const contents = await fs.readFile(filePath, "utf8");
    if (hasSecret(contents)) throw new CockpitSettingsSecurityError("设置文件包含疑似密钥或凭证，已停止同步");
    const { frontmatter } = splitFrontmatter(contents);
    return {
      settings: parseCockpitSettingsFrontmatter(frontmatter),
      initialized: true,
      hash: sha256(contents),
      updatedAt: stat.mtime.toISOString(),
    };
  }

  async function writeUnlocked(settings, expectedHash) {
    const validated = cockpitSettingsSchema.safeParse(settings);
    if (!validated.success) throw new CockpitSettingsValidationError("驾驶舱设置数据无效", validated.error);
    if (!(expectedHash === null || (typeof expectedHash === "string" && HASH_RE.test(expectedHash)))) {
      throw new CockpitSettingsValidationError("expectedHash 必须是 null 或 64 位小写 SHA-256");
    }
    await safeState.prepareAppendFile(auditPath);
    const current = await read();
    if (current.hash !== expectedHash) {
      await audit("write", "conflict", current.hash);
      throw new CockpitSettingsConflictError(current);
    }
    const previousContents = current.initialized ? await fs.readFile(filePath, "utf8") : null;
    let backupPath = null;
    if (previousContents !== null) {
      const stamp = now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
      backupPath = path.join(backupRoot, `${stamp}-${current.hash.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}.md`);
      await safeState.writeNewFile(backupPath, previousContents);
    }

    const latest = await read();
    if (latest.hash !== current.hash) throw new CockpitSettingsConflictError(latest);
    const contents = serializeSettings(previousContents, validated.data, shanghaiDate(now()));
    await atomicWrite(filePath, contents, root);
    const writtenHash = sha256(contents);

    try {
      await afterWrite?.({ root });
      const snapshot = await read();
      await audit(current.initialized ? "write" : "initialize", "success", snapshot.hash);
      return snapshot;
    } catch (error) {
      let rollbackError;
      try {
        const beforeRollback = await read();
        if (beforeRollback.hash !== writtenHash) throw new CockpitSettingsConflictError(beforeRollback);
        if (previousContents === null) {
          await fs.unlink(filePath);
        } else {
          await atomicWrite(filePath, previousContents, root);
        }
        await afterWrite?.({ root, rollback: true });
      } catch (rollback) {
        rollbackError = rollback;
      }
      await audit("write", rollbackError ? "rollback_failed" : "rolled_back", current.hash);
      throw new CockpitSettingsCommitError("设置保存后的数据校验失败，已尝试恢复旧版本", { cause: error, rollbackError });
    }
  }

  function write(settings, expectedHash) {
    return runWithSharedWriteQueue(
      filePath,
      () => writeUnlocked(settings, expectedHash),
    );
  }

  return { read, write, filePath, root };
}
