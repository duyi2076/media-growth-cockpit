import { createAgentCatalogService } from "./agent-catalog.mjs";

export class AiAgentsValidationError extends Error {}
export class AiAgentsSecurityError extends Error {}

function isLoopback(value) {
  const normalized = value?.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validateBoundary(request) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket?.remoteAddress)) {
    throw new AiAgentsSecurityError("API 只接受本机回环连接");
  }
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) {
    throw new AiAgentsSecurityError("Host 必须是本机回环地址");
  }
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    throw new AiAgentsSecurityError("Host 请求头无效");
  }
  if (!isLoopback(hostUrl.hostname)) throw new AiAgentsSecurityError("Host 必须是本机回环地址");

  const origin = request.headers.origin;
  if (!origin) return;
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new AiAgentsSecurityError("Origin 请求头无效");
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
    throw new AiAgentsSecurityError("Origin 必须与驾驶舱页面同源");
  }
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(value));
}

export function toPublicAgentCatalog(catalog) {
  return {
    policy: catalog.policy,
    agents: catalog.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      installed: agent.installed,
      version: agent.version,
      latestStable: agent.latestStable,
      testedVersion: agent.testedVersion,
      versionStatus: agent.versionStatus,
      acpMode: agent.acpMode,
      acpStatus: agent.acpStatus,
      status: agent.status,
      authStatus: agent.authStatus,
      officialSource: agent.officialSource,
      actions: agent.actions,
      ...(agent.adapter ? {
        adapter: {
          packageName: agent.adapter.packageName,
          installed: agent.adapter.installed,
          version: agent.adapter.version ?? null,
          automaticInstall: false,
        },
      } : {}),
    })),
  };
}

export function createAiAgentsMiddleware(options = {}) {
  const service = options.service ?? createAgentCatalogService(options);

  return async function aiAgentsMiddleware(request, response, next) {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return next();
    }
    if (url.pathname !== "/api/ai-agents") return next();

    try {
      validateBoundary(request);
      const queryEntries = [...url.searchParams];
      if (
        queryEntries.some(([key, value]) => key !== "refresh" || value !== "1")
        || url.searchParams.getAll("refresh").length > 1
      ) {
        throw new AiAgentsValidationError("仅支持固定的 refresh=1 参数");
      }
      const refresh = url.searchParams.get("refresh") === "1";
      if (refresh && request.headers["x-cockpit-csrf"] !== "1") {
        throw new AiAgentsSecurityError("重新检测请求缺少驾驶舱 CSRF 标记");
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        return sendJson(response, 405, { error: "method_not_allowed", message: "仅支持 GET" });
      }
      return sendJson(response, 200, toPublicAgentCatalog(await service.list({
        refresh,
      })));
    } catch (error) {
      if (error instanceof AiAgentsValidationError) {
        return sendJson(response, 400, { error: "invalid_request", message: error.message });
      }
      if (error instanceof AiAgentsSecurityError) {
        return sendJson(response, 403, { error: "forbidden", message: error.message });
      }
      return sendJson(response, 500, { error: "probe_failed", message: "无法探测本机 AI CLI" });
    }
  };
}
