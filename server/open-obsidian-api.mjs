import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const MAX_BODY_BYTES = 8 * 1024;
const ASSET_REF_RE = /^(content|knowledge|project|review|evidence):([A-Za-z0-9][A-Za-z0-9_-]{0,159})$/;
const RELATIVE_MARKDOWN_RE = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]{1,1024}\.md$/i;
const bodySchema = z.object({
  source: z.string().refine(
    (value) => ASSET_REF_RE.test(value) || RELATIVE_MARKDOWN_RE.test(value),
    "原文引用或路径无效",
  ),
}).strict();

export class OpenObsidianValidationError extends Error {}
export class OpenObsidianSecurityError extends Error {}
export class OpenObsidianNotFoundError extends Error {}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isLoopback(value) {
  const normalized = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validateBoundary(request) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress)) {
    throw new OpenObsidianSecurityError("API 只接受本机回环连接");
  }
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) {
    throw new OpenObsidianSecurityError("Host 必须是本机回环地址");
  }
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    throw new OpenObsidianSecurityError("Host 请求头无效");
  }
  if (!isLoopback(hostUrl.hostname)) throw new OpenObsidianSecurityError("Host 必须是本机回环地址");

  const origin = request.headers.origin;
  if (!origin) throw new OpenObsidianSecurityError("打开请求必须包含同源 Origin");
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new OpenObsidianSecurityError("Origin 请求头无效");
  }
  if (
    originUrl.protocol !== "http:"
    || !isLoopback(originUrl.hostname)
    || originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()
    || originUrl.pathname !== "/"
    || originUrl.search
    || originUrl.hash
    || originUrl.username
    || originUrl.password
  ) {
    throw new OpenObsidianSecurityError("Origin 必须与驾驶舱页面同源");
  }
}

function resolveVaultFile(root, source) {
  if (source.includes("\0") || path.isAbsolute(source) || source.split(/[\\/]/).includes("..")) {
    throw new OpenObsidianSecurityError("原文路径不安全");
  }
  if (!source.toLowerCase().endsWith(".md")) {
    throw new OpenObsidianValidationError("只能打开 Markdown 原文");
  }
  const target = path.resolve(root, source);
  if (!isInside(root, target)) throw new OpenObsidianSecurityError("原文路径超出 V2");

  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new OpenObsidianSecurityError("V2 根目录不存在或不安全");
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new OpenObsidianNotFoundError("原文不存在");
    if (stat.isSymbolicLink()) throw new OpenObsidianSecurityError("原文路径包含软链接");
  }
  const targetStat = fs.statSync(target, { throwIfNoEntry: false });
  if (!targetStat?.isFile()) throw new OpenObsidianNotFoundError("原文不存在");
  return target;
}

export function resolveAssetSource(indexPath, reference) {
  const match = reference.match(ASSET_REF_RE);
  if (!match) throw new OpenObsidianValidationError("原文引用无效");
  const stat = fs.lstatSync(indexPath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) {
    throw new OpenObsidianSecurityError("本机资产索引不存在或不安全");
  }
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    throw new OpenObsidianValidationError("本机资产索引无法读取");
  }
  const [, kind, id] = match;
  if (kind === "review") {
    const pendingMatches = Array.isArray(index.reviewItems)
      ? index.reviewItems.filter((candidate) => candidate?.id === id)
      : [];
    const confirmedMatches = Array.isArray(index.knowledge)
      ? index.knowledge.filter((candidate) => candidate?.id === id)
      : [];
    const matches = [...pendingMatches, ...confirmedMatches];
    if (matches.length === 0) {
      throw new OpenObsidianNotFoundError("原文不存在或未进入可见索引");
    }
    if (matches.length > 1) {
      throw new OpenObsidianValidationError("复盘原文引用不唯一");
    }
    if (matches[0]?.type !== "复盘") {
      throw new OpenObsidianValidationError("复盘原文引用未指向复盘资产");
    }
    const source = matches[0]?.source;
    if (typeof source !== "string") {
      throw new OpenObsidianNotFoundError("原文不存在或未进入可见索引");
    }
    return source;
  }
  const collections = {
    content: [index.contents, "source"],
    knowledge: [index.knowledge, "source"],
    project: [index.projectDocuments, "source"],
    evidence: [index.evidence, "sourceEvidence"],
  };
  const [items, sourceField] = collections[kind] ?? [];
  const item = Array.isArray(items) ? items.find((candidate) => candidate?.id === id) : null;
  const source = item?.[sourceField];
  if (typeof source !== "string") throw new OpenObsidianNotFoundError("原文不存在或未进入可见索引");
  return source;
}

async function defaultOpenFile({ uri }) {
  await execFileAsync("/usr/bin/open", [uri], { timeout: 10_000, maxBuffer: 64 * 1024 });
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new OpenObsidianValidationError("请求必须使用 application/json");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new OpenObsidianValidationError("请求体超过 8KB 安全上限");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new OpenObsidianValidationError("请求体超过 8KB 安全上限");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let raw;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new OpenObsidianValidationError("请求体不是有效 JSON", { cause: error });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw new OpenObsidianValidationError("请求体字段无效");
  return parsed.data;
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}

export function createOpenObsidianMiddleware(options = {}) {
  const root = path.resolve(options.root ?? process.env.V2_VAULT_ROOT ?? process.env.OBSIDIAN_VAULT_ROOT ?? path.join(os.homedir(), "第二大脑-v2"));
  const stateRoot = path.resolve(options.stateRoot ?? process.env.COCKPIT_STATE_ROOT ?? path.join(os.homedir(), ".media-growth-cockpit"));
  const indexPath = path.resolve(options.indexPath ?? path.join(stateRoot, "index.json"));
  const openFile = options.openFile ?? defaultOpenFile;
  const resolveSource = options.resolveSource ?? ((reference) => resolveAssetSource(indexPath, reference));

  return async function openObsidianMiddleware(request, response, next) {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return next();
    }
    if (url.pathname !== "/api/open-obsidian") return next();

    try {
      validateBoundary(request);
      if ([...url.searchParams].length > 0) throw new OpenObsidianValidationError("该接口不接受查询参数");
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return sendJson(response, 405, { error: "method_not_allowed", message: "仅支持 POST" });
      }
      const body = await readBody(request);
      const source = ASSET_REF_RE.test(body.source)
        ? await resolveSource(body.source)
        : body.source;
      const target = resolveVaultFile(root, source);
      const uri = `obsidian://open?path=${encodeURIComponent(target)}`;
      await openFile({ target, uri });
      return sendJson(response, 200, { opened: true });
    } catch (error) {
      if (error instanceof OpenObsidianNotFoundError) {
        return sendJson(response, 404, { error: "not_found", message: error.message });
      }
      if (error instanceof OpenObsidianValidationError) {
        return sendJson(response, error.statusCode ?? 400, { error: "invalid_request", message: error.message });
      }
      if (error instanceof OpenObsidianSecurityError) {
        return sendJson(response, 403, { error: "forbidden", message: error.message });
      }
      return sendJson(response, 500, { error: "open_failed", message: "无法打开 Obsidian 原文" });
    }
  };
}
