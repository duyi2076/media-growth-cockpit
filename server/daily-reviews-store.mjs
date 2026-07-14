import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hasSecret, isFullIsoTimestamp } from "../scripts/lib/security.mjs";
import { readCockpitSettingsSync } from "./cockpit-settings-store.mjs";
import { runWithSharedWriteQueue } from "./lib/shared-write-queue.mjs";

export const DAILY_REVIEWS_RELATIVE_DIR = path.join("60-数据与看板", "05-经营看板", "每日复盘");
export const DAILY_REVIEW_CONFIRMATIONS = ["待人工确认", "已确认"];

const STATUS_BY_CONFIRMATION = {
  "待人工确认": "待确认",
  "已确认": "已确认",
};
const SECTION_FIELDS = [
  ["todayCompleted", "今日完成"],
  ["facts", "数据与事实"],
  ["effectiveActions", "有效动作"],
  ["problems", "问题"],
  ["judgment", "今日判断"],
  ["tomorrowAction", "明日最重要动作"],
];
const HASH_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^daily-review-\d{4}-\d{2}-\d{2}$/;
const CLIENT_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 1024 * 1024;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必须是 YYYY-MM-DD").refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "日期不是有效日历日期");

const markdownTextSchema = (label, max) => z.string().trim().max(max, `${label}不能超过 ${max} 个字符`)
  .refine((value) => !value.includes("\0"), `${label}包含 NUL 字节`)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), `${label}包含控制字符`)
  .refine((value) => !/^ {0,3}##[ \t]+/m.test(value), `${label}不能包含以“##”开头的 Markdown 标题`)
  .refine((value) => !/<(?:script|style|iframe|object|embed)\b/i.test(value), `${label}不能包含可执行 HTML`);

const fieldSchemas = {
  todayCompleted: markdownTextSchema("今日完成", 8_000),
  facts: markdownTextSchema("数据与事实", 8_000),
  effectiveActions: markdownTextSchema("有效动作", 8_000),
  problems: markdownTextSchema("问题", 8_000),
  judgment: markdownTextSchema("今日判断", 8_000),
  tomorrowAction: markdownTextSchema("明日最重要动作", 4_000),
};

export const dailyReviewCreateSchema = z.object({
  date: dateSchema,
  ...fieldSchemas,
}).strict();

export const dailyReviewPatchSchema = z.object({
  todayCompleted: fieldSchemas.todayCompleted.optional(),
  facts: fieldSchemas.facts.optional(),
  effectiveActions: fieldSchemas.effectiveActions.optional(),
  problems: fieldSchemas.problems.optional(),
  judgment: fieldSchemas.judgment.optional(),
  tomorrowAction: fieldSchemas.tomorrowAction.optional(),
  confirmation: z.enum(DAILY_REVIEW_CONFIRMATIONS).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "至少需要修改一个字段");

export class DailyReviewsValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "DailyReviewsValidationError";
  }
}

export class DailyReviewsSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "DailyReviewsSecurityError";
  }
}

export class DailyReviewsNotFoundError extends Error {
  constructor() {
    super("每日复盘不存在或不允许由驾驶舱修改");
    this.name = "DailyReviewsNotFoundError";
  }
}

export class DailyReviewsConflictError extends Error {
  constructor(current) {
    super("每日复盘已经在 Obsidian 中被修改，请加载最新内容后重试");
    this.name = "DailyReviewsConflictError";
    this.current = current;
  }
}

export class DailyReviewsCommitError extends Error {
  constructor(message, { cause, rollbackError } = {}) {
    super(message, { cause });
    this.name = "DailyReviewsCommitError";
    this.rollbackError = rollbackError;
  }
}

function normalizeCreateOptions(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DailyReviewsValidationError("新增每日复盘请求参数必须是对象");
  }
  if (Object.keys(value).some((key) => key !== "clientRequestId")) {
    throw new DailyReviewsValidationError("新增每日复盘请求参数包含未知字段");
  }
  if (typeof value.clientRequestId !== "string" || !CLIENT_REQUEST_ID_RE.test(value.clientRequestId)) {
    throw new DailyReviewsValidationError("clientRequestId 无效");
  }
  return { clientRequestId: value.clientRequestId.toLowerCase() };
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function dailyReviewCreatePayloadHash(value) {
  return sha256(JSON.stringify({
    date: value.date,
    todayCompleted: value.todayCompleted,
    facts: value.facts,
    effectiveActions: value.effectiveActions,
    problems: value.problems,
    judgment: value.judgment,
    tomorrowAction: value.tomorrowAction,
  }));
}

