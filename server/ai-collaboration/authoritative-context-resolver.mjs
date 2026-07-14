import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasSecret } from "../../scripts/lib/security.mjs";
import {
  CONTENT_ASSETS_RELATIVE_DIR,
  createContentAssetsStore,
} from "../content-assets-store.mjs";
import {
  REVIEW_ASSETS_RELATIVE_DIR,
  createReviewAssetsStore,
} from "../review-assets-store.mjs";
import {
  DAILY_REVIEWS_RELATIVE_DIR,
  createDailyReviewsStore,
} from "../daily-reviews-store.mjs";

export const AUTHORITATIVE_AI_CONTEXT_TYPES = Object.freeze([
  "topic",
  "content",
  "content-review",
  "account-breakdown",
  "daily-review",
]);

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_INDEX_BYTES = 10 * 1024 * 1024;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const TOPIC_STATUSES = new Set(["候选选题", "已立项"]);
const ALLOWED_SENSITIVITY = new Set(["公开", "内部"]);
const WHITELIST_BY_TYPE = Object.freeze({
  topic: CONTENT_ASSETS_RELATIVE_DIR,
  content: CONTENT_ASSETS_RELATIVE_DIR,
  "content-review": REVIEW_ASSETS_RELATIVE_DIR,
  "account-breakdown": REVIEW_ASSETS_RELATIVE_DIR,
  "daily-review": DAILY_REVIEWS_RELATIVE_DIR,
});

export class AuthoritativeContextValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "AuthoritativeContextValidationError";
  }
}

export class AuthoritativeContextSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthoritativeContextSecurityError";
  }
}

export class AuthoritativeContextNotFoundError extends Error {
  constructor(message = "AI 上下文不存在或未进入权威索引") {
    super(message);
    this.name = "AuthoritativeContextNotFoundError";
  }
}

export class AuthoritativeContextTypeMismatchError extends Error {
  constructor(message = "AI 上下文类型与权威资产不一致") {
    super(message);
    this.name = "AuthoritativeContextTypeMismatchError";
  }
}

export class AuthoritativeContextConflictError extends Error {
  constructor(message = "V2 原文已经变化，请重新生成索引后再试") {
    super(message);
    this.name = "AuthoritativeContextConflictError";
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRequest(value) {
  if (!isPlainObject(value)) throw new AuthoritativeContextValidationError("context 必须是普通对象");
  const unexpected = Object.keys(value).filter((key) => !["type", "id"].includes(key));
  if (unexpected.length > 0) {
    throw new AuthoritativeContextValidationError(`浏览器 context 只能包含 type 和 id：${unexpected.join("、")}`);
  }
  if (!AUTHORITATIVE_AI_CONTEXT_TYPES.includes(value.type)) {
    throw new AuthoritativeContextValidationError(
      `context.type 只能是：${AUTHORITATIVE_AI_CONTEXT_TYPES.join("、")}`,
    );
  }
  if (typeof value.id !== "string" || !SAFE_ID_RE.test(value.id)) {
    throw new AuthoritativeContextValidationError("context.id 不是安全的不透明标识");
  }
  return { type: value.type, id: value.id };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeRelativeMarkdown(relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.length > 4_096
    || relativePath.includes("\0")
    || relativePath.includes("\\")
    || path.isAbsolute(relativePath)
    || !relativePath.toLowerCase().endsWith(".md")
  ) {
    throw new AuthoritativeContextSecurityError("权威索引中的 Markdown 路径不安全");
  }
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new AuthoritativeContextSecurityError("权威索引中的 Markdown 路径包含越界段");
  }
  return parts.join(path.sep);
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertNoSymlinkTree(root, target, { rootLabel, missingIsNotFound = false } = {}) {
  if (!isInside(root, target)) throw new AuthoritativeContextSecurityError(`${rootLabel}路径越界`);
  const rootStat = await lstatOrNull(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new AuthoritativeContextSecurityError(`${rootLabel}根目录不存在、不是目录或为软链接`);
  }
  let current = root;
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstatOrNull(current);
    } catch (error) {
      if (error?.code === "ENOTDIR") {
        throw new AuthoritativeContextSecurityError(`${rootLabel}路径包含非目录节点`);
      }
      throw error;
    }
    if (!stat) {
      if (missingIsNotFound) throw new AuthoritativeContextNotFoundError();
      throw new AuthoritativeContextSecurityError(`${rootLabel}路径不存在`);
    }
    if (stat.isSymbolicLink()) throw new AuthoritativeContextSecurityError(`${rootLabel}路径不能包含软链接`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new AuthoritativeContextSecurityError(`${rootLabel}路径包含非目录节点`);
    }
  }
}

