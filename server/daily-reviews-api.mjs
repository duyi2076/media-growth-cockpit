import { z } from "zod";
import { rebuildAndValidateIndex } from "./daily-tasks-api.mjs";
import {
  createDailyReviewsStore,
  dailyReviewCreateSchema,
  dailyReviewPatchSchema,
  DailyReviewsCommitError,
  DailyReviewsConflictError,
  DailyReviewsNotFoundError,
  DailyReviewsSecurityError,
  DailyReviewsValidationError,
} from "./daily-reviews-store.mjs";

const MAX_BODY_BYTES = 128 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^daily-review-\d{4}-\d{2}-\d{2}$/;
const CLIENT_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const putBodySchema = z.object({
  id: z.string().regex(ID_RE, "每日复盘 id 不安全"),
  patch: dailyReviewPatchSchema,
  expectedHash: z.string().regex(HASH_RE, "expectedHash 必须是 64 位小写 SHA-256"),
}).strict();

function isLoopback(value) {
  const normalized = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validateBoundary(request) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress)) {
    throw new DailyReviewsSecurityError("API 只接受本机回环连接");
  }
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) {
    throw new DailyReviewsSecurityError("Host 必须是本机回环地址");
  }
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { throw new DailyReviewsSecurityError("Host 请求头无效"); }
  if (!isLoopback(hostUrl.hostname)) throw new DailyReviewsSecurityError("Host 必须是本机回环地址");
  const origin = request.headers.origin;
  if (["POST", "PUT"].includes(request.method) && !origin) throw new DailyReviewsSecurityError("写入请求必须包含同源 Origin");
  if (origin) {
    let originUrl;
    try { originUrl = new URL(origin); } catch { throw new DailyReviewsSecurityError("Origin 请求头无效"); }
    if (
      originUrl.protocol !== "http:"
      || !isLoopback(originUrl.hostname)
      || originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()
      || originUrl.pathname !== "/"
      || originUrl.search
      || originUrl.hash
      || originUrl.username
      || originUrl.password
    ) throw new DailyReviewsSecurityError("Origin 必须与驾驶舱页面同源");
  }
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}

async function readBody(request, schema) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new DailyReviewsValidationError("写入请求必须使用 application/json");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new DailyReviewsValidationError("请求体超过 128KB 安全上限");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new DailyReviewsValidationError("请求体超过 128KB 安全上限");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let raw;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) { throw new DailyReviewsValidationError("请求体不是有效 JSON", error); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new DailyReviewsValidationError(parsed.error.issues[0]?.message || "请求体字段无效", parsed.error);
  return parsed.data;
}

export function createDailyReviewsMiddleware(options = {}) {
  const store = options.store ?? createDailyReviewsStore({
    root: options.root,
    stateRoot: options.stateRoot,
    now: options.now,
    afterWrite: options.afterWrite ?? rebuildAndValidateIndex,
  });

  return async function dailyReviewsMiddleware(request, response, next) {
    let url;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); } catch { return next(); }
    if (url.pathname !== "/api/daily-reviews") return next();
    try {
      validateBoundary(request);
      if ([...url.searchParams].length > 0) throw new DailyReviewsValidationError("该接口不接受路径或查询参数");
      if (request.method === "GET") return sendJson(response, 200, await store.list());
      if (request.method === "POST") {
        const clientRequestId = request.headers["x-idempotency-key"];
        if (typeof clientRequestId !== "string" || !CLIENT_REQUEST_ID_RE.test(clientRequestId)) {
          throw new DailyReviewsValidationError("新建每日复盘缺少有效的幂等请求编号");
        }
        const body = await readBody(request, dailyReviewCreateSchema);
        return sendJson(response, 201, await store.create(body, { clientRequestId }));
      }
      if (request.method === "PUT") {
        const body = await readBody(request, putBodySchema);
        return sendJson(response, 200, await store.update(body.id, body.patch, body.expectedHash));
      }
      response.setHeader("Allow", "GET, POST, PUT");
      return sendJson(response, 405, { error: "method_not_allowed", message: "仅支持 GET、POST 和 PUT" });
    } catch (error) {
      if (error instanceof DailyReviewsConflictError) return sendJson(response, 409, { error: "hash_conflict", message: error.message, current: error.current });
      if (error instanceof DailyReviewsNotFoundError) return sendJson(response, 404, { error: "not_found", message: error.message });
      if (error instanceof DailyReviewsValidationError) return sendJson(response, error.statusCode ?? 400, { error: "invalid_request", message: error.message });
      if (error instanceof DailyReviewsSecurityError) return sendJson(response, 403, { error: "forbidden", message: error.message });
      if (error instanceof DailyReviewsCommitError) return sendJson(response, 500, {
        error: error.rollbackError ? "rollback_failed" : "index_validation_failed",
        message: error.message,
      });
      return sendJson(response, 500, { error: "internal_error", message: "每日复盘保存失败" });
    }
  };
}
