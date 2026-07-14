import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hasSecret } from "../scripts/lib/security.mjs";
import { createSafeStatePaths } from "./lib/safe-state-paths.mjs";
import { runWithSharedWriteQueue } from "./lib/shared-write-queue.mjs";

export const PLATFORM_REGISTRY_RELATIVE_PATH = path.join("40-业务资产", "01-定位与公司说明", "平台账号注册表.md");
export const PLATFORM_ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

const accountSchema = z.object({
  id: z.string().regex(PLATFORM_ACCOUNT_ID_RE, "平台账号 ID 不安全"),
  currentFollowers: z.number().int().min(0).max(100_000_000),
}).strict();

export const platformFollowersInputSchema = z.array(accountSchema).min(1, "至少需要 1 个平台账号").max(20, "平台账号不能超过 20 个").superRefine((items, context) => {
  const ids = new Set(items.map((item) => item.id));
  if (ids.size !== items.length) context.addIssue({ code: "custom", message: "平台账号不能重复" });
});

export class PlatformFollowersValidationError extends Error {}
export class PlatformFollowersSecurityError extends Error {}
export class PlatformFollowersConflictError extends Error {
  constructor(current) {
    super("平台粉丝数据已被外部修改，请加载最新版本");
    this.current = current;
  }
}
export class PlatformFollowersCommitError extends Error {
  constructor(message, { cause, rollbackError } = {}) {
    super(message, { cause });
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
  if (!normalized.startsWith("---\n")) throw new PlatformFollowersValidationError("账号注册表缺少 frontmatter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) throw new PlatformFollowersValidationError("账号注册表 frontmatter 未闭合");
  let frontmatter;
  try {
    frontmatter = parseYaml(normalized.slice(4, end)) ?? {};
  } catch (error) {
    throw new PlatformFollowersValidationError("账号注册表 frontmatter 无法解析", { cause: error });
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new PlatformFollowersValidationError("账号注册表 frontmatter 必须是对象");
  }
  return { frontmatter, body: normalized.slice(end + 5) };
}

function cells(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((value) => value.trim());
}

function parseRegistry(markdown) {
  const { frontmatter, body } = splitFrontmatter(markdown);
  if (frontmatter.confirmation !== "已确认") throw new PlatformFollowersValidationError("账号注册表必须经过确认");
  if (frontmatter.sensitivity === "敏感") throw new PlatformFollowersSecurityError("敏感账号注册表不会同步到驾驶舱");
  const lines = body.split("\n");
  const headerIndex = lines.findIndex((line) => /^\s*\|/.test(line) && cells(line).includes("account_id"));
  if (headerIndex === -1 || headerIndex + 2 >= lines.length) throw new PlatformFollowersValidationError("账号注册表缺少账号表格");
  const headers = cells(lines[headerIndex]);
  const idIndex = headers.indexOf("account_id");
  const followersIndex = headers.indexOf("current_followers");
  const asOfIndex = headers.indexOf("as_of");
  if ([idIndex, followersIndex, asOfIndex].some((index) => index < 0)) {
    throw new PlatformFollowersValidationError("账号注册表缺少粉丝字段");
  }
  const rows = [];
  for (let index = headerIndex + 2; index < lines.length && /^\s*\|/.test(lines[index]); index += 1) {
    const row = cells(lines[index]);
    const followers = Number(row[followersIndex]?.replace(/,/g, ""));
    rows.push({ index, row, id: row[idIndex], currentFollowers: followers, asOf: row[asOfIndex] });
  }
  const parsed = platformFollowersInputSchema.safeParse(rows.map((row) => ({ id: row.id, currentFollowers: row.currentFollowers })));
  if (!parsed.success) throw new PlatformFollowersValidationError("账号注册表包含无效粉丝数据", { cause: parsed.error });
  return { lines, rows, followersIndex, asOfIndex, accounts: parsed.data };
}

function serializeRegistry(markdown, accounts, date) {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const parsed = parseRegistry(markdown);
  const values = new Map(accounts.map((account) => [account.id, account.currentFollowers]));
  for (const item of parsed.rows) {
    item.row[parsed.followersIndex] = String(values.get(item.id));
    item.row[parsed.asOfIndex] = date;
    parsed.lines[item.index] = `| ${item.row.join(" | ")} |`;
  }
  const total = accounts.reduce((sum, account) => sum + account.currentFollowers, 0);
  const updatedBody = parsed.lines.join("\n").replace(/\*\*当前粉丝合计：[\d,]+\*\*/, `**当前粉丝合计：${total.toLocaleString("en-US")}**`);
  frontmatter.updated_at = date;
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n${updatedBody}`;
}

function assertSameAccountIds(submittedAccounts, currentAccounts) {
  const submittedIds = new Set(submittedAccounts.map((account) => account.id));
  const currentIds = new Set(currentAccounts.map((account) => account.id));
  if (
    submittedIds.size !== currentIds.size
    || [...currentIds].some((id) => !submittedIds.has(id))
  ) {
    throw new PlatformFollowersValidationError("平台账号集合必须与当前注册表一致，不能通过粉丝写回接口增删账号");
  }
}

function assertInsideRoot(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new PlatformFollowersSecurityError("平台账号路径超出 V2 白名单");
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
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new PlatformFollowersSecurityError("V2 根目录不存在或为软链接");
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) throw new PlatformFollowersSecurityError("平台账号文件路径不存在");
    if (stat.isSymbolicLink()) throw new PlatformFollowersSecurityError("平台账号路径不能包含软链接");
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
    const current = await lstatOrNull(filePath);
    if (!current?.isFile() || current.isSymbolicLink()) throw new PlatformFollowersSecurityError("平台账号注册表不是普通文件");
    await fs.rename(tempPath, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

export function createPlatformFollowersStore(options = {}) {
  const root = path.resolve(options.root ?? process.env.V2_VAULT_ROOT ?? process.env.OBSIDIAN_VAULT_ROOT ?? path.join(os.homedir(), "第二大脑-v2"));
  const stateRoot = path.resolve(options.stateRoot ?? process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"));
  const filePath = path.resolve(root, PLATFORM_REGISTRY_RELATIVE_PATH);
  const backupRoot = path.join(stateRoot, "backups", "platform-followers");
  const now = options.now ?? (() => new Date());
  const afterWrite = options.afterWrite;
  const safeState = createSafeStatePaths({
    stateRoot,
    label: "平台粉丝状态",
    createSecurityError: (message) => new PlatformFollowersSecurityError(message),
  });
  assertInsideRoot(root, filePath);

  async function read() {
    await assertNoSymlinks(root, filePath);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PlatformFollowersSecurityError("平台账号注册表不是普通文件");
    if (stat.size > 256 * 1024) throw new PlatformFollowersSecurityError("平台账号注册表超过 256KB");
    const contents = await fs.readFile(filePath, "utf8");
    if (hasSecret(contents)) throw new PlatformFollowersSecurityError("账号注册表包含疑似密钥或凭证，已停止同步");
    const parsed = parseRegistry(contents);
    return { accounts: parsed.rows.map((row) => ({ id: row.id, currentFollowers: row.currentFollowers, asOf: row.asOf })), hash: sha256(contents), updatedAt: stat.mtime.toISOString() };
  }

  async function writeUnlocked(accounts, expectedHash) {
    const validated = platformFollowersInputSchema.safeParse(accounts);
    if (!validated.success) throw new PlatformFollowersValidationError("平台粉丝数据无效", { cause: validated.error });
    if (typeof expectedHash !== "string" || !HASH_RE.test(expectedHash)) throw new PlatformFollowersValidationError("expectedHash 无效");
    await safeState.ensureRoot();
    const current = await read();
    if (current.hash !== expectedHash) throw new PlatformFollowersConflictError(current);
    assertSameAccountIds(validated.data, current.accounts);
    const previousContents = await fs.readFile(filePath, "utf8");
    const stamp = now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
    const backupPath = path.join(backupRoot, `${stamp}-${current.hash.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}.md`);
    await safeState.writeNewFile(backupPath, previousContents);
    const latest = await read();
    if (latest.hash !== current.hash) throw new PlatformFollowersConflictError(latest);
    const contents = serializeRegistry(previousContents, validated.data, shanghaiDate(now()));
    await atomicWrite(filePath, contents, root);
    const writtenHash = sha256(contents);
    try {
      await afterWrite?.({ root });
      return await read();
    } catch (error) {
      let rollbackError;
      try {
        const beforeRollback = await read();
        if (beforeRollback.hash !== writtenHash) throw new PlatformFollowersConflictError(beforeRollback);
        await atomicWrite(filePath, previousContents, root);
        await afterWrite?.({ root, rollback: true });
      } catch (rollback) {
        rollbackError = rollback;
      }
      throw new PlatformFollowersCommitError("平台粉丝保存后的校验失败，已尝试恢复旧版本", { cause: error, rollbackError });
    }
  }

  function write(accounts, expectedHash) {
    return runWithSharedWriteQueue(
      filePath,
      () => writeUnlocked(accounts, expectedHash),
    );
  }

  return { read, write, filePath };
}
