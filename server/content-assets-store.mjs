import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hasSecret, isFullIsoTimestamp, isHttpsUrl } from "../scripts/lib/security.mjs";
import { readCockpitSettingsSync } from "./cockpit-settings-store.mjs";
import { contentDeliveryPayloadHash } from "./lib/ai-delivery-integrity.mjs";
import { createSafeStatePaths } from "./lib/safe-state-paths.mjs";
import { runWithSharedWriteQueue } from "./lib/shared-write-queue.mjs";

export const CONTENT_ASSETS_RELATIVE_DIR = path.join("30-内容资产");
export const CONTENT_INBOX_RELATIVE_DIR = path.join("30-内容资产", "00-选题池");

export const CONTENT_STATUSES = [
  "候选选题",
  "已立项",
  "待发布",
  "已发布",
  "待复盘",
  "已归档",
];
export const CONTENT_FORMATS = ["文章", "短视频口播", "图文卡片", "直播稿", "系列"];
export const CONTENT_PRIORITIES = ["P0", "P1", "P2", "P3"];
export const CONTENT_CHANNELS = ["公众号", "小红书", "抖音", "视频号", "B 站", "X"];
const VERIFIED_PUBLICATION_STATUSES = new Set(["已发布", "待复盘"]);
const CREATE_DISALLOWED_STATUSES = new Set([...VERIFIED_PUBLICATION_STATUSES, "已归档"]);

const HASH_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const CLIENT_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CLIENT_REQUEST_ALIASES = 8;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_URL_LENGTH = 2_048;
const MAX_EVIDENCE_REF_LENGTH = 300;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const DELIVERY_RUN_ID_RE = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const singleLineSchema = (label, max) => z
  .string()
  .trim()
  .min(1, `${label}不能为空`)
  .max(max, `${label}不能超过 ${max} 个字符`)
  .refine((value) => !/[\r\n\0]/.test(value), `${label}必须是单行文字`)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), `${label}包含控制字符`)
  .refine((value) => !/[<>]/.test(value), `${label}不能包含 HTML`)
  .refine((value) => !value.includes("---"), `${label}不能包含 frontmatter 分隔符`);

const titleSchema = singleLineSchema("标题", 160)
  .refine((value) => !value.includes("[[") && !value.includes("]]"), "标题不能包含 Obsidian 链接或嵌入");
const channelSchema = singleLineSchema("平台", 40)
  .transform((value) => value === "B站" ? "B 站" : value)
  .pipe(z.enum(CONTENT_CHANNELS));
const nextActionSchema = z.string().trim().max(300, "下一步不能超过 300 个字符")
  .refine((value) => !/[\r\n\0]/.test(value), "下一步必须是单行文字")
  .refine((value) => !/[<>]/.test(value), "下一步不能包含 HTML");
const dueAtSchema = z.union([
  z.string().regex(DATE_RE, "截止日期必须是 YYYY-MM-DD"),
  z.null(),
]);
const channelsSchema = z.array(channelSchema).max(12, "发布平台不能超过 12 个").superRefine((items, context) => {
  const normalized = items.map((item) => item.toLocaleLowerCase("zh-CN"));
  if (new Set(normalized).size !== items.length) {
    context.addIssue({ code: "custom", message: "发布平台不能重复" });
  }
});

const publicationUrlSchema = z.string().trim().min(1).max(MAX_URL_LENGTH, `发布链接不能超过 ${MAX_URL_LENGTH} 个字符`);
const evidenceRefSchema = z.string().trim().min(1).max(MAX_EVIDENCE_REF_LENGTH, `证据引用不能超过 ${MAX_EVIDENCE_REF_LENGTH} 个字符`);

export const contentPublicationInputSchema = z.object({
  platform: channelSchema,
  publishedAt: z.string().refine(isFullIsoTimestamp, "发布时间必须是完整 ISO 时间"),
  url: publicationUrlSchema.optional(),
  evidenceRef: evidenceRefSchema.optional(),
  confirmed: z.literal(true, { error: "登记发布前必须明确确认" }),
}).strict().superRefine((value, context) => {
  const evidenceCount = Number(Boolean(value.url?.trim())) + Number(Boolean(value.evidenceRef?.trim()));
  if (evidenceCount !== 1) {
    context.addIssue({ code: "custom", message: "发布链接与证据引用必须二选一" });
  }
});

export const contentAssetPatchSchema = z.object({
  status: z.enum(CONTENT_STATUSES).optional(),
  format: z.enum(CONTENT_FORMATS).optional(),
  channels: channelsSchema.optional(),
  priority: z.enum(CONTENT_PRIORITIES).nullable().optional(),
  dueAt: dueAtSchema.optional(),
  nextAction: nextActionSchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "至少需要修改一个字段");

export const contentAssetCreateSchema = z.object({
  title: titleSchema,
  summary: z.string().trim().max(4_000, "摘要不能超过 4000 个字符")
    .refine((value) => !value.includes("\0"), "摘要包含 NUL 字节")
    .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), "摘要包含控制字符")
    .refine((value) => !/<(?:script|style|iframe|object|embed)\b/i.test(value), "摘要不能包含可执行 HTML"),
  status: z.enum(CONTENT_STATUSES),
  format: z.enum(CONTENT_FORMATS),
  channels: channelsSchema,
  priority: z.enum(CONTENT_PRIORITIES).nullable(),
  dueAt: dueAtSchema,
  nextAction: nextActionSchema,
}).strict().refine((value) => !CREATE_DISALLOWED_STATUSES.has(value.status), {
  path: ["status"],
  message: "新建内容必须从选题或待发布阶段开始",
});