function dailyReviewSnapshotCreatePayloadHash(snapshot) {
  return dailyReviewCreatePayloadHash(snapshot);
}

function validateCreateRequestMetadata(frontmatter, id) {
  const clientRequestId = frontmatter.client_request_id;
  const createRequestHash = frontmatter.create_request_hash;
  if (clientRequestId === undefined && createRequestHash === undefined) return;
  if (
    typeof clientRequestId !== "string"
    || !CLIENT_REQUEST_ID_RE.test(clientRequestId)
    || typeof createRequestHash !== "string"
    || !HASH_RE.test(createRequestHash)
  ) {
    throw new DailyReviewsValidationError(`每日复盘 ${id} 的创建请求元数据无效`);
  }
}

function assertInsideRoot(root, target, message = "目标路径超出每日复盘白名单目录") {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new DailyReviewsSecurityError(message);
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureDirectoryTree(base, target, { create = false } = {}) {
  assertInsideRoot(base, target);
  let baseStat = await lstatOrNull(base);
  if (!baseStat && create) {
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    baseStat = await lstatOrNull(base);
  }
  if (!baseStat?.isDirectory() || baseStat.isSymbolicLink()) {
    throw new DailyReviewsSecurityError("根目录不存在、不是目录或为软链接");
  }
  let current = base;
  for (const segment of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat = await lstatOrNull(current);
    if (!stat && create) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      stat = await lstatOrNull(current);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new DailyReviewsSecurityError("每日复盘路径不能包含软链接或非目录节点");
    }
  }
}

function splitFrontmatter(markdown) {
  if (typeof markdown !== "string" || markdown.includes("\0")) {
    throw new DailyReviewsValidationError("每日复盘必须是无 NUL 字节的文本");
  }
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) throw new DailyReviewsValidationError("每日复盘 frontmatter 缺失或未闭合");
  let frontmatter;
  try {
    frontmatter = parseYaml(match[1], { maxAliasCount: 100 }) ?? {};
  } catch (error) {
    throw new DailyReviewsValidationError("每日复盘 frontmatter 无法解析", error);
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new DailyReviewsValidationError("每日复盘 frontmatter 必须是对象");
  }
  return { frontmatter, bodySuffix: markdown.slice(match[0].length) };
}

