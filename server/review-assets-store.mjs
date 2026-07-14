import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hasSecret, isFullIsoTimestamp } from "../scripts/lib/security.mjs";
import { readCockpitSettingsSync } from "./cockpit-settings-store.mjs";
import { CONTENT_ASSETS_RELATIVE_DIR } from "./content-assets-store.mjs";
import { reviewDeliveryPayloadHash } from "./lib/ai-delivery-integrity.mjs";
import { runWithSharedWriteQueue } from "./lib/shared-write-queue.mjs";

export const REVIEW_ASSETS_RELATIVE_DIR = path.join("20-知识资产", "03-复盘");
export const REVIEW_KINDS = ["content-review", "account-breakdown"];
export const REVIEW_CONFIRMATIONS = ["待人工确认", "已确认"];

const TOPIC_BY_KIND = {
  "content-review": "内容复盘",
  "account-breakdown": "账号拆解",
};
const STATUS_BY_CONFIRMATION = {
  "待人工确认": "待确认",
  "已确认": "已确认",
};
const HASH_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const CLIENT_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CLIENT_REQUEST_ALIASES = 8;
const MAX_FILE_BYTES = 1024 * 1024;
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
const nullablePlatformSchema = z.union([singleLineSchema("平台", 40), z.null()]);
const nullableContentIdSchema = z.union([
  z.string().trim().regex(SAFE_ID_RE, "关联内容 id 不安全"),
  z.null(),
]);
const nullableHttpsUrlSchema = z.union([
  z.string().trim().url("来源链接必须是有效 URL").superRefine((value, context) => {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "来源链接必须是有效 URL" });
      return;
    }
    if (parsed.protocol !== "https:") context.addIssue({ code: "custom", message: "来源链接必须使用 https" });
    if (parsed.username || parsed.password) context.addIssue({ code: "custom", message: "来源链接不能包含账号或密码" });
  }),
  z.null(),
]);

const markdownTextSchema = (label, max) => z
  .string()
  .trim()
  .max(max, `${label}不能超过 ${max} 个字符`)
  .refine((value) => !value.includes("\0"), `${label}包含 NUL 字节`)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), `${label}包含控制字符`)
  .refine(
    (value) => !/^ {0,3}##[ \t]+/m.test(value),
    `${label}不能包含以“##”开头的 Markdown 标题，请改用普通文字或项目符号`,
  )
  .refine((value) => !/<(?:script|style|iframe|object|embed)\b/i.test(value), `${label}不能包含可执行 HTML`);

const summarySchema = markdownTextSchema("摘要", 4_000);
const findingsSchema = markdownTextSchema("核心发现", 12_000);
const nextActionSchema = markdownTextSchema("下一步", 4_000);

function addRelationshipIssues(value, context) {
  if (value.kind === "content-review" && !value.relatedContentId && !value.sourceUrl) {
    context.addIssue({ code: "custom", path: ["relatedContentId"], message: "内容复盘必须关联内容或提供 https 来源链接" });
  }
  if (value.kind === "account-breakdown" && !value.sourceUrl) {
    context.addIssue({ code: "custom", path: ["sourceUrl"], message: "账号拆解必须提供 https 来源链接" });
  }
  if (value.kind === "account-breakdown" && value.relatedContentId) {
    context.addIssue({ code: "custom", path: ["relatedContentId"], message: "账号拆解不能关联内容资产" });
  }
}

export const reviewAssetCreateSchema = z.object({
  kind: z.enum(REVIEW_KINDS),
  title: titleSchema,
  sourceUrl: nullableHttpsUrlSchema,
  platform: nullablePlatformSchema,
  relatedContentId: nullableContentIdSchema,
  summary: summarySchema,
  findings: findingsSchema,
  nextAction: nextActionSchema,
}).strict().superRefine(addRelationshipIssues);

export const reviewAssetPatchSchema = z.object({
  title: titleSchema.optional(),
  sourceUrl: nullableHttpsUrlSchema.optional(),
  platform: nullablePlatformSchema.optional(),
  relatedContentId: nullableContentIdSchema.optional(),
  summary: summarySchema.optional(),
  findings: findingsSchema.optional(),
  nextAction: nextActionSchema.optional(),
  confirmation: z.enum(REVIEW_CONFIRMATIONS).optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, "至少需要修改一个字段");

export class ReviewAssetsValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "ReviewAssetsValidationError";
  }
}

export class ReviewAssetsSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReviewAssetsSecurityError";
  }
}

export class ReviewAssetsNotFoundError extends Error {
  constructor() {
    super("复盘资产不存在或不允许由驾驶舱修改");
    this.name = "ReviewAssetsNotFoundError";
  }
}

export class ReviewAssetsConflictError extends Error {
  constructor(current) {
    super("复盘资产已经在 Obsidian 中被修改，请加载最新内容后重试");
    this.name = "ReviewAssetsConflictError";
    this.current = current;
  }
}

export class ReviewAssetsCommitError extends Error {
  constructor(message, { cause, rollbackError } = {}) {
    super(message, { cause });
    this.name = "ReviewAssetsCommitError";
    this.rollbackError = rollbackError;
  }
}

