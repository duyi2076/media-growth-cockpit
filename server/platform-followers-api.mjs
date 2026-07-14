import { z } from "zod";
import { rebuildAndValidateIndex } from "./daily-tasks-api.mjs";
import {
  createPlatformFollowersStore,
  platformFollowersInputSchema,
  PlatformFollowersCommitError,
  PlatformFollowersConflictError,
  PlatformFollowersSecurityError,
  PlatformFollowersValidationError,
} from "./platform-followers-store.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const putBodySchema = z.object({
  accounts: platformFollowersInputSchema,
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function isLoopback(value) {
  const normalized = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validateBoundary(request) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress)) throw new PlatformFollowersSecurityError("API 只接受本机回环连接");
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) throw new PlatformFollowersSecurityError("Host 必须是本机回环地址");
  const hostUrl = new URL(`http://${host}`);
  if (!isLoopback(hostUrl.hostname)) throw new PlatformFollowersSecurityError("Host 必须是本机回环地址");
  const origin = request.headers.origin;
  if (request.method === "PUT" && !origin) throw new PlatformFollowersSecurityError("PUT 必须包含同源 Origin");
  if (origin) {
    const originUrl = new URL(origin);
    if (originUrl.protocol !== "http:" || !isLoopback(originUrl.hostname) || originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase() || originUrl.pathname !== "/" || originUrl.search || originUrl.hash || originUrl.username || originUrl.password) {
      throw new PlatformFollowersSecurityError("Origin 必须与驾驶舱页面同源");
    }
  }
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new PlatformFollowersValidationError("PUT 必须使用 application/json");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new PlatformFollowersValidationError("请求体超过 16KB");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let raw;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) { throw new PlatformFollowersValidationError("请求体不是有效 JSON", { cause: error }); }
  const parsed = putBodySchema.safeParse(raw);
  if (!parsed.success) throw new PlatformFollowersValidationError("请求体字段无效", { cause: parsed.error });
  return parsed.data;
}

export function createPlatformFollowersMiddleware(options = {}) {
  const store = options.store ?? createPlatformFollowersStore({
    root: options.root,
    stateRoot: options.stateRoot,
    now: options.now,
    afterWrite: options.afterWrite ?? rebuildAndValidateIndex,
  });
  return async function platformFollowersMiddleware(request, response, next) {
    let url;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); }
    catch { return next(); }
    if (url.pathname !== "/api/platform-followers") return next();
    try {
      validateBoundary(request);
      if ([...url.searchParams].length > 0) throw new PlatformFollowersValidationError("该接口不接受查询参数");
      if (request.method === "GET") return sendJson(response, 200, await store.read());
      if (request.method === "PUT") {
        const body = await readBody(request);
        return sendJson(response, 200, await store.write(body.accounts, body.expectedHash));
      }
      response.setHeader("Allow", "GET, PUT");
      return sendJson(response, 405, { error: "method_not_allowed", message: "仅支持 GET 和 PUT" });
    } catch (error) {
      if (error instanceof PlatformFollowersConflictError) return sendJson(response, 409, { error: "hash_conflict", message: error.message, current: error.current });
      if (error instanceof PlatformFollowersValidationError) return sendJson(response, error.statusCode ?? 400, { error: "invalid_request", message: error.message });
      if (error instanceof PlatformFollowersSecurityError) return sendJson(response, 403, { error: "forbidden", message: error.message });
      if (error instanceof PlatformFollowersCommitError) return sendJson(response, 500, { error: error.rollbackError ? "rollback_failed" : "index_validation_failed", message: error.message });
      return sendJson(response, 500, { error: "internal_error", message: "平台粉丝保存失败" });
    }
  };
}