function assertSectionStructure(bodySuffix) {
  const headings = bodySuffix.split(/\r?\n/)
    .filter((line) => /^ {0,3}##[ \t]+/.test(line))
    .map((line) => line.replace(/^ {0,3}##[ \t]+/, "").trim());
  const expected = SECTION_FIELDS.map(([, heading]) => heading);
  if (headings.length !== expected.length || headings.some((heading, index) => heading !== expected[index])) {
    throw new DailyReviewsValidationError(`每日复盘只能包含“${expected.join("、")}”六个固定章节`);
  }
}

function sectionValue(bodySuffix, heading, schema) {
  const lines = bodySuffix.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) throw new DailyReviewsValidationError(`每日复盘正文缺少“${heading}”章节`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {0,3}##[ \t]+/.test(lines[index])) { end = index; break; }
  }
  const parsed = schema.safeParse(lines.slice(start + 1, end).join("\n").trim());
  if (!parsed.success) throw new DailyReviewsValidationError(`每日复盘“${heading}”章节无效`, parsed.error);
  return parsed.data;
}

function replaceSection(bodySuffix, heading, value) {
  const newline = bodySuffix.includes("\r\n") ? "\r\n" : "\n";
  const lines = bodySuffix.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) throw new DailyReviewsValidationError(`每日复盘正文缺少“${heading}”章节`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {0,3}##[ \t]+/.test(lines[index])) { end = index; break; }
  }
  while (end < lines.length && lines[end] === "") end += 1;
  return [...lines.slice(0, start), lines[start], "", ...value.split(/\r?\n/), "", ...lines.slice(end)].join(newline);
}

function serialize(frontmatter, bodySuffix) {
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---${bodySuffix}`;
}

function createBody(input) {
  const sections = SECTION_FIELDS.map(([field, heading]) => `## ${heading}\n\n${input[field]}`).join("\n\n");
  return `\n\n# ${input.date} 每日复盘\n\n${sections}\n`;
}

function assertCompleteForConfirmation(value) {
  const missing = SECTION_FIELDS.filter(([field]) => !value[field]?.trim()).map(([, heading]) => heading);
  if (value.confirmation === "已确认" && missing.length > 0) {
    throw new DailyReviewsValidationError(`确认每日复盘前请填写：${missing.join("、")}`);
  }
}

function snapshotFrom({ filePath, contents, stat, root }) {
  const { frontmatter, bodySuffix } = splitFrontmatter(contents);
  if (frontmatter.type !== "经营看板" || frontmatter.dashboard_kind !== "daily-review") return null;
  if (frontmatter.sensitivity === "敏感" || hasSecret(contents)) return null;
  if (frontmatter.sensitivity !== "内部") throw new DailyReviewsValidationError("每日复盘 sensitivity 必须是内部");
  const date = dateSchema.safeParse(frontmatter.date);
  if (!date.success) throw new DailyReviewsValidationError("每日复盘日期无效", date.error);
  const id = typeof frontmatter.id === "string" ? frontmatter.id : "";
  if (!SAFE_ID_RE.test(id) || id !== `daily-review-${date.data}`) {
    throw new DailyReviewsValidationError("每日复盘 id 与日期不一致");
  }
  const confirmation = z.enum(DAILY_REVIEW_CONFIRMATIONS).safeParse(frontmatter.confirmation);
  if (!confirmation.success) throw new DailyReviewsValidationError("每日复盘 confirmation 无效", confirmation.error);
  if (frontmatter.status !== STATUS_BY_CONFIRMATION[confirmation.data]) {
    throw new DailyReviewsValidationError("每日复盘 status 与 confirmation 不一致");
  }
  const confirmedAt = frontmatter.confirmed_at === null || frontmatter.confirmed_at === undefined
    ? null
    : frontmatter.confirmed_at;
  if (confirmation.data === "待人工确认" && confirmedAt !== null) {
    throw new DailyReviewsValidationError("待人工确认的每日复盘不能包含 confirmed_at");
  }
  if (confirmation.data === "已确认" && !isFullIsoTimestamp(confirmedAt)) {
    throw new DailyReviewsValidationError("已确认的每日复盘必须包含完整 confirmed_at");
  }
  assertSectionStructure(bodySuffix);
  const snapshot = {
    id,
    date: date.data,
    confirmation: confirmation.data,
    confirmedAt,
    hash: sha256(contents),
    updatedAt: typeof frontmatter.updated_at === "string" ? frontmatter.updated_at : stat.mtime.toISOString(),
    source: path.relative(root, filePath),
    filePath,
    frontmatter,
    bodySuffix,
  };
  for (const [field, heading] of SECTION_FIELDS) snapshot[field] = sectionValue(bodySuffix, heading, fieldSchemas[field]);
  validateCreateRequestMetadata(frontmatter, id);
  assertCompleteForConfirmation(snapshot);
  return snapshot;
}

function toPublicSnapshot(snapshot) {
  const { filePath: _filePath, frontmatter: _frontmatter, bodySuffix: _bodySuffix, ...publicValue } = snapshot;
  return publicValue;
}

async function readFileSnapshot(filePath, { root }) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DailyReviewsSecurityError("每日复盘不是普通文件");
  if (stat.size > MAX_FILE_BYTES) throw new DailyReviewsSecurityError("每日复盘超过 1MB 安全上限");
  return snapshotFrom({ filePath, contents: await fs.readFile(filePath, "utf8"), stat, root });
}