export class ContentAssetsValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "ContentAssetsValidationError";
  }
}

export class ContentAssetsSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContentAssetsSecurityError";
  }
}

export class ContentAssetsNotFoundError extends Error {
  constructor() {
    super("内容资产不存在或不允许由驾驶舱修改");
    this.name = "ContentAssetsNotFoundError";
  }
}

export class ContentAssetsConflictError extends Error {
  constructor(current) {
    super("内容资产已经在 Obsidian 中被修改，请加载最新内容后重试");
    this.name = "ContentAssetsConflictError";
    this.current = current;
  }
}

export class ContentAssetsCommitError extends Error {
  constructor(message, { cause, rollbackError } = {}) {
    super(message, { cause });
    this.name = "ContentAssetsCommitError";
    this.rollbackError = rollbackError;
  }
}

function normalizeDeliveryOptions(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentAssetsValidationError("AI 交付参数必须是对象");
  }
  const allowed = ["body", "sourceRun", "sourceTaskId", "requestHash", "payloadHash", "derivedFrom", "relatedAssets"];
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new ContentAssetsValidationError(`AI 交付参数包含未知字段：${unexpected.join("、")}`);
  if (!DELIVERY_RUN_ID_RE.test(value.sourceRun ?? "")) throw new ContentAssetsValidationError("sourceRun 无效");
  if (!SAFE_ID_RE.test(value.sourceTaskId ?? "")) throw new ContentAssetsValidationError("sourceTaskId 无效");
  if (!HASH_RE.test(value.requestHash ?? "")) throw new ContentAssetsValidationError("requestHash 无效");
  if (!HASH_RE.test(value.payloadHash ?? "")) throw new ContentAssetsValidationError("payloadHash 无效");
  if (typeof value.body !== "string" || !value.body.trim()) throw new ContentAssetsValidationError("AI 交付正文不能为空");
  if (Buffer.byteLength(value.body, "utf8") > 900 * 1024) throw new ContentAssetsValidationError("AI 交付正文超过安全上限");
  if (/\0|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value.body)) {
    throw new ContentAssetsValidationError("AI 交付正文包含控制字符");
  }
  if (/<(?:script|style|iframe|object|embed)\b/i.test(value.body)) {
    throw new ContentAssetsValidationError("AI 交付正文不能包含可执行 HTML");
  }
  if (hasSecret(value.body)) throw new ContentAssetsValidationError("AI 交付正文疑似包含密钥或凭证，请先脱敏");
  const normalizeRelations = (items, label) => {
    if (!Array.isArray(items) || items.length > 20) throw new ContentAssetsValidationError(`${label} 必须是最多 20 项的数组`);
    return items.map((item) => {
      if (
        typeof item !== "string"
        || item.length < 5
        || item.length > 300
        || !/^\[\[[^\]\\\r\n]+\]\]$/.test(item)
        || item.includes("..")
      ) {
        throw new ContentAssetsValidationError(`${label} 包含无效关系`);
      }
      return item;
    });
  };
  return {
    body: value.body.trim(),
    sourceRun: value.sourceRun,
    sourceTaskId: value.sourceTaskId,
    requestHash: value.requestHash,
    payloadHash: value.payloadHash,
    derivedFrom: normalizeRelations(value.derivedFrom ?? [], "derivedFrom"),
    relatedAssets: normalizeRelations(value.relatedAssets ?? [], "relatedAssets"),
  };
}

function normalizeCreateOptions(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContentAssetsValidationError("新增内容请求参数必须是对象");
  }
  if (Object.keys(value).some((key) => key !== "clientRequestId")) {
    throw new ContentAssetsValidationError("新增内容请求参数包含未知字段");
  }
  if (typeof value.clientRequestId !== "string" || !CLIENT_REQUEST_ID_RE.test(value.clientRequestId)) {
    throw new ContentAssetsValidationError("clientRequestId 无效");
  }
  return { clientRequestId: value.clientRequestId.toLowerCase() };
}

function validateClientRequestMetadata(frontmatter, id) {
  const primary = frontmatter.client_request_id;
  if (primary !== undefined && !CLIENT_REQUEST_ID_RE.test(primary ?? "")) {
    throw new ContentAssetsValidationError(`内容资产 ${id} 的客户端请求编号无效`);
  }
  const aliases = frontmatter.client_request_aliases;
  if (aliases !== undefined) {
    if (
      !Array.isArray(aliases)
      || aliases.length > MAX_CLIENT_REQUEST_ALIASES
      || aliases.some((value) => typeof value !== "string" || !CLIENT_REQUEST_ID_RE.test(value))
    ) {
      throw new ContentAssetsValidationError(`内容资产 ${id} 的客户端请求别名无效`);
    }
    if (aliases.length > 0 && primary === undefined) {
      throw new ContentAssetsValidationError(`内容资产 ${id} 的客户端请求别名缺少主编号`);
    }
  }
  const ids = [primary, ...(aliases ?? [])]
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase());
  if (new Set(ids).size !== ids.length) {
    throw new ContentAssetsValidationError(`内容资产 ${id} 的客户端请求编号重复`);
  }
}

function clientRequestIds(frontmatter) {
  return [frontmatter.client_request_id, ...(frontmatter.client_request_aliases ?? [])]
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase());
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

