import { z } from "zod";
import {
  actionTargetsInputSchema,
  ActionTargetsCommitError,
  ActionTargetsConflictError,
  ActionTargetsSecurityError,
  ActionTargetsValidationError,
  createActionTargetsStore,
} from "./action-targets-store.mjs";
import { rebuildAndValidateIndex } from "./daily-tasks-api.mjs";

const MAX_BODY_BYTES = 16 * 1024;
const putBodySchema = z.object({
  targets: actionTargetsInputSchema,
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  startCampaign: z.boolean().optional().default(false),
}).strict();

function isLoopback(value) {
  const normalized = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validateBoundary(request) {
  const address = request.socket?.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
    throw new ActionTargetsSecurityError("API 只接受本机回环连接");
  }
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) {
    throw new ActionTargetsSecurityError("Host 必须是本机回环地址");
  }
  const hostUrl = new URL(`http://${host}`);
  if (!isLoopback(hostUrl.hostname)) throw new ActionTargetsSecurityError("Host 必须是本机回环地址");
  const origin = request.headers.origin;
  if (request.method === "PUT" && !origin) throw new ActionTargetsSecurityError("PUT 请求必须包含同源 Origin");
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new ActionTargetsSecurityError("Origin 请求头无效");
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
      throw new ActionTargetsSecurityError("Origin 必须与驾驶舱页面同源");
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
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new ActionTargetsValidationError("PUT 请求必须使用 application/json");
  }
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    const error = new ActionTargetsValidationError("请求体超过 16KB 安全上限");
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new ActionTargetsValidationError("请求体超过 16KB 安全上限");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let raw;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new ActionTargetsValidationError("请求体不是有效 JSON", error);
  }
  const result = putBodySchema.safeParse(raw);
  if (!result.success) throw new ActionTargetsValidationError("请求体字段无效", result.error);
  return result.data;
}

export function createActionTargetsMiddleware(options = {}) {
  const store = options.store ?? createActionTargetsStore({
    root: options.root,
    stateRoot: options.stateRoot,
    now: options.now,
    afterWrite: options.afterWrite ?? rebuildAndValidateIndex,
  });

  return async function actionTargetsMiddleware(request, response, next) {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return next();
    }
    if (url.pathname !== "/api/action-targets") return next();

    try {
      validateBoundary(request);
      if ([...url.searchParams].length > 0) throw new ActionTargetsValidationError("该接口不接受路径或查询参数");
      if (request.method === "GET") return sendJson(response, 200, await store.read());
      if (request.method === "PUT") {
        const body = await readBody(request);
        return sendJson(response, 200, await store.write(body.targets, body.expectedHash, { startCampaign: body.startCampaign }));
      }
      response.setHeader("Allow", "GET, PUT");
      return sendJson(response, 405, { error: "method_not_allowed", message: "仅支持 GET 和 PUT" });
    } catch (error) {
      if (error instanceof ActionTargetsConflictError) {
        return sendJson(response, 409, { error: "hash_conflict", message: error.message, current: error.current });
      }
      if (error instanceof ActionTargetsValidationError) {
        return sendJson(response, error.statusCode ?? 400, { error: "invalid_request", message: error.message });
      }
      if (error instanceof ActionTargetsSecurityError) {
        return sendJson(response, 403, { error: "forbidden", message: error.message });
      }
      if (error instanceof ActionTargetsCommitError) {
        return sendJson(response, 500, {
          error: error.rollbackError ? "rollback_failed" : "index_validation_failed",
          message: error.message,
        });
      }
      return sendJson(response, 500, { error: "internal_error", message: "行动目标保存失败" });
    }
  };
}