function normalizeDeliveryOptions(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewAssetsValidationError("AI 交付参数必须是对象");
  }
  const allowed = ["sourceRun", "sourceTaskId", "requestHash", "payloadHash", "derivedFrom", "relatedAssets"];
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new ReviewAssetsValidationError(`AI 交付参数包含未知字段：${unexpected.join("、")}`);
  if (!DELIVERY_RUN_ID_RE.test(value.sourceRun ?? "")) throw new ReviewAssetsValidationError("sourceRun 无效");
  if (!SAFE_ID_RE.test(value.sourceTaskId ?? "")) throw new ReviewAssetsValidationError("sourceTaskId 无效");
  if (!HASH_RE.test(value.requestHash ?? "")) throw new ReviewAssetsValidationError("requestHash 无效");
  if (!HASH_RE.test(value.payloadHash ?? "")) throw new ReviewAssetsValidationError("payloadHash 无效");
  const normalizeRelations = (items, label) => {
    if (!Array.isArray(items) || items.length > 20) throw new ReviewAssetsValidationError(`${label} 必须是最多 20 项的数组`);
    return items.map((item) => {
      if (
        typeof item !== "string"
        || item.length < 5
        || item.length > 500
        || !/^\[\[[^\]\\\r\n]+\]\]$/.test(item)
        || item.includes("..")
      ) {
        throw new ReviewAssetsValidationError(`${label} 包含无效 Obsidian 关系`);
      }
      return item;
    });
  };
  return {
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
    throw new ReviewAssetsValidationError("新增复盘请求参数必须是对象");
  }
  if (Object.keys(value).some((key) => key !== "clientRequestId")) {
    throw new ReviewAssetsValidationError("新增复盘请求参数包含未知字段");
  }
  if (typeof value.clientRequestId !== "string" || !CLIENT_REQUEST_ID_RE.test(value.clientRequestId)) {
    throw new ReviewAssetsValidationError("clientRequestId 无效");
  }
  return { clientRequestId: value.clientRequestId.toLowerCase() };
}

function validateClientRequestMetadata(frontmatter, id) {
  const primary = frontmatter.client_request_id;
  if (primary !== undefined && !CLIENT_REQUEST_ID_RE.test(primary ?? "")) {
    throw new ReviewAssetsValidationError(`复盘资产 ${id} 的客户端请求编号无效`);
  }
  const aliases = frontmatter.client_request_aliases;
  if (aliases !== undefined) {
    if (
      !Array.isArray(aliases)
      || aliases.length > MAX_CLIENT_REQUEST_ALIASES
      || aliases.some((value) => typeof value !== "string" || !CLIENT_REQUEST_ID_RE.test(value))
    ) {
      throw new ReviewAssetsValidationError(`复盘资产 ${id} 的客户端请求别名无效`);
    }
    if (aliases.length > 0 && primary === undefined) {
      throw new ReviewAssetsValidationError(`复盘资产 ${id} 的客户端请求别名缺少主编号`);
    }
  }
  const ids = [primary, ...(aliases ?? [])]
    .filter((value) => typeof value === "string")
    .map((value) => value.toLowerCase());
  if (new Set(ids).size !== ids.length) {
    throw new ReviewAssetsValidationError(`复盘资产 ${id} 的客户端请求编号重复`);
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
  throw new ReviewAssetsSecurityError("目标路径超出复盘资产白名单目录");
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
    throw new ReviewAssetsSecurityError("V2 根目录不存在、不是目录或为软链接");
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstatOrNull(current);
    if (!stat) {
      if (allowMissing) continue;
      throw new ReviewAssetsSecurityError("复盘资产路径不存在");
    }
    if (stat.isSymbolicLink()) throw new ReviewAssetsSecurityError("复盘资产路径不能包含软链接");
  }
}

function splitFrontmatter(markdown) {
  if (typeof markdown !== "string" || markdown.includes("\0")) {
    throw new ReviewAssetsValidationError("复盘资产必须是无 NUL 字节的文本");
  }
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) throw new ReviewAssetsValidationError("复盘资产 frontmatter 缺失或未闭合");
  let frontmatter;
  try {
    frontmatter = parseYaml(match[1], { maxAliasCount: 100 }) ?? {};
  } catch (error) {
    throw new ReviewAssetsValidationError("复盘资产 frontmatter 无法解析", error);
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new ReviewAssetsValidationError("复盘资产 frontmatter 必须是对象");
  }
  return { frontmatter, bodySuffix: markdown.slice(match[0].length) };
}