async function readStableFile(filePath, { root, maxBytes, rootLabel, missingIsNotFound = false }) {
  await assertNoSymlinkTree(root, filePath, { rootLabel, missingIsNotFound });
  const initial = await lstatOrNull(filePath);
  if (!initial) throw new AuthoritativeContextNotFoundError();
  if (!initial.isFile() || initial.isSymbolicLink()) {
    throw new AuthoritativeContextSecurityError(`${rootLabel}目标不是普通文件`);
  }
  if (initial.size > maxBytes) throw new AuthoritativeContextSecurityError(`${rootLabel}文件超过安全上限`);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new AuthoritativeContextSecurityError(`${rootLabel}目标不是普通文件或超过安全上限`);
    }
    const contents = await handle.readFile();
    if (contents.byteLength > maxBytes) throw new AuthoritativeContextSecurityError(`${rootLabel}文件超过安全上限`);
    const final = await fs.lstat(filePath);
    if (
      final.isSymbolicLink()
      || !final.isFile()
      || final.dev !== opened.dev
      || final.ino !== opened.ino
      || final.size !== opened.size
    ) {
      throw new AuthoritativeContextSecurityError(`${rootLabel}文件在读取期间被替换`);
    }
    const [rootReal, fileReal] = await Promise.all([fs.realpath(root), fs.realpath(filePath)]);
    const expectedReal = path.resolve(rootReal, path.relative(root, filePath));
    if (!isInside(rootReal, fileReal) || fileReal !== expectedReal) {
      throw new AuthoritativeContextSecurityError(`${rootLabel}文件 realpath 越界`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function validateIndex(index) {
  if (!isPlainObject(index) || index.schemaVersion !== "1.0.0") {
    throw new AuthoritativeContextValidationError("权威索引版本无效");
  }
  for (const field of ["contents", "knowledge", "reviewItems", "sourceFiles"]) {
    if (!Array.isArray(index[field])) throw new AuthoritativeContextValidationError(`权威索引缺少 ${field}`);
  }
  return index;
}

async function readCanonicalIndex(indexPath, stateRoot) {
  const buffer = await readStableFile(indexPath, {
    root: stateRoot,
    maxBytes: MAX_INDEX_BYTES,
    rootLabel: "权威索引",
  });
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new AuthoritativeContextValidationError("权威索引无法解析", error);
  }
  return validateIndex(parsed);
}

function findUniqueById(items, id, label) {
  const matches = items.filter((item) => isPlainObject(item) && item.id === id);
  if (matches.length === 0) throw new AuthoritativeContextNotFoundError(`${label}不存在或未进入权威索引`);
  if (matches.length > 1) throw new AuthoritativeContextValidationError(`${label} id 在权威索引中不唯一`);
  return matches[0];
}

function findContentIndexItem(index, id) {
  return findUniqueById(index.contents, id, "内容资产");
}

function findReviewIndexItem(index, id) {
  const matches = [...index.knowledge, ...index.reviewItems]
    .filter((item) => isPlainObject(item) && item.id === id);
  if (matches.length === 0) throw new AuthoritativeContextNotFoundError("复盘资产不存在或未进入权威索引");
  if (matches.length > 1) throw new AuthoritativeContextValidationError("复盘资产 id 在权威索引中不唯一");
  if (matches[0].type !== "复盘") throw new AuthoritativeContextTypeMismatchError("该 id 未指向复盘资产");
  return matches[0];
}

function findSourceManifest(index, relativePath, expectedClassification) {
  const matches = index.sourceFiles.filter((item) => isPlainObject(item) && item.path === relativePath);
  if (matches.length === 0) throw new AuthoritativeContextNotFoundError("原文未进入权威文件清单");
  if (matches.length > 1) throw new AuthoritativeContextValidationError("原文路径在权威文件清单中不唯一");
  const source = matches[0];
  if (source.classification !== expectedClassification) {
    throw new AuthoritativeContextTypeMismatchError("原文分类与请求类型不一致");
  }
  if (
    typeof source.sha256 !== "string"
    || !SHA256_RE.test(source.sha256)
    || !Number.isInteger(source.bytes)
    || source.bytes < 0
    || source.bytes > MAX_MARKDOWN_BYTES
  ) {
    throw new AuthoritativeContextValidationError("权威文件清单中的哈希或大小无效");
  }
  const expectedReason = source.included === true
    ? "confirmation:已确认"
    : source.included === false
      ? "confirmation:待人工确认"
      : null;
  if (expectedReason === null || source.reason !== expectedReason) {
    throw new AuthoritativeContextSecurityError("原文未通过确认状态与敏感信息边界");
  }
  return source;
}

function assertSnapshotSensitivity(snapshot) {
  const sensitivity = snapshot?.frontmatter?.sensitivity;
  if (!ALLOWED_SENSITIVITY.has(sensitivity)) {
    throw new AuthoritativeContextSecurityError("敏感或未声明敏感级别的资产不能进入 AI 工作区");
  }
}

function assertSnapshotIdentity(snapshot, id, expectedType) {
  if (!snapshot || snapshot.id !== id) {
    throw new AuthoritativeContextTypeMismatchError("V2 资产 id 与请求不一致");
  }
  const actualType = snapshot.frontmatter?.type;
  if (actualType !== expectedType) {
    throw new AuthoritativeContextTypeMismatchError("V2 资产类型与请求不一致");
  }
  assertSnapshotSensitivity(snapshot);
}

async function verifyMarkdownSource({
  root,
  index,
  relativePath,
  expectedClassification,
  expectedSnapshotHash,
  whitelistRelativeDir,
}) {
  const normalizedRelativePath = assertSafeRelativeMarkdown(relativePath);
  const target = path.resolve(root, normalizedRelativePath);
  const whitelistRoot = path.resolve(root, whitelistRelativeDir);
  if (!isInside(whitelistRoot, target) || target === whitelistRoot) {
    throw new AuthoritativeContextSecurityError("原文路径超出该上下文类型的 V2 白名单");
  }
  const manifest = findSourceManifest(index, relativePath, expectedClassification);
  const contents = await readStableFile(target, {
    root,
    maxBytes: MAX_MARKDOWN_BYTES,
    rootLabel: "V2 原文",
    missingIsNotFound: true,
  });
  if (hasSecret(contents.toString("utf8"))) {
    throw new AuthoritativeContextSecurityError("权威原文包含疑似凭证，不能发送给 AI");
  }
  const currentHash = crypto.createHash("sha256").update(contents).digest("hex");
  if (
    currentHash !== manifest.sha256
    || contents.byteLength !== manifest.bytes
    || (expectedSnapshotHash !== undefined && currentHash !== expectedSnapshotHash)
  ) {
    throw new AuthoritativeContextConflictError();
  }
  return {
    sourcePath: target,
    sha256: currentHash,
    bytes: contents.byteLength,
  };
}

function canonicalText(value, label, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    throw new AuthoritativeContextValidationError(`${label}无效`);
  }
  return value;
}