async function atomicWrite(filePath, contents, { root, expectedCurrentHash, createOnly = false }) {
  const parent = path.dirname(filePath);
  await ensureDirectoryTree(root, parent, { create: true });
  const existing = await lstatOrNull(filePath);
  if (existing?.isSymbolicLink()) throw new DailyReviewsSecurityError("每日复盘文件不能是软链接");
  if (createOnly && existing) throw new DailyReviewsConflictError(null);
  if (!createOnly) {
    if (!existing?.isFile()) throw new DailyReviewsNotFoundError();
    if (sha256(await fs.readFile(filePath, "utf8")) !== expectedCurrentHash) throw new DailyReviewsConflictError(null);
  }
  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (createOnly) {
      await fs.link(tempPath, filePath);
      await fs.unlink(tempPath);
    } else {
      if (sha256(await fs.readFile(filePath, "utf8")) !== expectedCurrentHash) throw new DailyReviewsConflictError(null);
      await fs.rename(tempPath, filePath);
    }
    const directoryHandle = await fs.open(parent, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

export function createDailyReviewsStore(options = {}) {
  const root = path.resolve(options.root ?? process.env.V2_VAULT_ROOT ?? process.env.OBSIDIAN_VAULT_ROOT ?? path.join(os.homedir(), "第二大脑-v2"));
  const stateRoot = path.resolve(options.stateRoot ?? process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"));
  const dailyReviewRoot = path.resolve(root, DAILY_REVIEWS_RELATIVE_DIR);
  const backupRoot = path.join(stateRoot, "backups", "daily-reviews");
  const auditPath = path.join(stateRoot, "audit", "daily-reviews.jsonl");
  const now = options.now ?? (() => new Date());
  const afterWrite = options.afterWrite;

  assertInsideRoot(root, dailyReviewRoot);
  assertInsideRoot(stateRoot, backupRoot);
  assertInsideRoot(stateRoot, auditPath);

  async function appendAudit(event) {
    await ensureDirectoryTree(stateRoot, path.dirname(auditPath), { create: true });
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(auditPath, flags, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new DailyReviewsSecurityError("每日复盘审计目标不是普通文件");
      await handle.writeFile(`${JSON.stringify({
        at: now().toISOString(),
        action: event.action,
        id: event.id,
        status: event.status,
        hash: event.hash?.slice(0, 12) ?? null,
      })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function latestCreateAuditStatus(id) {
    const stateRootStat = await lstatOrNull(stateRoot);
    if (!stateRootStat) return null;
    if (!stateRootStat.isDirectory() || stateRootStat.isSymbolicLink()) {
      throw new DailyReviewsSecurityError("每日复盘状态根目录不存在、不是目录或为软链接");
    }
    await ensureDirectoryTree(stateRoot, path.dirname(auditPath), { create: true });
    const existing = await lstatOrNull(auditPath);
    if (!existing) return null;
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size > 4 * 1024 * 1024) {
      throw new DailyReviewsSecurityError("每日复盘审计文件不能是软链接、非普通文件或超过安全上限");
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(auditPath, flags);
    let contents;
    try {
      contents = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    let latest = null;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.id === id && ["create", "create-recovered"].includes(event.action)) {
          latest = typeof event.status === "string" ? event.status : null;
        }
      } catch {
        // 无关的损坏审计行不能授权直接重放创建结果。
      }
    }
    return latest;
  }

  async function writeBackup(id, hash, contents) {
    await ensureDirectoryTree(stateRoot, backupRoot, { create: true });
    const stamp = now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
    const backupPath = path.join(backupRoot, `${stamp}-${id}-${hash.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}.md`);
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(backupPath, flags, 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function listInternal() {
    await ensureDirectoryTree(root, dailyReviewRoot, { create: true });
    const entries = await fs.readdir(dailyReviewRoot, { withFileTypes: true });
    const snapshots = [];
    const ids = new Set();
    const dates = new Set();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".md")) continue;
      const snapshot = await readFileSnapshot(path.join(dailyReviewRoot, entry.name), { root });
      if (!snapshot) continue;
      if (ids.has(snapshot.id) || dates.has(snapshot.date)) throw new DailyReviewsValidationError(`每日复盘日期重复: ${snapshot.date}`);
      ids.add(snapshot.id);
      dates.add(snapshot.date);
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  async function list() {
    return { items: (await listInternal()).map(toPublicSnapshot), generatedAt: now().toISOString() };
  }

  async function findById(id) {
    if (typeof id !== "string" || !SAFE_ID_RE.test(id)) throw new DailyReviewsValidationError("每日复盘 id 不安全");
    const found = (await listInternal()).find((item) => item.id === id);
    if (!found) throw new DailyReviewsNotFoundError();
    return found;
  }

  async function createUnlocked(input, createOptions = null) {
    const parsed = dailyReviewCreateSchema.safeParse(input);
    if (!parsed.success) throw new DailyReviewsValidationError("新增每日复盘字段无效", parsed.error);
    if (hasSecret(JSON.stringify(parsed.data))) throw new DailyReviewsValidationError("每日复盘疑似包含密钥或凭证，请先脱敏");
    const createRequest = normalizeCreateOptions(createOptions);
    const createRequestHash = dailyReviewCreatePayloadHash(parsed.data);
    const existingItems = await listInternal();
    let recoveryCandidate = null;
    if (createRequest) {
      const requestMatches = existingItems.filter((item) => item.frontmatter.client_request_id?.toLowerCase() === createRequest.clientRequestId);
      if (requestMatches.length > 1) throw new DailyReviewsConflictError(null);
      if (requestMatches.length === 1) {
        const [current] = requestMatches;
        if (dailyReviewSnapshotCreatePayloadHash(current) !== createRequestHash) {
          throw new DailyReviewsConflictError(toPublicSnapshot(current));
        }
        if (await latestCreateAuditStatus(current.id) === "success") return toPublicSnapshot(current);
        recoveryCandidate = current;
      }
    }
    if (recoveryCandidate) {
      try {
        await afterWrite?.({
          root,
          action: "create",
          id: recoveryCandidate.id,
          filePath: recoveryCandidate.filePath,
          recovered: true,
        });
        const recovered = await findById(recoveryCandidate.id);
        await appendAudit({ action: "create-recovered", id: recovered.id, status: "success", hash: recovered.hash });
        return toPublicSnapshot(recovered);
      } catch (error) {
        await appendAudit({
          action: "create-recovered",
          id: recoveryCandidate.id,
          status: "orphan-preserved",
          hash: recoveryCandidate.hash,
        });
        throw new DailyReviewsCommitError(
          "数据校验仍未通过；已保留同一份每日复盘，修复索引后可用原请求重试认领",
          { cause: error },
        );
      }
    }
    if (existingItems.some((item) => item.date === parsed.data.date)) {
      throw new DailyReviewsValidationError(`${parsed.data.date} 已经有每日复盘`);
    }
    const id = `daily-review-${parsed.data.date}`;
    const filePath = path.join(dailyReviewRoot, `${parsed.data.date}-每日复盘.md`);
    const timestamp = now().toISOString();
    const ownerName = readCockpitSettingsSync(root).ownerName;
    const frontmatter = {
      id,
      type: "经营看板",
      dashboard_kind: "daily-review",
      status: "待确认",
      date: parsed.data.date,
      created_at: timestamp,
      updated_at: timestamp,
      source: "驾驶舱新增",
      topics: ["每日复盘", "内容经营"],
      sensitivity: "内部",
      origin_owner: ownerName,
      processed_by: "人机协作",
      confirmation: "待人工确认",
      confirmed_at: null,
      ...(createRequest ? {
        client_request_id: createRequest.clientRequestId,
        create_request_hash: createRequestHash,
      } : {}),
    };
    const contents = serialize(frontmatter, createBody(parsed.data));
    await atomicWrite(filePath, contents, { root, createOnly: true });
    const writtenHash = sha256(contents);
    try {
      await afterWrite?.({ root, action: "create", id, filePath });
      const snapshot = await findById(id);
      await appendAudit({ action: "create", id, status: "success", hash: snapshot.hash });
      return toPublicSnapshot(snapshot);
    } catch (error) {
      let rollbackError;
      try {
        if (sha256(await fs.readFile(filePath, "utf8")) !== writtenHash) throw new DailyReviewsConflictError(null);
        await fs.unlink(filePath);
        await afterWrite?.({ root, action: "create", id, filePath, rollback: true });
      } catch (caught) { rollbackError = caught; }
      await appendAudit({ action: "create", id, status: rollbackError ? "rollback-failed" : "rolled-back", hash: writtenHash });
      throw new DailyReviewsCommitError(rollbackError ? "数据校验失败，且每日复盘未能完整回滚" : "数据校验失败，每日复盘已回滚", { cause: error, rollbackError });
    }
  }

  async function updateUnlocked(id, patch, expectedHash) {
    const parsed = dailyReviewPatchSchema.safeParse(patch);
    if (!parsed.success) throw new DailyReviewsValidationError("每日复盘修改字段无效", parsed.error);
    if (hasSecret(JSON.stringify(parsed.data))) throw new DailyReviewsValidationError("每日复盘修改疑似包含密钥或凭证，请先脱敏");
    if (typeof expectedHash !== "string" || !HASH_RE.test(expectedHash)) throw new DailyReviewsValidationError("expectedHash 必须是 64 位小写 SHA-256");
    const current = await findById(id);
    if (current.hash !== expectedHash) {
      await appendAudit({ action: "update", id, status: "conflict", hash: current.hash });
      throw new DailyReviewsConflictError(toPublicSnapshot(current));
    }
    const contentFields = SECTION_FIELDS.map(([field]) => field);
    const hasSubstantiveEdit = contentFields.some((field) => Object.hasOwn(parsed.data, field));
    const normalizedPatch = { ...parsed.data };
    if (hasSubstantiveEdit && current.confirmation === "已确认" && !Object.hasOwn(normalizedPatch, "confirmation")) {
      normalizedPatch.confirmation = "待人工确认";
    }
    const next = { ...toPublicSnapshot(current), ...normalizedPatch };
    assertCompleteForConfirmation(next);
    const previousContents = await fs.readFile(current.filePath, "utf8");
    if (sha256(previousContents) !== current.hash) throw new DailyReviewsConflictError(toPublicSnapshot(await findById(id)));
    await writeBackup(id, current.hash, previousContents);

    const fm = { ...current.frontmatter, updated_at: now().toISOString() };
    if (Object.hasOwn(normalizedPatch, "confirmation")) {
      fm.confirmation = normalizedPatch.confirmation;
      fm.status = STATUS_BY_CONFIRMATION[normalizedPatch.confirmation];
      if (normalizedPatch.confirmation === "待人工确认") fm.confirmed_at = null;
      else if (current.confirmation !== "已确认" || hasSubstantiveEdit) fm.confirmed_at = now().toISOString();
    }
    let bodySuffix = current.bodySuffix;
    for (const [field, heading] of SECTION_FIELDS) {
      if (Object.hasOwn(normalizedPatch, field)) bodySuffix = replaceSection(bodySuffix, heading, normalizedPatch[field]);
    }
    const contents = serialize(fm, bodySuffix);
    await atomicWrite(current.filePath, contents, { root, expectedCurrentHash: current.hash });
    const writtenHash = sha256(contents);
    try {
      await afterWrite?.({ root, action: "update", id, filePath: current.filePath });
      const snapshot = await findById(id);
      const action = current.confirmation !== "已确认" && snapshot.confirmation === "已确认"
        ? "confirm"
        : current.confirmation === "已确认" && snapshot.confirmation === "待人工确认"
          ? "reopen-after-edit"
          : "update";
      await appendAudit({ action, id, status: "success", hash: snapshot.hash });
      return toPublicSnapshot(snapshot);
    } catch (error) {
      let rollbackError;
      try {
        const latest = await readFileSnapshot(current.filePath, { root });
        if (!latest || latest.hash !== writtenHash) throw new DailyReviewsConflictError(latest ? toPublicSnapshot(latest) : null);
        await atomicWrite(current.filePath, previousContents, { root, expectedCurrentHash: writtenHash });
        await afterWrite?.({ root, action: "update", id, filePath: current.filePath, rollback: true });
      } catch (caught) { rollbackError = caught; }
      await appendAudit({ action: "update", id, status: rollbackError ? "rollback-failed" : "rolled-back", hash: current.hash });
      throw new DailyReviewsCommitError(rollbackError ? "数据校验失败，且每日复盘未能完整回滚" : "数据校验失败，每日复盘已恢复", { cause: error, rollbackError });
    }
  }

  function create(input, createOptions = null) {
    return runWithSharedWriteQueue(dailyReviewRoot, () => createUnlocked(input, createOptions));
  }

  function update(id, patch, expectedHash) {
    return runWithSharedWriteQueue(dailyReviewRoot, () => updateUnlocked(id, patch, expectedHash));
  }

  return { list, findById, create, update, root, dailyReviewRoot };
}
