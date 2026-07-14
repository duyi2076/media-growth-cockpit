import { z } from "zod";
import {
  AiEnvironmentConflictError,
  AiEnvironmentUnavailableError,
  AiEnvironmentValidationError,
  createAiEnvironmentActionService,
} from "./ai-environment-actions.mjs";

const MAX_BODY_BYTES = 8 * 1024;
const JOB_ID_RE = /^ai-env-[0-9a-f-]{36}$/i;
const actionSchema = z.object({
  provider: z.enum(["codex", "claude", "kimi", "antigravity", "grok"]),
  action: z.enum(["install", "update", "login"]),
}).strict();

export class AiEnvironmentApiSecurityError extends Error {}
export class AiEnvironmentApiValidationError extends Error {}

function isLoopback(value) {
  const host = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function validateBoundary(request) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress)) {
    throw new AiEnvironmentApiSecurityError("API 只接受本机回环连接");
  }
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) {
    throw new AiEnvironmentApiSecurityError("Host 必须是本机回环地址");
  }
  const hostUrl = new URL(`http://${host}`);
  if (!isLoopback(hostUrl.hostname)) throw new AiEnvironmentApiSecurityError("Host 必须是本机回环地址");
  const site = request.headers["sec-fetch-site"];
  if (site && !["same-origin", "none"].includes(site)) throw new AiEnvironmentApiSecurityError("跨站请求已拒绝");
  if (request.method === "POST") {
    if (request.headers["x-cockpit-csrf"] !== "1") throw new AiEnvironmentApiSecurityError("写入请求缺少 CSRF 标记");
    const origin = request.headers.origin;
    if (!origin) throw new AiEnvironmentApiSecurityError("写入请求必须包含同源 Origin");
    let originUrl;
    try { originUrl = new URL(origin); } catch { throw new AiEnvironmentApiSecurityError("Origin 无效"); }
    if (originUrl.protocol !== "http:" || !isLoopback(originUrl.hostname) || originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()
      || originUrl.pathname !== "/" || originUrl.search || originUrl.hash || originUrl.username || originUrl.password) {
      throw new AiEnvironmentApiSecurityError("Origin 必须与驾驶舱页面同源");
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

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw new AiEnvironmentApiValidationError("请求必须使用 application/json");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new AiEnvironmentApiValidationError("请求体过大");
    chunks.push(chunk);
  }
  let raw;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AiEnvironmentApiValidationError("请求体不是有效 JSON"); }
  const parsed = actionSchema.safeParse(raw);
  if (!parsed.success) throw new AiEnvironmentApiValidationError(parsed.error.issues[0]?.message ?? "请求字段无效");
  return parsed.data;
}

function errorResponse(error) {
  if (error instanceof AiEnvironmentApiSecurityError) return [403, "forbidden", error.message];
  if (error instanceof AiEnvironmentConflictError) return [409, "state_conflict", error.message];
  if (error instanceof AiEnvironmentUnavailableError) return [503, "unavailable", error.message];
  if (error instanceof AiEnvironmentApiValidationError || error instanceof AiEnvironmentValidationError) return [400, "invalid_request", error.message];
  return [500, "internal_error", "本机 AI 环境操作失败"];
}

export function createAiEnvironmentMiddleware(options = {}) {
  const service = options.service ?? createAiEnvironmentActionService(options);
  const middleware = async function aiEnvironmentMiddleware(request, response, next) {
    let url;
    try { url = new URL(request.url ?? "/", "http://127.0.0.1"); } catch { return next(); }
    if (url.pathname !== "/api/ai-environment/actions" && !url.pathname.startsWith("/api/ai-environment/actions/")) return next();
    try {
      validateBoundary(request);
      if ([...url.searchParams].length) throw new AiEnvironmentApiValidationError("该接口不接受查询参数");
      if (url.pathname === "/api/ai-environment/actions" && request.method === "POST") {
        return sendJson(response, 202, { job: await service.start(await readJson(request)) });
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length === 4 && JOB_ID_RE.test(parts[3] ?? "") && request.method === "GET") {
        return sendJson(response, 200, { job: service.get(parts[3]) });
      }
      response.setHeader("Allow", url.pathname === "/api/ai-environment/actions" ? "POST" : "GET");
      return sendJson(response, 405, { error: "method_not_allowed", message: "环境操作或方法不受支持" });
    } catch (error) {
      const [status, code, message] = errorResponse(error);
      return sendJson(response, status, { error: code, message });
    }
  };
  middleware.service = service;
  return middleware;
}