async function findStoreSnapshot(store, id, label) {
  try {
    return await store.findById(id);
  } catch (error) {
    if (typeof error?.name === "string" && error.name.endsWith("SecurityError")) {
      throw new AuthoritativeContextSecurityError(`${label}未通过 V2 路径安全校验`);
    }
    if (typeof error?.name === "string" && error.name.endsWith("NotFoundError")) {
      throw new AuthoritativeContextNotFoundError(`${label}不存在、敏感或不可见`);
    }
    if (typeof error?.name === "string" && error.name.endsWith("ValidationError")) {
      throw new AuthoritativeContextValidationError(`${label}未通过 V2 结构校验`, error);
    }
    throw error;
  }
}

function makeSourceRef({ type, id, sourcePath, sha256, inputName }) {
  return {
    ref: `canonical:${type}:${id}:${sha256}`,
    sourcePath,
    inputName,
    expectedSha256: sha256,
  };
}

/**
 * Resolves a browser-safe {type, id} into server-owned canonical context.
 *
 * Integration boundary:
 *   const resolved = await resolver.resolve(body.context);
 *   await workspaceStore.create({
 *     ...body,
 *     context: resolved.context,
 *     sourceRefs: resolved.sourceRefs,
 *   });
 *
 * `sourceRefs` intentionally matches run-workspace-store's copy contract. Do
 * not serialize it back to the browser because it contains private V2 paths.
 */