function firstHeading(bodySuffix) {
  const match = bodySuffix.match(/^#\s+(.+?)\s*$/m);
  if (!match) throw new ReviewAssetsValidationError("复盘资产正文缺少一级标题");
  const parsed = titleSchema.safeParse(match[1]);
  if (!parsed.success) throw new ReviewAssetsValidationError("复盘资产标题无效", parsed.error);
  return parsed.data;
}

function assertFixedSectionStructure(bodySuffix) {
  const headings = bodySuffix
    .split(/\r?\n/)
    .filter((line) => /^ {0,3}##[ \t]+/.test(line))
    .map((line) => line.replace(/^ {0,3}##[ \t]+/, "").trim());
  const expected = ["摘要", "核心发现", "下一步"];
  if (headings.length !== expected.length || headings.some((heading, index) => heading !== expected[index])) {
    throw new ReviewAssetsValidationError("复盘资产只能包含“摘要、核心发现、下一步”三个固定二级章节");
  }
}

function sectionValue(bodySuffix, heading, schema) {
  const lines = bodySuffix.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) throw new ReviewAssetsValidationError(`复盘资产正文缺少“${heading}”章节`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {0,3}##[ \t]+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const parsed = schema.safeParse(lines.slice(start + 1, end).join("\n").trim());
  if (!parsed.success) throw new ReviewAssetsValidationError(`复盘资产“${heading}”章节无效`, parsed.error);
  return parsed.data;
}

function replaceSection(bodySuffix, heading, value) {
  const newline = bodySuffix.includes("\r\n") ? "\r\n" : "\n";
  const lines = bodySuffix.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) throw new ReviewAssetsValidationError(`复盘资产正文缺少“${heading}”章节`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {0,3}##[ \t]+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const replacement = [lines[start], "", ...value.split(/\r?\n/), ""];
  while (end < lines.length && lines[end] === "") end += 1;
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join(newline);
}

function replaceFirstHeading(bodySuffix, title) {
  const newline = bodySuffix.includes("\r\n") ? "\r\n" : "\n";
  const lines = bodySuffix.split(/\r?\n/);
  const index = lines.findIndex((line) => /^#\s+/.test(line));
  if (index === -1) throw new ReviewAssetsValidationError("复盘资产正文缺少一级标题");
  lines[index] = `# ${title}`;
  return lines.join(newline);
}

function normalizeNullable(value) {
  return value === undefined || value === "" ? null : value;
}

function validateConfirmedAt(frontmatter, confirmation, id) {
  const value = normalizeNullable(frontmatter.confirmed_at);
  if (value === null) return;
  if (confirmation !== "已确认") {
    throw new ReviewAssetsValidationError(`复盘资产 ${id} 尚未确认，不能包含 confirmed_at`);
  }
  if (!isFullIsoTimestamp(value)) {
    throw new ReviewAssetsValidationError(`复盘资产 ${id} 的 confirmed_at 必须是完整 ISO 时间`);
  }
}

function inferKind(frontmatter) {
  const explicit = z.enum(REVIEW_KINDS).safeParse(frontmatter.review_kind);
  if (explicit.success) return explicit.data;
  if (!Array.isArray(frontmatter.topics)) return null;
  if (frontmatter.topics.includes("账号拆解")) return "account-breakdown";
  if (frontmatter.topics.includes("内容复盘")) return "content-review";
  return null;
}

function validateRelationships(value) {
  const parsed = reviewAssetCreateSchema.safeParse({
    kind: value.kind,
    title: value.title,
    sourceUrl: value.sourceUrl,
    platform: value.platform,
    relatedContentId: value.relatedContentId,
    summary: value.summary,
    findings: value.findings,
    nextAction: value.nextAction,
  });
  if (!parsed.success) throw new ReviewAssetsValidationError("复盘资产字段无效", parsed.error);
  if (value.confirmation === "已确认" && (!value.findings.trim() || !value.nextAction.trim())) {
    throw new ReviewAssetsValidationError("确认复盘前必须填写核心发现和下一步");
  }
}

function serializeWithFrontmatter(frontmatter, bodySuffix) {
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---${bodySuffix}`;
}

function snapshotFrom({ filePath, contents, stat, root }) {
  const { frontmatter, bodySuffix } = splitFrontmatter(contents);
  if (frontmatter.type !== "复盘") return null;
  const kind = inferKind(frontmatter);
  if (!kind) return null;
  if (frontmatter.sensitivity === "敏感" || hasSecret(contents)) return null;
  if (frontmatter.sensitivity !== "内部") throw new ReviewAssetsValidationError("复盘资产 sensitivity 必须是内部");
  const confirmation = z.enum(REVIEW_CONFIRMATIONS).safeParse(frontmatter.confirmation);
  if (!confirmation.success) throw new ReviewAssetsValidationError("复盘资产 confirmation 无效", confirmation.error);
  if (frontmatter.status !== STATUS_BY_CONFIRMATION[confirmation.data]) {
    throw new ReviewAssetsValidationError("复盘资产 status 与 confirmation 不一致");
  }
  if (!Array.isArray(frontmatter.topics) || !frontmatter.topics.includes(TOPIC_BY_KIND[kind])) {
    throw new ReviewAssetsValidationError("复盘资产 topics 与 kind 不一致");
  }
  const id = typeof frontmatter.id === "string" ? frontmatter.id : "";
  if (!SAFE_ID_RE.test(id)) throw new ReviewAssetsValidationError("复盘资产 id 缺失或不安全");
  if (frontmatter.create_request_hash !== undefined && !HASH_RE.test(frontmatter.create_request_hash ?? "")) {
    throw new ReviewAssetsValidationError(`复盘资产 ${id} 的创建请求哈希无效`);
  }
  validateClientRequestMetadata(frontmatter, id);
  validateConfirmedAt(frontmatter, confirmation.data, id);
  assertFixedSectionStructure(bodySuffix);
  const sourceUrl = nullableHttpsUrlSchema.safeParse(normalizeNullable(frontmatter.source_url));
  if (!sourceUrl.success) throw new ReviewAssetsValidationError(`复盘资产 ${id} 的来源链接无效`, sourceUrl.error);
  const platform = nullablePlatformSchema.safeParse(normalizeNullable(frontmatter.platform));
  if (!platform.success) throw new ReviewAssetsValidationError(`复盘资产 ${id} 的平台无效`, platform.error);
  const relatedContentId = nullableContentIdSchema.safeParse(normalizeNullable(frontmatter.related_content_id));
  if (!relatedContentId.success) throw new ReviewAssetsValidationError(`复盘资产 ${id} 的关联内容无效`, relatedContentId.error);
  const snapshot = {
    id,
    kind,
    title: firstHeading(bodySuffix),
    sourceUrl: sourceUrl.data,
    platform: platform.data,
    relatedContentId: relatedContentId.data,
    summary: sectionValue(bodySuffix, "摘要", summarySchema),
    findings: sectionValue(bodySuffix, "核心发现", findingsSchema),
    nextAction: sectionValue(bodySuffix, "下一步", nextActionSchema),
    confirmation: confirmation.data,
    confirmedAt: normalizeNullable(frontmatter.confirmed_at),
    hash: sha256(contents),
    updatedAt: typeof frontmatter.updated_at === "string" ? frontmatter.updated_at : stat.mtime.toISOString(),
    source: path.relative(root, filePath),
    filePath,
    frontmatter,
    bodySuffix,
  };
  validateRelationships(snapshot);
  return snapshot;
}

function toPublicSnapshot(snapshot) {
  const { filePath: _filePath, frontmatter: _frontmatter, bodySuffix: _bodySuffix, ...publicValue } = snapshot;
  return publicValue;
}

async function readFileSnapshot(filePath, { root }) {
  await assertNoSymlinks(root, filePath);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ReviewAssetsSecurityError("复盘资产不是普通文件");
  if (stat.size > MAX_FILE_BYTES) throw new ReviewAssetsSecurityError("复盘资产超过 1MB 安全上限");
  const contents = await fs.readFile(filePath, "utf8");
  return snapshotFrom({ filePath, contents, stat, root });
}

async function scanMarkdownFiles(directory, { root }) {
  await assertNoSymlinks(root, directory);
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const target = path.join(current, entry.name);
      assertInsideRoot(directory, target);
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
  if (existing?.isSymbolicLink()) throw new ReviewAssetsSecurityError("复盘资产文件不能是软链接");
  if (createOnly && existing) throw new ReviewAssetsConflictError(null);
  if (!createOnly) {
    if (!existing?.isFile()) throw new ReviewAssetsNotFoundError();
    const currentContents = await fs.readFile(filePath, "utf8");
    if (sha256(currentContents) !== expectedCurrentHash) throw new ReviewAssetsConflictError(null);
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
      if (sha256(currentContents) !== expectedCurrentHash) throw new ReviewAssetsConflictError(null);
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
    .slice(0, 72) || "新复盘";
  return `${date}-${stem}-${crypto.randomUUID().slice(0, 8)}.md`;
}

function createBody(input) {
  return `\n\n# ${input.title}\n\n## 摘要\n\n${input.summary}\n\n## 核心发现\n\n${input.findings}\n\n## 下一步\n\n${input.nextAction}\n`;
}

function reviewCreatePayloadHash(value) {
  return sha256(JSON.stringify({
    kind: value.kind,
    title: value.title,
    sourceUrl: value.sourceUrl,
    platform: value.platform,
    relatedContentId: value.relatedContentId,
    summary: value.summary,
    findings: value.findings,
    nextAction: value.nextAction,
  }));
}

function reviewSnapshotCreatePayloadHash(snapshot) {
  return reviewCreatePayloadHash({
    kind: snapshot.kind,
    title: snapshot.title,
    sourceUrl: snapshot.sourceUrl,
    platform: snapshot.platform,
    relatedContentId: snapshot.relatedContentId,
    summary: snapshot.summary,
    findings: snapshot.findings,
    nextAction: snapshot.nextAction,
  });
}

export function createReviewAssetsStore(options = {}) {
  const root = path.resolve(options.root ?? process.env.V2_VAULT_ROOT ?? process.env.OBSIDIAN_VAULT_ROOT ?? path.join(os.homedir(), "第二大脑-v2"));
  const stateRoot = path.resolve(options.stateRoot ?? process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"));
  const reviewRoot = path.resolve(root, REVIEW_ASSETS_RELATIVE_DIR);
  const contentRoot = path.resolve(root, CONTENT_ASSETS_RELATIVE_DIR);
  const backupRoot = path.join(stateRoot, "backups", "review-assets");
  const auditPath = path.join(stateRoot, "audit", "review-assets.jsonl");
  const now = options.now ?? (() => new Date());
  const afterWrite = options.afterWrite;
  let canonicalStateRootReal = null;

  assertInsideRoot(root, reviewRoot);
  assertInsideRoot(root, contentRoot);

  async function inspectSafeStateDirectory(directory, { create = false, expectedReal = null } = {}) {
    assertInsideRoot(stateRoot, directory);
    if (create) await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const stateStat = await lstatOrNull(stateRoot);
    if (!stateStat?.isDirectory() || stateStat.isSymbolicLink()) {
      throw new ReviewAssetsSecurityError("复盘状态根目录不存在、不是目录或为软链接");
    }
    const currentStateRootReal = await fs.realpath(stateRoot);
    if (canonicalStateRootReal === null) canonicalStateRootReal = currentStateRootReal;
    if (currentStateRootReal !== canonicalStateRootReal) {
      throw new ReviewAssetsSecurityError("复盘状态根目录 realpath 已改变");
    }
    let current = stateRoot;
    for (const segment of path.relative(stateRoot, directory).split(path.sep).filter(Boolean)) {
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
        throw new ReviewAssetsSecurityError("复盘备份或审计目录不能包含软链接");
      }
    }
    const directoryReal = await fs.realpath(directory);
    const expectedDirectoryReal = path.resolve(canonicalStateRootReal, path.relative(stateRoot, directory));
    assertInsideRoot(canonicalStateRootReal, directoryReal);
    if (directoryReal !== expectedDirectoryReal || (expectedReal !== null && directoryReal !== expectedReal)) {
      throw new ReviewAssetsSecurityError("复盘备份或审计目录 realpath 已改变");
    }
    return directoryReal;
  }

  async function ensureSafeStateDirectory(directory) {
    return inspectSafeStateDirectory(directory, { create: true });
  }

  async function verifySafeStateFile(filePath, expectedDirectoryReal, openedStat) {
    const directory = path.dirname(filePath);
    await inspectSafeStateDirectory(directory, { expectedReal: expectedDirectoryReal });
    const stat = await lstatOrNull(filePath);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new ReviewAssetsSecurityError("复盘状态文件不能是软链接或非普通文件");
    }
    if (openedStat && (stat.dev !== openedStat.dev || stat.ino !== openedStat.ino)) {
      throw new ReviewAssetsSecurityError("复盘状态文件在写入期间被替换");
    }
    const fileReal = await fs.realpath(filePath);
    if (fileReal !== path.join(expectedDirectoryReal, path.basename(filePath))) {
      throw new ReviewAssetsSecurityError("复盘状态文件 realpath 超出固定目录");
    }
  }

  async function writeNewSafeStateFile(filePath, contents) {
    const directory = path.dirname(filePath);
    const directoryReal = await ensureSafeStateDirectory(directory);
    await inspectSafeStateDirectory(directory, { expectedReal: directoryReal });
    const flags = fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(filePath, flags, 0o600);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) throw new ReviewAssetsSecurityError("复盘状态文件必须是普通文件");
      await verifySafeStateFile(filePath, directoryReal, openedStat);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await verifySafeStateFile(filePath, directoryReal, openedStat);
    } finally {
      await handle.close();
    }
  }

  async function resolveContentReference(relatedContentId) {
    if (!relatedContentId) return null;
    await assertNoSymlinks(root, contentRoot);
    const filePaths = await scanMarkdownFiles(contentRoot, { root });
    const matches = [];
    for (const filePath of filePaths) {
      await assertNoSymlinks(root, filePath);
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > MAX_FILE_BYTES) throw new ReviewAssetsSecurityError("内容资产超过 1MB 安全上限");
      const contents = await fs.readFile(filePath, "utf8");
      const { frontmatter } = splitFrontmatter(contents);
      if (frontmatter.id === relatedContentId) matches.push({ filePath, frontmatter, contents });
    }
    if (matches.length === 0) throw new ReviewAssetsValidationError("关联内容 id 在内容资产目录中不存在");
    if (matches.length > 1) throw new ReviewAssetsValidationError("关联内容 id 重复，无法安全建立链接");
    const [match] = matches;
    if (
      match.frontmatter.type !== "内容资产"
      || match.frontmatter.confirmation !== "已确认"
      || match.frontmatter.sensitivity === "敏感"
      || hasSecret(match.contents)
    ) {
      throw new ReviewAssetsValidationError("关联内容 id 未指向可用的已确认 V2 内容资产");
    }
    const relativeStem = path.relative(root, match.filePath).slice(0, -path.extname(match.filePath).length).split(path.sep).join("/");
    if (!relativeStem || /[\r\n\[\]|#^]/.test(relativeStem)) {
      throw new ReviewAssetsValidationError("关联内容路径无法安全写入 Obsidian 链接");
    }
    return `[[${relativeStem}]]`;
  }

  async function validateResolvedRelationship(snapshot) {
    const derivedFrom = snapshot.frontmatter.derived_from;
    if (!Array.isArray(derivedFrom) || derivedFrom.some((value) => typeof value !== "string")) {
      throw new ReviewAssetsValidationError(`复盘资产 ${snapshot.id} 的 derived_from 必须是字符串数组`);
    }
    const isAiDelivery = snapshot.frontmatter.source_run !== undefined;
    if (isAiDelivery) {
      if (
        !DELIVERY_RUN_ID_RE.test(snapshot.frontmatter.source_run ?? "")
        || !SAFE_ID_RE.test(snapshot.frontmatter.source_task_id ?? "")
        || !HASH_RE.test(snapshot.frontmatter.delivery_request_hash ?? "")
        || !HASH_RE.test(snapshot.frontmatter.delivery_payload_hash ?? "")
        || derivedFrom.length === 0
        || derivedFrom.some((value) => !/^\[\[[^\]\\\r\n]+\]\]$/.test(value) || value.includes(".."))
      ) {
        throw new ReviewAssetsValidationError(`复盘资产 ${snapshot.id} 的 AI 交付来源无效`);
      }
      if (snapshot.relatedContentId) {
        const expected = await resolveContentReference(snapshot.relatedContentId);
        if (!derivedFrom.includes(expected)) {
          throw new ReviewAssetsValidationError(`复盘资产 ${snapshot.id} 未链接关联内容原文`);
        }
      }
      return;
    }
    if (snapshot.relatedContentId) {
      const expected = await resolveContentReference(snapshot.relatedContentId);
      if (derivedFrom.length !== 1 || derivedFrom[0] !== expected) {
        throw new ReviewAssetsValidationError(`复盘资产 ${snapshot.id} 的 related_content_id 与 derived_from 不一致`);
      }
      return;
    }
    if (derivedFrom.length !== 0) {
      throw new ReviewAssetsValidationError(`复盘资产 ${snapshot.id} 未关联内容时 derived_from 必须为空`);
    }
  }

  async function prepareAuditFile() {
    const auditDirectory = path.dirname(auditPath);
    const auditDirectoryReal = await ensureSafeStateDirectory(auditDirectory);
    const existing = await lstatOrNull(auditPath);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new ReviewAssetsSecurityError("复盘审计文件不能是软链接或非普通文件");
    }
    if (existing) await verifySafeStateFile(auditPath, auditDirectoryReal, existing);
    return { auditDirectoryReal, existing };
  }

  async function audit(event) {
    const { auditDirectoryReal } = await prepareAuditFile();
    const safeEvent = {
      at: now().toISOString(),
      action: event.action,
      id: event.id,
      kind: event.kind,
      status: event.status,
      hash: event.hash?.slice(0, 12) ?? null,
    };
    const flags = fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_APPEND
      | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(auditPath, flags, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ReviewAssetsSecurityError("复盘审计文件必须是普通文件");
      await verifySafeStateFile(auditPath, auditDirectoryReal, stat);
      await handle.writeFile(`${JSON.stringify(safeEvent)}\n`, "utf8");
      await handle.sync();
      await verifySafeStateFile(auditPath, auditDirectoryReal, stat);
    } finally {
      await handle.close();
    }
  }

  async function latestCreateAuditStatus(id) {
    const { auditDirectoryReal, existing } = await prepareAuditFile();
    if (!existing) return null;
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size > 4 * 1024 * 1024) {
      throw new ReviewAssetsSecurityError("复盘审计文件不能是软链接、非普通文件或超过安全上限");
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(auditPath, flags);
    try {
      const openedStat = await handle.stat();
      await verifySafeStateFile(auditPath, auditDirectoryReal, openedStat);
      const contents = await handle.readFile("utf8");
      await verifySafeStateFile(auditPath, auditDirectoryReal, openedStat);
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
    } finally {
      await handle.close();
    }
  }

  async function listInternal() {
    await assertNoSymlinks(root, reviewRoot);
    const filePaths = await scanMarkdownFiles(reviewRoot, { root });
    const snapshots = [];
    const seenIds = new Set();
    for (const filePath of filePaths) {
      const snapshot = await readFileSnapshot(filePath, { root });
      if (!snapshot) continue;
      await validateResolvedRelationship(snapshot);
      if (seenIds.has(snapshot.id)) throw new ReviewAssetsValidationError(`复盘资产 id 重复: ${snapshot.id}`);
      seenIds.add(snapshot.id);
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  async function list() {
    const snapshots = await listInternal();
    return { items: snapshots.map(toPublicSnapshot), generatedAt: now().toISOString() };
  }

  async function findById(id) {
    if (typeof id !== "string" || !SAFE_ID_RE.test(id)) throw new ReviewAssetsValidationError("复盘资产 id 不安全");
    const found = (await listInternal()).find((item) => item.id === id);
    if (!found) throw new ReviewAssetsNotFoundError();
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
        throw new ReviewAssetsConflictError(toPublicSnapshot(snapshot));
      }
      aliases.push(clientRequestId);
      nextFrontmatter.client_request_aliases = aliases;
    }
    const contents = serializeWithFrontmatter(nextFrontmatter, snapshot.bodySuffix);
    await atomicWrite(snapshot.filePath, contents, { root, expectedCurrentHash: snapshot.hash });
    const rebound = await readFileSnapshot(snapshot.filePath, { root });
    if (!rebound) throw new ReviewAssetsValidationError("恢复复盘未通过请求编号映射校验");
    await validateResolvedRelationship(rebound);
    return rebound;
  }

  async function createUnlocked(input, deliveryOptions = null, createOptions = null) {
    const validated = reviewAssetCreateSchema.safeParse(input);
    if (!validated.success) throw new ReviewAssetsValidationError("新增复盘字段无效", validated.error);
    if (hasSecret(JSON.stringify(validated.data))) throw new ReviewAssetsValidationError("新增复盘疑似包含密钥或凭证，请先脱敏");
    const delivery = normalizeDeliveryOptions(deliveryOptions);
    const createRequest = delivery ? null : normalizeCreateOptions(createOptions);
    await assertNoSymlinks(root, reviewRoot);
    const relatedContentReference = await resolveContentReference(validated.data.relatedContentId);
    if (delivery) {
      const expectedPayloadHash = reviewDeliveryPayloadHash({
        kind: validated.data.kind,
        title: validated.data.title,
        sourceUrl: validated.data.sourceUrl,
        platform: validated.data.platform,
        relatedContentId: validated.data.relatedContentId,
        summary: validated.data.summary,
        findings: validated.data.findings,
        nextAction: validated.data.nextAction,
        confirmation: "待人工确认",
        status: STATUS_BY_CONFIRMATION["待人工确认"],
        derivedFrom: delivery.derivedFrom,
        relatedAssets: delivery.relatedAssets,
        sourceRun: delivery.sourceRun,
        sourceTaskId: delivery.sourceTaskId,
        requestHash: delivery.requestHash,
      });
      if (expectedPayloadHash !== delivery.payloadHash) {
        throw new ReviewAssetsValidationError("AI 复盘交付载荷哈希不一致");
      }
    }
    await prepareAuditFile();
    const createRequestHash = delivery ? null : reviewCreatePayloadHash(validated.data);
    let recoveryCandidate = null;
    if (createRequest) {
      const requestMatches = (await listInternal())
        .filter((snapshot) => clientRequestIds(snapshot.frontmatter).includes(createRequest.clientRequestId));
      if (requestMatches.length > 1) throw new ReviewAssetsConflictError(null);
      if (requestMatches.length === 1) {
        const [snapshot] = requestMatches;
        if (reviewSnapshotCreatePayloadHash(snapshot) !== createRequestHash) {
          throw new ReviewAssetsConflictError(toPublicSnapshot(snapshot));
        }
        if (await latestCreateAuditStatus(snapshot.id) === "success") {
          return toPublicSnapshot(snapshot);
        }
        recoveryCandidate = snapshot;
      }
    }
    if (createRequestHash) {
      const candidates = (await listInternal()).filter((snapshot) => snapshot.frontmatter.create_request_hash === createRequestHash);
      const recovered = [];
      for (const snapshot of candidates) {
        if (await latestCreateAuditStatus(snapshot.id) === "orphan-preserved") recovered.push(snapshot);
      }
      if (!recoveryCandidate && recovered.length > 1) throw new ReviewAssetsConflictError(null);
      if (!recoveryCandidate && recovered.length === 1) recoveryCandidate = recovered[0];
      if (recoveryCandidate) {
        let snapshot = recoveryCandidate;
        if (reviewSnapshotCreatePayloadHash(snapshot) !== createRequestHash) {
          throw new ReviewAssetsConflictError(toPublicSnapshot(snapshot));
        }
        if (createRequest) snapshot = await bindClientRequestId(snapshot, createRequest.clientRequestId);
        try {
          await afterWrite?.({ root, action: "create", id: snapshot.id, filePath: snapshot.filePath, recovered: true });
          await audit({ action: "create-recovered", id: snapshot.id, kind: snapshot.kind, status: "success", hash: snapshot.hash });
          return toPublicSnapshot(snapshot);
        } catch (error) {
          await audit({ action: "create-recovered", id: snapshot.id, kind: snapshot.kind, status: "orphan-preserved", hash: snapshot.hash });
          throw new ReviewAssetsCommitError(
            "数据校验仍未通过；已保留同一份新复盘，修复索引后可用原请求重试认领",
            { cause: error },
          );
        }
      }
    }
    const ownerName = readCockpitSettingsSync(root).ownerName;
    const date = shanghaiDate(now());
    const id = `review-${validated.data.kind === "content-review" ? "content" : "account"}-${date.replaceAll("-", "")}-${crypto.randomUUID().replaceAll("-", "")}`;
    const filePath = path.join(reviewRoot, safeFilename(validated.data.title, date));
    assertInsideRoot(reviewRoot, filePath);
    const frontmatter = {
      id,
      type: "复盘",
      review_kind: validated.data.kind,
      status: STATUS_BY_CONFIRMATION["待人工确认"],
      created_at: date,
      updated_at: date,
      source: delivery ? "AI 协作交付" : "驾驶舱新增",
      topics: [TOPIC_BY_KIND[validated.data.kind]],
      sensitivity: "内部",
      origin_owner: validated.data.kind === "account-breakdown" ? "外部来源" : ownerName,
      processed_by: "人机协作",
      confirmation: "待人工确认",
      confirmed_at: null,
      derived_from: delivery?.derivedFrom ?? (relatedContentReference ? [relatedContentReference] : []),
      related_assets: delivery?.relatedAssets ?? [],
      ...(!delivery ? { create_request_hash: createRequestHash } : {}),
      ...(createRequest ? { client_request_id: createRequest.clientRequestId } : {}),
      ...(delivery ? {
        source_run: delivery.sourceRun,
        source_task_id: delivery.sourceTaskId,
        delivery_request_hash: delivery.requestHash,
        delivery_payload_hash: delivery.payloadHash,
      } : {}),
      source_url: validated.data.sourceUrl,
      platform: validated.data.platform,
      related_content_id: validated.data.relatedContentId,
    };
    const contents = serializeWithFrontmatter(frontmatter, createBody(validated.data));
    await atomicWrite(filePath, contents, { root, createOnly: true });
    const writtenHash = sha256(contents);

    try {
      await afterWrite?.({ root, action: "create", id, filePath });
      const snapshot = await readFileSnapshot(filePath, { root });
      if (!snapshot) throw new ReviewAssetsValidationError("新增复盘未通过可见性校验");
      await validateResolvedRelationship(snapshot);
      await audit({ action: "create", id, kind: snapshot.kind, status: "success", hash: snapshot.hash });
      return toPublicSnapshot(snapshot);
    } catch (error) {
      await audit({ action: "create", id, kind: validated.data.kind, status: "orphan-preserved", hash: writtenHash });
      throw new ReviewAssetsCommitError(
        "数据校验失败；为避免误删，新复盘已保留，修复索引后可用原请求重试认领",
        { cause: error },
      );
    }
  }

  async function updateUnlocked(id, patch, expectedHash) {
    const parsedPatch = reviewAssetPatchSchema.safeParse(patch);
    if (!parsedPatch.success) throw new ReviewAssetsValidationError("复盘修改字段无效", parsedPatch.error);
    if (hasSecret(JSON.stringify(parsedPatch.data))) throw new ReviewAssetsValidationError("复盘修改疑似包含密钥或凭证，请先脱敏");
    if (typeof expectedHash !== "string" || !HASH_RE.test(expectedHash)) {
      throw new ReviewAssetsValidationError("expectedHash 必须是 64 位小写 SHA-256");
    }
    const current = await findById(id);
    if (current.hash !== expectedHash) {
      await audit({ action: "update", id, kind: current.kind, status: "conflict", hash: current.hash });
      throw new ReviewAssetsConflictError(toPublicSnapshot(current));
    }
    const substantiveFields = [
      "title",
      "sourceUrl",
      "platform",
      "relatedContentId",
      "summary",
      "findings",
      "nextAction",
    ];
    const hasSubstantiveEdit = substantiveFields.some((field) => Object.hasOwn(parsedPatch.data, field));
    const normalizedPatch = { ...parsedPatch.data };
    if (
      hasSubstantiveEdit
      && current.confirmation === "已确认"
      && !Object.hasOwn(normalizedPatch, "confirmation")
    ) {
      normalizedPatch.confirmation = "待人工确认";
    }
    const next = { ...toPublicSnapshot(current), ...normalizedPatch };
    validateRelationships(next);
    const relatedContentReference = Object.hasOwn(normalizedPatch, "relatedContentId")
      ? await resolveContentReference(normalizedPatch.relatedContentId)
      : null;

    const previousContents = await fs.readFile(current.filePath, "utf8");
    if (sha256(previousContents) !== current.hash) throw new ReviewAssetsConflictError(toPublicSnapshot(await findById(id)));
    const stamp = now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
    const backupPath = path.join(backupRoot, `${stamp}-${id}-${current.hash.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}.md`);
    await writeNewSafeStateFile(backupPath, previousContents);

    const fm = { ...current.frontmatter };
    if (Object.hasOwn(normalizedPatch, "sourceUrl")) fm.source_url = normalizedPatch.sourceUrl;
    if (Object.hasOwn(normalizedPatch, "platform")) fm.platform = normalizedPatch.platform;
    if (Object.hasOwn(normalizedPatch, "relatedContentId")) {
      fm.related_content_id = normalizedPatch.relatedContentId;
      fm.derived_from = relatedContentReference ? [relatedContentReference] : [];
    }
    if (Object.hasOwn(normalizedPatch, "confirmation")) {
      fm.confirmation = normalizedPatch.confirmation;
      fm.status = STATUS_BY_CONFIRMATION[normalizedPatch.confirmation];
      if (normalizedPatch.confirmation === "待人工确认") {
        fm.confirmed_at = null;
      } else if (current.confirmation !== "已确认" || hasSubstantiveEdit) {
        fm.confirmed_at = now().toISOString();
      }
    }
    fm.updated_at = shanghaiDate(now());
    let bodySuffix = current.bodySuffix;
    if (Object.hasOwn(normalizedPatch, "title")) bodySuffix = replaceFirstHeading(bodySuffix, normalizedPatch.title);
    if (Object.hasOwn(normalizedPatch, "summary")) bodySuffix = replaceSection(bodySuffix, "摘要", normalizedPatch.summary);
    if (Object.hasOwn(normalizedPatch, "findings")) bodySuffix = replaceSection(bodySuffix, "核心发现", normalizedPatch.findings);
    if (Object.hasOwn(normalizedPatch, "nextAction")) bodySuffix = replaceSection(bodySuffix, "下一步", normalizedPatch.nextAction);
    const contents = serializeWithFrontmatter(fm, bodySuffix);
    await atomicWrite(current.filePath, contents, { root, expectedCurrentHash: current.hash });
    const writtenHash = sha256(contents);

    try {
      await afterWrite?.({ root, action: "update", id, filePath: current.filePath });
      const snapshot = await findById(id);
      const auditAction = current.confirmation !== "已确认" && snapshot.confirmation === "已确认"
        ? "confirm"
        : current.confirmation === "已确认" && snapshot.confirmation === "待人工确认"
          ? "reopen-after-edit"
          : "update";
      await audit({ action: auditAction, id, kind: snapshot.kind, status: "success", hash: snapshot.hash });
      return toPublicSnapshot(snapshot);
    } catch (error) {
      let rollbackError;
      try {
        const latest = await readFileSnapshot(current.filePath, { root });
        if (!latest || latest.hash !== writtenHash) throw new ReviewAssetsConflictError(latest ? toPublicSnapshot(latest) : null);
        await atomicWrite(current.filePath, previousContents, { root, expectedCurrentHash: writtenHash });
        await afterWrite?.({ root, action: "update", id, filePath: current.filePath, rollback: true });
      } catch (caught) {
        rollbackError = caught;
      }
      await audit({ action: "update", id, kind: current.kind, status: rollbackError ? "rollback-failed" : "rolled-back", hash: current.hash });
      throw new ReviewAssetsCommitError(
        rollbackError ? "数据校验失败，且复盘资产未能完整回滚" : "数据校验失败，复盘资产已恢复",
        { cause: error, rollbackError },
      );
    }
  }

  async function findBySourceRun(sourceRun) {
    if (!DELIVERY_RUN_ID_RE.test(sourceRun ?? "")) throw new ReviewAssetsValidationError("sourceRun 无效");
    const matches = (await listInternal()).filter((snapshot) => snapshot.frontmatter.source_run === sourceRun);
    if (matches.length > 1) throw new ReviewAssetsValidationError("同一 AI 任务产生了多个复盘资产");
    if (!matches[0]) return null;
    const snapshot = matches[0];
    const currentPayloadHash = reviewDeliveryPayloadHash({
      kind: snapshot.kind,
      title: snapshot.title,
      sourceUrl: snapshot.sourceUrl,
      platform: snapshot.platform,
      relatedContentId: snapshot.relatedContentId,
      summary: snapshot.summary,
      findings: snapshot.findings,
      nextAction: snapshot.nextAction,
      confirmation: snapshot.confirmation,
      status: snapshot.frontmatter.status,
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
      targetRelativePath: snapshot.source.split(path.sep).join("/"),
    };
  }

  function create(input, createOptions) {
    return runWithSharedWriteQueue(reviewRoot, () => createUnlocked(input, null, createOptions));
  }

  function createDelivery(input, deliveryOptions) {
    return runWithSharedWriteQueue(reviewRoot, () => createUnlocked(input, deliveryOptions));
  }

  function update(id, patch, expectedHash) {
    return runWithSharedWriteQueue(reviewRoot, () => updateUnlocked(id, patch, expectedHash));
  }

  return { list, findById, findBySourceRun, create, createDelivery, update, root, reviewRoot };
}