function assertInsideRoot(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new ContentAssetsSecurityError("目标路径超出内容资产白名单目录");
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinks(root, target, { allowMissing = false } = {}) {
  assertInsideRoot(root, target);
  const rootStat = await lstatOrNull(root);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ContentAssetsSecurityError("V2 根目录不存在、不是目录或为软链接");
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) {
      if (allowMissing) continue;
      throw new ContentAssetsSecurityError("内容资产路径不存在");
    }
    if (stat.isSymbolicLink()) throw new ContentAssetsSecurityError("内容资产路径不能包含软链接");
  }
}

function splitFrontmatter(markdown) {
  if (typeof markdown !== "string" || markdown.includes("\0")) {
    throw new ContentAssetsValidationError("内容资产必须是无 NUL 字节的文本");
  }
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) throw new ContentAssetsValidationError("内容资产 frontmatter 缺失或未闭合");
  let frontmatter;
  try {
    frontmatter = parseYaml(match[1], { maxAliasCount: 100 }) ?? {};
  } catch (error) {
    throw new ContentAssetsValidationError("内容资产 frontmatter 无法解析", error);
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new ContentAssetsValidationError("内容资产 frontmatter 必须是对象");
  }
  return { frontmatter, bodySuffix: markdown.slice(match[0].length) };
}