export function createAuthoritativeAiContextResolver(options = {}) {
  const root = path.resolve(
    options.root
      ?? process.env.V2_VAULT_ROOT
      ?? process.env.OBSIDIAN_VAULT_ROOT
      ?? path.join(os.homedir(), "第二大脑-v2"),
  );
  const stateRoot = path.resolve(
    options.stateRoot
      ?? process.env.COCKPIT_STATE_ROOT
      ?? path.join(os.homedir(), ".media-growth-cockpit"),
  );
  const indexPath = path.resolve(options.indexPath ?? path.join(stateRoot, "index.json"));
  if (!isInside(stateRoot, indexPath) || indexPath === stateRoot) {
    throw new AuthoritativeContextSecurityError("权威索引必须位于驾驶舱状态目录内");
  }
  const contentStore = options.contentStore ?? createContentAssetsStore({ root, stateRoot });
  const reviewStore = options.reviewStore ?? createReviewAssetsStore({ root, stateRoot });
  const dailyReviewStore = options.dailyReviewStore ?? createDailyReviewsStore({ root, stateRoot });

  async function resolveContentSource(index, id, {
    contextType,
    enforceContextStage,
    allowArchived = false,
    inputName,
  }) {
    const indexItem = findContentIndexItem(index, id);
    const source = canonicalText(indexItem.source, "内容资产 source", 4_096);
    const verified = await verifyMarkdownSource({
      root,
      index,
      relativePath: source,
      expectedClassification: "content-asset",
      whitelistRelativeDir: WHITELIST_BY_TYPE[contextType],
    });
    const snapshot = await findStoreSnapshot(contentStore, id, "内容资产");
    assertSnapshotIdentity(snapshot, id, "内容资产");
    if (snapshot.filePath !== verified.sourcePath || snapshot.hash !== verified.sha256) {
      throw new AuthoritativeContextConflictError("内容资产快照与权威原文不一致，请重新索引");
    }
    if (!allowArchived && snapshot.status === "已归档") {
      throw new AuthoritativeContextTypeMismatchError("已归档内容不能作为当前 AI 上下文");
    }
    if (enforceContextStage && !TOPIC_STATUSES.has(snapshot.status)) {
      throw new AuthoritativeContextTypeMismatchError("该内容已经不处于选题阶段");
    }
    if (indexItem.status !== snapshot.status) throw new AuthoritativeContextConflictError();
    return {
      indexItem,
      snapshot,
      verified,
      ref: makeSourceRef({ type: contextType, id, ...verified, inputName }),
    };
  }

  async function resolveReviewSource(index, request) {
    const indexItem = findReviewIndexItem(index, request.id);
    const source = canonicalText(indexItem.source, "复盘资产 source", 4_096);
    const verified = await verifyMarkdownSource({
      root,
      index,
      relativePath: source,
      expectedClassification: "knowledge-asset",
      whitelistRelativeDir: WHITELIST_BY_TYPE[request.type],
    });
    const snapshot = await findStoreSnapshot(reviewStore, request.id, "复盘资产");
    assertSnapshotIdentity(snapshot, request.id, "复盘");
    if (snapshot.kind !== request.type) {
      throw new AuthoritativeContextTypeMismatchError("复盘 kind 与 context.type 不一致");
    }
    if (snapshot.filePath !== verified.sourcePath || snapshot.hash !== verified.sha256) {
      throw new AuthoritativeContextConflictError("复盘快照与权威原文不一致，请重新索引");
    }
    const sourceRefs = [makeSourceRef({
      type: request.type,
      id: request.id,
      ...verified,
      inputName: "review-source.md",
    })];
    if (request.type === "content-review" && snapshot.relatedContentId) {
      const related = await resolveContentSource(index, snapshot.relatedContentId, {
        contextType: "content",
        enforceContextStage: false,
        allowArchived: true,
        inputName: "related-content.md",
      });
      sourceRefs.push(related.ref);
    }
    return {
      context: {
        type: request.type,
        id: request.id,
        title: canonicalText(snapshot.title, "复盘标题", 500),
        summary: canonicalText(snapshot.summary || indexItem.summary, "复盘摘要", 4_000),
      },
      sourceRefs,
      currentHash: verified.sha256,
    };
  }

  async function resolveDailyReview(index, request) {
    const snapshot = await findStoreSnapshot(dailyReviewStore, request.id, "每日复盘");
    assertSnapshotIdentity(snapshot, request.id, "经营看板");
    if (snapshot.frontmatter?.dashboard_kind !== "daily-review") {
      throw new AuthoritativeContextTypeMismatchError("经营看板不是每日复盘");
    }
    const source = canonicalText(snapshot.source, "每日复盘 source", 4_096);
    const verified = await verifyMarkdownSource({
      root,
      index,
      relativePath: source,
      expectedClassification: "daily-review",
      expectedSnapshotHash: snapshot.hash,
      whitelistRelativeDir: WHITELIST_BY_TYPE[request.type],
    });
    if (snapshot.filePath !== verified.sourcePath) throw new AuthoritativeContextConflictError();
    const summary = snapshot.judgment || snapshot.tomorrowAction || snapshot.facts || "每日复盘尚未形成判断。";
    return {
      context: {
        type: request.type,
        id: request.id,
        title: `${snapshot.date} 每日复盘`,
        summary: canonicalText(summary, "每日复盘摘要", 4_000),
      },
      sourceRefs: [makeSourceRef({
        type: request.type,
        id: request.id,
        ...verified,
        inputName: "daily-review-source.md",
      })],
      currentHash: verified.sha256,
    };
  }

  async function resolve(value) {
    const request = normalizeRequest(value);
    const index = await readCanonicalIndex(indexPath, stateRoot);
    if (request.type === "topic" || request.type === "content") {
      const resolved = await resolveContentSource(index, request.id, {
        contextType: request.type,
        enforceContextStage: request.type === "topic",
        inputName: request.type === "topic" ? "topic-source.md" : "content-source.md",
      });
      return {
        context: {
          type: request.type,
          id: request.id,
          title: canonicalText(resolved.indexItem.title, "内容标题", 500),
          summary: canonicalText(resolved.indexItem.summary, "内容摘要", 4_000),
        },
        sourceRefs: [resolved.ref],
        currentHash: resolved.verified.sha256,
      };
    }
    if (request.type === "content-review" || request.type === "account-breakdown") {
      return resolveReviewSource(index, request);
    }
    return resolveDailyReview(index, request);
  }

  return { resolve, root, stateRoot, indexPath };
}