function firstHeading(bodySuffix) {
  const match = bodySuffix.match(/^#\s+(.+?)\s*$/m);
  if (!match) throw new ContentAssetsValidationError("内容资产正文缺少一级标题");
  return titleSchema.parse(match[1]);
}

function deliveryBody(bodySuffix) {
  const normalized = bodySuffix.trim();
  const match = normalized.match(/^# [^\r\n]+\r?\n(?:\r?\n)?([\s\S]*)$/);
  if (!match) throw new ContentAssetsValidationError("AI 内容资产正文结构无效");
  return match[1].trim();
}

function contentCreatePayloadHash(value) {
  return sha256(JSON.stringify({
    title: value.title,
    summary: value.summary || "待补充内容摘要。",
    status: value.status,
    format: value.format,
    channels: value.channels,
    priority: value.priority,
    dueAt: value.dueAt,
    nextAction: value.nextAction,
  }));
}

function contentSnapshotCreatePayloadHash(snapshot) {
  return contentCreatePayloadHash({
    title: snapshot.title,
    summary: deliveryBody(snapshot.bodySuffix),
    status: snapshot.status,
    format: snapshot.format,
    channels: snapshot.channels,
    priority: snapshot.priority,
    dueAt: snapshot.dueAt,
    nextAction: snapshot.nextAction,
  });
}

function normalizeFormat(value) {
  if (value === "短视频") return "短视频口播";
  const parsed = z.enum(CONTENT_FORMATS).safeParse(value);
  if (!parsed.success) throw new ContentAssetsValidationError("内容形态无效", parsed.error);
  return parsed.data;
}

function normalizeNullableDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = dueAtSchema.safeParse(value);
  if (!parsed.success) throw new ContentAssetsValidationError("截止日期无效", parsed.error);
  return parsed.data;
}

function serializeWithFrontmatter(frontmatter, bodySuffix) {
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---${bodySuffix}`;
}

function normalizePublicationUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || !isHttpsUrl(value.trim())) {
    throw new ContentAssetsValidationError("发布链接必须是安全的 https URL");
  }
  const url = new URL(value.trim());
  if (url.username || url.password) {
    throw new ContentAssetsValidationError("发布链接不能包含用户名或密码");
  }
  url.hash = "";
  return url.toString();
}

function normalizeEvidenceReference(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ContentAssetsValidationError("证据引用必须是文字");
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.length > MAX_EVIDENCE_REF_LENGTH
    || /[\r\n\0<>]/.test(trimmed)
    || !/^\[\[[^\[\]]+\]\]$/.test(trimmed)
    || trimmed.startsWith("![[")
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(trimmed.slice(2, -2))
    || /^\[\[\s*[\\/]/.test(trimmed)
    || /\b(?:javascript|data|file|vbscript):/i.test(trimmed)
  ) {
    throw new ContentAssetsValidationError("证据引用必须是安全的 Obsidian 双链");
  }
  return trimmed;
}

function normalizeCompletedAt(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!isFullIsoTimestamp(value)) throw new ContentAssetsValidationError("completed_at 必须是完整 ISO 时间");
  return value;
}

function publicationRecordId(record) {
  if (typeof record.id === "string" && SAFE_ID_RE.test(record.id)) return record.id;
  return `legacy-${sha256(JSON.stringify([
    record.platform ?? null,
    record.published_at ?? null,
    record.url ?? null,
    record.evidence_ref ?? null,
  ])).slice(0, 24)}`;
}

function normalizePublicationRecord(record, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new ContentAssetsValidationError(`published_records[${index}] 必须是对象`);
  }
  const platform = channelSchema.safeParse(record.platform);
  if (!platform.success) throw new ContentAssetsValidationError(`published_records[${index}] 的平台无效`, platform.error);
  const publishedAt = record.published_at === undefined || record.published_at === null || record.published_at === ""
    ? null
    : typeof record.published_at === "string" ? record.published_at : null;
  const url = normalizePublicationUrl(record.url);
  const evidenceRef = normalizeEvidenceReference(record.evidence_ref);
  const verified = record.verification === "已核验"
    && isFullIsoTimestamp(publishedAt)
    && Boolean(url || evidenceRef);
  return {
    id: publicationRecordId(record),
    platform: platform.data,
    publishedAt,
    url,
    evidenceRef,
    verification: verified ? "已核验" : "待核验",
  };
}

function normalizePublicationRecords(records) {
  if (records === undefined || records === null) return [];
  if (!Array.isArray(records)) throw new ContentAssetsValidationError("published_records 必须是数组");
  const normalized = records.map(normalizePublicationRecord);
  const ids = new Set();
  for (const [index, record] of normalized.entries()) {
    if (ids.has(record.id)) throw new ContentAssetsValidationError(`published_records[${index}] 的 id 重复`);
    ids.add(record.id);
  }
  return normalized;
}

function publicationFingerprint({ platform, publishedAt, url, evidenceRef }) {
  if (url) return `url:${url}`;
  return `evidence:${evidenceRef}`;
}

function hasVerifiedPublicationRecord(records) {
  return Array.isArray(records) && records.some((record) => record
    && typeof record === "object"
    && !Array.isArray(record)
    && record.verification === "已核验"
    && typeof record.published_at === "string"
    && isFullIsoTimestamp(record.published_at)
    && (
      isHttpsUrl(record.url)
      || (typeof record.evidence_ref === "string" && record.evidence_ref.trim().length > 0)
    ));
}

function snapshotFrom({ filePath, contents, stat, contentRoot }) {
  const { frontmatter, bodySuffix } = splitFrontmatter(contents);
  if (frontmatter.confirmation !== "已确认" || frontmatter.sensitivity === "敏感" || hasSecret(contents)) return null;
  const id = typeof frontmatter.id === "string" ? frontmatter.id : "";
  if (!SAFE_ID_RE.test(id)) throw new ContentAssetsValidationError("内容资产 id 缺失或不安全");
  const status = z.enum(CONTENT_STATUSES).safeParse(frontmatter.status);
  if (!status.success) throw new ContentAssetsValidationError(`内容资产 ${id} 的状态无效`, status.error);
  const channels = channelsSchema.safeParse(frontmatter.channels ?? []);
  if (!channels.success) throw new ContentAssetsValidationError(`内容资产 ${id} 的平台字段无效`, channels.error);
  const priority = frontmatter.priority === undefined ? null : frontmatter.priority;
  if (priority !== null && !CONTENT_PRIORITIES.includes(priority)) {
    throw new ContentAssetsValidationError(`内容资产 ${id} 的优先级无效`);
  }
  const updatedAt = typeof frontmatter.updated_at === "string" ? frontmatter.updated_at : stat.mtime.toISOString();
  const nextAction = nextActionSchema.safeParse(frontmatter.next_action ?? "");
  if (!nextAction.success) throw new ContentAssetsValidationError(`内容资产 ${id} 的下一步无效`, nextAction.error);
  const completedAt = normalizeCompletedAt(frontmatter.completed_at);
  const publicationRecords = normalizePublicationRecords(frontmatter.published_records);
  if (frontmatter.source_run !== undefined) {
    const derivedFrom = frontmatter.derived_from;
    const relatedAssets = frontmatter.related_assets;
    const validLinks = (items) => Array.isArray(items) && items.length > 0 && items.every((item) => (
      typeof item === "string"
      && /^\[\[[^\]\\\r\n]+\]\]$/.test(item)
      && !item.includes("..")
    ));
    if (
      !DELIVERY_RUN_ID_RE.test(frontmatter.source_run ?? "")
      || !SAFE_ID_RE.test(frontmatter.source_task_id ?? "")
      || !HASH_RE.test(frontmatter.delivery_request_hash ?? "")
      || !HASH_RE.test(frontmatter.delivery_payload_hash ?? "")
      || !validLinks(derivedFrom)
      || !validLinks(relatedAssets)
    ) {
      throw new ContentAssetsValidationError(`内容资产 ${id} 的 AI 交付来源无效`);
    }
  }
  if (frontmatter.create_request_hash !== undefined && !HASH_RE.test(frontmatter.create_request_hash ?? "")) {
    throw new ContentAssetsValidationError(`内容资产 ${id} 的创建请求哈希无效`);
  }
  validateClientRequestMetadata(frontmatter, id);
  return {
    id,
    title: firstHeading(bodySuffix),
    status: status.data,
    format: normalizeFormat(frontmatter.format),
    channels: channels.data,
    priority,
    dueAt: normalizeNullableDate(frontmatter.due_at),
    nextAction: nextAction.data,
    completedAt,
    publicationRecords,
    hash: sha256(contents),
    updatedAt,
    filePath,
    relativePath: path.relative(contentRoot, filePath),
    frontmatter,
    bodySuffix,
  };
}

function toPublicSnapshot(snapshot) {
  const { filePath: _filePath, relativePath: _relativePath, frontmatter: _frontmatter, bodySuffix: _bodySuffix, ...publicValue } = snapshot;
  return publicValue;
}

async function readFileSnapshot(filePath, { root, contentRoot }) {
  await assertNoSymlinks(root, filePath);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ContentAssetsSecurityError("内容资产不是普通文件");
  if (stat.size > MAX_FILE_BYTES) throw new ContentAssetsSecurityError("内容资产超过 1MB 安全上限");
  const contents = await fs.readFile(filePath, "utf8");
  return snapshotFrom({ filePath, contents, stat, contentRoot });
}

async function scanMarkdownFiles(directory, { root, contentRoot }) {
  await assertNoSymlinks(root, directory);
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(current, entry.name);
      assertInsideRoot(contentRoot, target);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(target);
    }
  }
  await walk(directory);
  return files.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

async function atomicWrite(filePath, contents, { root, expectedCurrentHash, createOnly = false }) {
  const parent = path.dirname(filePath);
  await assertNoSymlinks(root, parent);
  const existing = await lstatOrNull(filePath);
  if (existing?.isSymbolicLink()) throw new ContentAssetsSecurityError("内容资产文件不能是软链接");
  if (createOnly && existing) throw new ContentAssetsConflictError(null);
  if (!createOnly) {
    if (!existing?.isFile()) throw new ContentAssetsNotFoundError();
    const currentContents = await fs.readFile(filePath, "utf8");
    if (sha256(currentContents) !== expectedCurrentHash) throw new ContentAssetsConflictError(null);
  }

  const tempPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(tempPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertNoSymlinks(root, parent);
    if (createOnly) {
      await fs.link(tempPath, filePath);
      await fs.unlink(tempPath);
    } else {
      const currentContents = await fs.readFile(filePath, "utf8");
      if (sha256(currentContents) !== expectedCurrentHash) throw new ContentAssetsConflictError(null);
      await fs.rename(tempPath, filePath);
    }
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

function safeFilename(title, date) {
  const stem = title
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|#\[\]]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 72) || "新选题";
  return `${date}-${stem}-${crypto.randomUUID().slice(0, 8)}.md`;
}

export function createContentAssetsStore(options = {}) {
  const root = path.resolve(options.root ?? process.env.V2_VAULT_ROOT ?? process.env.OBSIDIAN_VAULT_ROOT ?? path.join(os.homedir(), "第二大脑-v2"));
  const stateRoot = path.resolve(options.stateRoot ?? process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"));
  const contentRoot = path.resolve(root, CONTENT_ASSETS_RELATIVE_DIR);
  const inboxRoot = path.resolve(root, CONTENT_INBOX_RELATIVE_DIR);
  const backupRoot = path.join(stateRoot, "backups", "content-assets");
  const auditPath = path.join(stateRoot, "audit", "content-assets.jsonl");
  const now = options.now ?? (() => new Date());
  const afterWrite = options.afterWrite;
  const safeState = createSafeStatePaths({
    stateRoot,
    label: "内容资产状态",
    createSecurityError: (message) => new ContentAssetsSecurityError(message),
  });

  assertInsideRoot(root, contentRoot);
  assertInsideRoot(contentRoot, inboxRoot);

  async function audit(event) {
    const safeEvent = {
      at: now().toISOString(),
      action: event.action,
      id: event.id,
      status: event.status,
      hash: event.hash?.slice(0, 12) ?? null,
    };
    await safeState.appendFile(auditPath, `${JSON.stringify(safeEvent)}\n`);
  }

  async function latestCreateAuditStatus(id) {
    const contents = await safeState.readFile(auditPath, { missing: "" });
    let latest = null;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event?.id === id && ["create", "create-recovered"].includes(event.action)) latest = event.status ?? null;
      } catch {
        // A malformed unrelated audit line never authorizes orphan recovery.
      }
    }
    return latest;
  }

  async function listInternal() {
    await assertNoSymlinks(root, contentRoot);
    const filePaths = await scanMarkdownFiles(contentRoot, { root, contentRoot });
    const snapshots = [];
    const seenIds = new Set();
    for (const filePath of filePaths) {
      const snapshot = await readFileSnapshot(filePath, { root, contentRoot });
      if (!snapshot) continue;
      if (seenIds.has(snapshot.id)) throw new ContentAssetsValidationError(`内容资产 id 重复: ${snapshot.id}`);
      seenIds.add(snapshot.id);
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  async function list() {
    const snapshots = await listInternal();
    return {
      items: snapshots.map(toPublicSnapshot),
      generatedAt: now().toISOString(),
    };
  }

  async function findById(id) {
    if (typeof id !== "string" || !SAFE_ID_RE.test(id)) throw new ContentAssetsValidationError("内容资产 id 不安全");
    const snapshots = await listInternal();
    const found = snapshots.find((item) => item.id === id);
    if (!found) throw new ContentAssetsNotFoundError();
    return found;
  }

  async function bindClientRequestId(snapshot, clientRequestId) {
    if (clientRequestIds(snapshot.frontmatter).includes(clientRequestId)) return snapshot;
    const primary = snapshot.frontmatter.client_request_id;
    const aliases = [...(snapshot.frontmatter.client_request_aliases ?? [])];
    const nextFrontmatter = { ...snapshot.frontmatter };
    if (primary === undefined) {
      nextFrontmatter.client_request_id = clientRequestId;
    } else {
      if (aliases.length >= MAX_CLIENT_REQUEST_ALIASES) {
        throw new ContentAssetsConflictError(toPublicSnapshot(snapshot));
      }
      aliases.push(clientRequestId);
      nextFrontmatter.client_request_aliases = aliases;
    }
    const contents = serializeWithFrontmatter(nextFrontmatter, snapshot.bodySuffix);
    await atomicWrite(snapshot.filePath, contents, { root, expectedCurrentHash: snapshot.hash });
    const rebound = await readFileSnapshot(snapshot.filePath, { root, contentRoot });
    if (!rebound) throw new ContentAssetsValidationError("恢复内容未通过请求编号映射校验");
    return rebound;
  }

  async function createUnlocked(input, deliveryOptions = null, createOptions = null) {
    const validated = contentAssetCreateSchema.safeParse(input);
    if (!validated.success) throw new ContentAssetsValidationError("新增内容字段无效", validated.error);
    if (hasSecret(JSON.stringify(validated.data))) {
      throw new ContentAssetsValidationError("新增内容疑似包含密钥或凭证，请先脱敏");
    }
    const delivery = normalizeDeliveryOptions(deliveryOptions);
    const createRequest = delivery ? null : normalizeCreateOptions(createOptions);
    if (delivery && validated.data.status !== "已立项") {
      throw new ContentAssetsValidationError("AI 内容草稿必须以已立项状态写入");
    }
    if (delivery && !["文章", "短视频口播"].includes(validated.data.format)) {
      throw new ContentAssetsValidationError("AI 内容草稿只支持文章或短视频");
    }
    if (delivery) {
      const expectedPayloadHash = contentDeliveryPayloadHash({
        title: validated.data.title,
        status: validated.data.status,
        format: validated.data.format,
        channels: validated.data.channels,
        priority: validated.data.priority,
        dueAt: validated.data.dueAt,
        nextAction: validated.data.nextAction,
        body: delivery.body,
        derivedFrom: delivery.derivedFrom,
        relatedAssets: delivery.relatedAssets,
        sourceRun: delivery.sourceRun,
        sourceTaskId: delivery.sourceTaskId,
        requestHash: delivery.requestHash,
      });
      if (expectedPayloadHash !== delivery.payloadHash) {
        throw new ContentAssetsValidationError("AI 内容交付载荷哈希不一致");
      }
    }
    await safeState.prepareAppendFile(auditPath);
    const createRequestHash = delivery ? null : contentCreatePayloadHash(validated.data);
    const contentRootExists = await lstatOrNull(contentRoot);
    let recoveryCandidate = null;
    if (createRequest && contentRootExists) {
      const requestMatches = (await listInternal())
        .filter((snapshot) => clientRequestIds(snapshot.frontmatter).includes(createRequest.clientRequestId));
      if (requestMatches.length > 1) throw new ContentAssetsConflictError(null);
      if (requestMatches.length === 1) {
        const [snapshot] = requestMatches;
        if (contentSnapshotCreatePayloadHash(snapshot) !== createRequestHash) {
          throw new ContentAssetsConflictError(toPublicSnapshot(snapshot));
        }
        if (await latestCreateAuditStatus(snapshot.id) === "success") {
          return toPublicSnapshot(snapshot);
        }
        recoveryCandidate = snapshot;
      }
    }
    if (createRequestHash) {
      const candidates = contentRootExists
        ? (await listInternal()).filter((snapshot) => snapshot.frontmatter.create_request_hash === createRequestHash)
        : [];
      const recovered = [];
      for (const snapshot of candidates) {
        if (await latestCreateAuditStatus(snapshot.id) === "orphan-preserved") recovered.push(snapshot);
      }
      if (!recoveryCandidate && recovered.length > 1) throw new ContentAssetsConflictError(null);
      if (!recoveryCandidate && recovered.length === 1) recoveryCandidate = recovered[0];
      if (recoveryCandidate) {
        let snapshot = recoveryCandidate;
        if (contentSnapshotCreatePayloadHash(snapshot) !== createRequestHash) {
          throw new ContentAssetsConflictError(toPublicSnapshot(snapshot));
        }
        if (createRequest) snapshot = await bindClientRequestId(snapshot, createRequest.clientRequestId);
        try {
          await afterWrite?.({ root, action: "create", id: snapshot.id, filePath: snapshot.filePath, recovered: true });
          await audit({ action: "create-recovered", id: snapshot.id, status: "success", hash: snapshot.hash });
          return toPublicSnapshot(snapshot);
        } catch (error) {
          await audit({ action: "create-recovered", id: snapshot.id, status: "orphan-preserved", hash: snapshot.hash });
          throw new ContentAssetsCommitError(
            "数据校验仍未通过；已保留同一份新内容，修复索引后可用原请求重试认领",
            { cause: error },
          );
        }
      }
    }
    const targetRoot = delivery
      ? path.resolve(contentRoot, validated.data.format === "文章" ? "01-文章" : "02-短视频口播")
      : inboxRoot;
    assertInsideRoot(contentRoot, targetRoot);
    await assertNoSymlinks(root, targetRoot, { allowMissing: true });
    await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
    await assertNoSymlinks(root, targetRoot);
    const date = shanghaiDate(now());
    const id = `content-${date.replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "")}`;
    const filePath = path.join(targetRoot, safeFilename(validated.data.title, date));
    assertInsideRoot(targetRoot, filePath);
    const frontmatter = {
      id,
      type: "内容资产",
      status: validated.data.status,
      created_at: date,
      updated_at: date,
      source: delivery ? "AI 协作交付" : "驾驶舱新增",
      topics: [],
      sensitivity: "内部",
      origin_owner: readCockpitSettingsSync(root).ownerName,
      processed_by: "人机协作",
      confirmation: "已确认",
      derived_from: delivery?.derivedFrom ?? [],
      related_assets: delivery?.relatedAssets ?? [],
      ...(!delivery ? { create_request_hash: createRequestHash } : {}),
      ...(createRequest ? { client_request_id: createRequest.clientRequestId } : {}),
      ...(delivery ? {
        source_run: delivery.sourceRun,
        source_task_id: delivery.sourceTaskId,
        delivery_request_hash: delivery.requestHash,
        delivery_payload_hash: delivery.payloadHash,
      } : {}),
      family_id: id,
      parent_id: null,
      format: validated.data.format,
      channels: validated.data.channels,
      completed_at: null,
      published_records: [],
      metric_refs: [],
      next_action: validated.data.nextAction,
      due_at: validated.data.dueAt,
      priority: validated.data.priority,
    };
    const summary = validated.data.summary || "待补充内容摘要。";
    const body = delivery?.body ?? summary;
    const contents = serializeWithFrontmatter(frontmatter, `\n\n# ${validated.data.title}\n\n${body}\n`);
    await atomicWrite(filePath, contents, { root, createOnly: true });
    const writtenHash = sha256(contents);

    try {
      await afterWrite?.({ root, action: "create", id, filePath });
      const snapshot = await readFileSnapshot(filePath, { root, contentRoot });
      if (!snapshot) throw new ContentAssetsValidationError("新增内容未通过可见性校验");
      await audit({ action: "create", id, status: "success", hash: snapshot.hash });
      return toPublicSnapshot(snapshot);
    } catch (error) {
      await audit({ action: "create", id, status: "orphan-preserved", hash: writtenHash });
      throw new ContentAssetsCommitError(
        "数据校验失败；为避免误删，新内容已保留，修复索引后可用原请求重试认领",
        { cause: error },
      );
    }
  }

  async function currentForWrite(id, expectedHash, action) {
    if (typeof expectedHash !== "string" || !HASH_RE.test(expectedHash)) {
      throw new ContentAssetsValidationError("expectedHash 必须是 64 位小写 SHA-256");
    }
    const current = await findById(id);
    if (current.hash !== expectedHash) {
      await audit({ action, id, status: "conflict", hash: current.hash });
      throw new ContentAssetsConflictError(toPublicSnapshot(current));
    }
    return current;
  }

  async function commitFrontmatter(current, frontmatter, action) {
    await safeState.prepareAppendFile(auditPath);
    const id = current.id;
    const previousContents = await fs.readFile(current.filePath, "utf8");
    if (sha256(previousContents) !== current.hash) throw new ContentAssetsConflictError(toPublicSnapshot(await findById(id)));
    const stamp = now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
    const backupPath = path.join(backupRoot, `${stamp}-${id}-${current.hash.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}.md`);
    await safeState.writeNewFile(backupPath, previousContents);

    const nextFrontmatter = { ...frontmatter, updated_at: shanghaiDate(now()) };
    const contents = serializeWithFrontmatter(nextFrontmatter, current.bodySuffix);
    await atomicWrite(current.filePath, contents, { root, expectedCurrentHash: current.hash });
    const writtenHash = sha256(contents);

    try {
      await afterWrite?.({ root, action, id, filePath: current.filePath });
      const snapshot = await findById(id);
      await audit({ action, id, status: "success", hash: snapshot.hash });
      return toPublicSnapshot(snapshot);
    } catch (error) {
      let rollbackError;
      try {
        const latest = await readFileSnapshot(current.filePath, { root, contentRoot });
        if (!latest || latest.hash !== writtenHash) throw new ContentAssetsConflictError(latest ? toPublicSnapshot(latest) : null);
        await atomicWrite(current.filePath, previousContents, { root, expectedCurrentHash: writtenHash });
        await afterWrite?.({ root, action, id, filePath: current.filePath, rollback: true });
      } catch (caught) {
        rollbackError = caught;
      }
      await audit({ action, id, status: rollbackError ? "rollback-failed" : "rolled-back", hash: current.hash });
      throw new ContentAssetsCommitError(
        rollbackError ? "数据校验失败，且内容资产未能完整回滚" : "数据校验失败，内容资产已恢复",
        { cause: error, rollbackError },
      );
    }
  }

  async function updateUnlocked(id, patch, expectedHash) {
    const parsedPatch = contentAssetPatchSchema.safeParse(patch);
    if (!parsedPatch.success) throw new ContentAssetsValidationError("内容修改字段无效", parsedPatch.error);
    if (hasSecret(JSON.stringify(parsedPatch.data))) {
      throw new ContentAssetsValidationError("内容修改疑似包含密钥或凭证，请先脱敏");
    }
    const current = await currentForWrite(id, expectedHash, "update");
    const hasVerifiedPublication = hasVerifiedPublicationRecord(current.frontmatter.published_records);
    if (parsedPatch.data.status && VERIFIED_PUBLICATION_STATUSES.has(parsedPatch.data.status) && !hasVerifiedPublication) {
      throw new ContentAssetsValidationError("进入已发布或待复盘前，需先在 Obsidian 补充已核验发布记录");
    }
    if (
      parsedPatch.data.status
      && parsedPatch.data.status !== "已归档"
      && !VERIFIED_PUBLICATION_STATUSES.has(parsedPatch.data.status)
      && hasVerifiedPublication
    ) {
      throw new ContentAssetsValidationError("已有核验发布记录的内容不能退回发布前状态");
    }
    const fm = { ...current.frontmatter };
    const fieldMap = {
      status: "status",
      format: "format",
      channels: "channels",
      priority: "priority",
      dueAt: "due_at",
      nextAction: "next_action",
    };
    for (const [key, value] of Object.entries(parsedPatch.data)) fm[fieldMap[key]] = value;
    return commitFrontmatter(current, fm, "update");
  }

  async function completeUnlocked(id, expectedHash) {
    const current = await currentForWrite(id, expectedHash, "complete");
    if (current.status === "已归档") {
      throw new ContentAssetsValidationError("归档内容需要先恢复，才能标记完成");
    }
    const fm = { ...current.frontmatter };
    if (!current.completedAt) fm.completed_at = now().toISOString();
    if (["候选选题", "已立项"].includes(current.status)) fm.status = "待发布";
    if (current.completedAt && fm.status === current.status) {
      await audit({ action: "complete", id, status: "duplicate", hash: current.hash });
      return toPublicSnapshot(current);
    }
    return commitFrontmatter(current, fm, "complete");
  }

  async function registerPublicationUnlocked(id, input, expectedHash) {
    const parsedInput = contentPublicationInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new ContentAssetsValidationError(parsedInput.error.issues[0]?.message ?? "发布登记字段无效", parsedInput.error);
    }
    if (hasSecret(JSON.stringify(parsedInput.data))) {
      throw new ContentAssetsValidationError("发布登记疑似包含密钥或凭证，请先脱敏");
    }
    const requestTime = now();
    if (Date.parse(parsedInput.data.publishedAt) > requestTime.getTime() + MAX_FUTURE_SKEW_MS) {
      throw new ContentAssetsValidationError("发布时间不能晚于当前时间 5 分钟以上");
    }
    const url = normalizePublicationUrl(parsedInput.data.url);
    const evidenceRef = normalizeEvidenceReference(parsedInput.data.evidenceRef);
    const current = await currentForWrite(id, expectedHash, "publish");
    if (current.status === "已归档") {
      throw new ContentAssetsValidationError("归档内容需要先恢复，才能登记发布");
    }
    const candidate = {
      platform: parsedInput.data.platform,
      publishedAt: parsedInput.data.publishedAt,
      url,
      evidenceRef,
    };
    const fingerprint = publicationFingerprint(candidate);
    const allContent = await listInternal();
    for (const content of allContent) {
      const duplicate = content.publicationRecords.some((record) => publicationFingerprint(record) === fingerprint);
      if (!duplicate) continue;
      await audit({ action: "publish", id, status: "duplicate", hash: current.hash });
      throw new ContentAssetsValidationError("该发布链接或证据已经登记，未重复写入");
    }

    const record = {
      id: `publication-${crypto.randomUUID().replaceAll("-", "")}`,
      platform: candidate.platform,
      published_at: candidate.publishedAt,
      ...(candidate.url ? { url: candidate.url } : { evidence_ref: candidate.evidenceRef }),
      verification: "已核验",
      verified_at: requestTime.toISOString(),
    };
    const fm = { ...current.frontmatter };
    fm.published_records = [...(Array.isArray(fm.published_records) ? fm.published_records : []), record];
    fm.completed_at = current.completedAt ?? candidate.publishedAt;
    fm.status = "已发布";
    const channels = channelsSchema.parse(fm.channels ?? []);
    if (!channels.includes(candidate.platform)) fm.channels = [...channels, candidate.platform];
    return commitFrontmatter(current, fm, "publish");
  }

  async function findBySourceRun(sourceRun) {
    if (!DELIVERY_RUN_ID_RE.test(sourceRun ?? "")) throw new ContentAssetsValidationError("sourceRun 无效");
    const matches = (await listInternal()).filter((snapshot) => snapshot.frontmatter.source_run === sourceRun);
    if (matches.length > 1) throw new ContentAssetsValidationError("同一 AI 任务产生了多个内容资产");
    if (!matches[0]) return null;
    const snapshot = matches[0];
    const currentPayloadHash = contentDeliveryPayloadHash({
      title: snapshot.title,
      status: snapshot.status,
      format: snapshot.format,
      channels: snapshot.channels,
      priority: snapshot.priority,
      dueAt: snapshot.dueAt,
      nextAction: snapshot.nextAction,
      body: deliveryBody(snapshot.bodySuffix),
      derivedFrom: snapshot.frontmatter.derived_from,
      relatedAssets: snapshot.frontmatter.related_assets,
      sourceRun: snapshot.frontmatter.source_run,
      sourceTaskId: snapshot.frontmatter.source_task_id,
      requestHash: snapshot.frontmatter.delivery_request_hash,
    });
    return {
      id: snapshot.id,
      title: snapshot.title,
      hash: snapshot.hash,
      requestHash: snapshot.frontmatter.delivery_request_hash ?? null,
      deliveryPayloadHash: snapshot.frontmatter.delivery_payload_hash ?? null,
      currentPayloadHash,
      targetRelativePath: path.relative(root, snapshot.filePath).split(path.sep).join("/"),
    };
  }

  function create(input, createOptions) {
    return runWithSharedWriteQueue(contentRoot, () => createUnlocked(input, null, createOptions));
  }

  function createDelivery(input, deliveryOptions) {
    return runWithSharedWriteQueue(contentRoot, () => createUnlocked(input, deliveryOptions));
  }

  function update(id, patch, expectedHash) {
    return runWithSharedWriteQueue(contentRoot, () => updateUnlocked(id, patch, expectedHash));
  }

  function complete(id, expectedHash) {
    return runWithSharedWriteQueue(contentRoot, () => completeUnlocked(id, expectedHash));
  }

  function registerPublication(id, input, expectedHash) {
    return runWithSharedWriteQueue(contentRoot, () => registerPublicationUnlocked(id, input, expectedHash));
  }

  return {
    list,
    findById,
    findBySourceRun,
    create,
    createDelivery,
    update,
    complete,
    registerPublication,
    root,
    contentRoot,
    inboxRoot,
  };
}
