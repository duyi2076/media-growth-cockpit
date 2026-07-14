import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTION_TARGETS_RELATIVE_PATH } from "./action-targets-store.mjs";
import { CONTENT_ASSETS_RELATIVE_DIR } from "./content-assets-store.mjs";
import { DAILY_TASKS_RELATIVE_DIR } from "./daily-tasks-store.mjs";
import { PLATFORM_REGISTRY_RELATIVE_PATH } from "./platform-followers-store.mjs";
import { REVIEW_ASSETS_RELATIVE_DIR } from "./review-assets-store.mjs";
import { DAILY_REVIEWS_RELATIVE_DIR } from "./daily-reviews-store.mjs";
import { COCKPIT_SETTINGS_RELATIVE_PATH, readCockpitSettingsSync } from "./cockpit-settings-store.mjs";

export const VAULT_EVENT_SCOPES = [
  "index",
  "content-assets",
  "review-assets",
  "daily-reviews",
  "daily-tasks",
  "action-targets",
  "platform-followers",
  "cockpit-settings",
];

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isLoopbackAddress(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validateEventRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false;
  const host = request.headers.host;
  if (!host || !/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$|^\[::1\](?::\d{1,5})?$/.test(host.toLowerCase())) {
    return false;
  }
  try {
    const hostUrl = new URL(`http://${host}`);
    if (!isLoopbackHost(hostUrl.hostname)) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    const originUrl = new URL(origin);
    return originUrl.protocol === "http:"
      && isLoopbackHost(originUrl.hostname)
      && originUrl.host.toLowerCase() === hostUrl.host.toLowerCase()
      && originUrl.pathname === "/"
      && !originUrl.search
      && !originUrl.hash
      && !originUrl.username
      && !originUrl.password;
  } catch {
    return false;
  }
}

export function createVaultEventsHub(options = {}) {
  const now = options.now ?? (() => new Date());
  const clients = new Set();
  let sequence = 0;

  return {
    add(response) {
      clients.add(response);
      return () => clients.delete(response);
    },
    publish(scope) {
      if (!VAULT_EVENT_SCOPES.includes(scope)) return null;
      const event = {
        id: String(++sequence),
        scope,
        changedAt: now().toISOString(),
      };
      const message = `id: ${event.id}\nevent: vault-change\ndata: ${JSON.stringify(event)}\n\n`;
      for (const response of clients) {
        if (response.destroyed || response.writableEnded) {
          clients.delete(response);
          continue;
        }
        response.write(message);
      }
      return event;
    },
    size() {
      return clients.size;
    },
  };
}

export function createVaultEventsMiddleware({ hub }) {
  if (!hub) throw new Error("vault events hub is required");
  return function vaultEventsMiddleware(request, response, next) {
    let url;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      return next();
    }
    if (url.pathname !== "/api/vault-events") return next();
    if (request.method !== "GET") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET");
      response.end();
      return;
    }
    if ([...url.searchParams].length > 0 || !validateEventRequest(request)) {
      response.statusCode = 403;
      response.end();
      return;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.flushHeaders?.();
    response.write("retry: 1000\n\n");
    const remove = hub.add(response);
    request.once("close", remove);
  };
}

export function classifyVaultChange(root, filename) {
  if (!filename) return VAULT_EVENT_SCOPES.filter((scope) => scope !== "index");
  const relativeName = path.normalize(String(filename));
  if (relativeName.split(path.sep).some((part) => part.startsWith("."))) return [];
  const target = path.resolve(root, relativeName);
  if (!isInside(root, target)) return [];
  const relative = path.relative(root, target);
  if (relative === path.normalize(COCKPIT_SETTINGS_RELATIVE_PATH)) {
    return ["cockpit-settings", "daily-tasks", "action-targets"];
  }

  const contentRoot = path.normalize(CONTENT_ASSETS_RELATIVE_DIR);
  if (relative === contentRoot || relative.startsWith(`${contentRoot}${path.sep}`)) {
    return ["content-assets"];
  }

  const reviewRoot = path.normalize(REVIEW_ASSETS_RELATIVE_DIR);
  if (relative === reviewRoot || relative.startsWith(`${reviewRoot}${path.sep}`)) {
    return ["review-assets"];
  }

  const dailyReviewRoot = path.normalize(DAILY_REVIEWS_RELATIVE_DIR);
  if (relative === dailyReviewRoot || relative.startsWith(`${dailyReviewRoot}${path.sep}`)) {
    return ["daily-reviews"];
  }

  let runtimeSettings;
  try {
    runtimeSettings = readCockpitSettingsSync(root);
  } catch {
    runtimeSettings = null;
  }
  const projectRoot = runtimeSettings ? path.normalize(runtimeSettings.projectRelativeDir) : null;
  const dailyRoot = projectRoot ? path.join(projectRoot, "07-每日任务") : path.normalize(DAILY_TASKS_RELATIVE_DIR);
  if (
    (relative === dailyRoot || relative.startsWith(`${dailyRoot}${path.sep}`))
    && relative.endsWith(".md")
  ) {
    return ["daily-tasks"];
  }

  const actionTargetsPath = projectRoot ? path.join(projectRoot, "01-目标与验收.md") : path.normalize(ACTION_TARGETS_RELATIVE_PATH);
  if (relative === actionTargetsPath) return ["action-targets"];
  if (relative === path.normalize(PLATFORM_REGISTRY_RELATIVE_PATH)) return ["platform-followers"];
  return relative.endsWith(".md") ? ["index"] : [];
}

export function createVaultChangeWatcher(options = {}) {
  const root = path.resolve(options.root ?? process.env.V2_VAULT_ROOT ?? process.env.OBSIDIAN_VAULT_ROOT ?? path.join(os.homedir(), "第二大脑-v2"));
  const rebuild = options.rebuild;
  const publish = options.publish ?? (() => {});
  const onError = options.onError ?? (() => {});
  const debounceMs = options.debounceMs ?? 400;
  const pendingScopes = new Set();
  let timer = null;
  let retryTimer = null;
  let running = false;
  let closed = false;
  let watcher = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const retryMs = options.retryMs ?? 2_000;

  async function drain() {
    if (closed || running || pendingScopes.size === 0) return;
    running = true;
    const scopes = [...pendingScopes];
    pendingScopes.clear();
    try {
      await rebuild?.({ root, source: "vault-events-watcher" });
      for (const scope of scopes) publish(scope);
      if (!scopes.includes("index")) publish("index");
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      if (pendingScopes.size > 0 && !closed) schedule([]);
    }
  }

  function schedule(scopes) {
    if (closed) return;
    for (const scope of scopes) pendingScopes.add(scope);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, debounceMs);
  }

  function attachWatcher() {
    if (closed || watcher) return;
    const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      onError(new Error("V2 根目录不存在或为软链接，正在等待恢复"));
      retryTimer = setTimeout(() => {
        retryTimer = null;
        attachWatcher();
      }, retryMs);
      return;
    }
    try {
      watcher = fs.watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
        schedule(classifyVaultChange(root, filename));
      });
      watcher.on("error", (error) => {
        onError(error);
        watcher?.close();
        watcher = null;
        if (!closed) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            attachWatcher();
          }, retryMs);
        }
      });
      resolveReady?.();
      resolveReady = null;
    } catch (error) {
      onError(error);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        attachWatcher();
      }, retryMs);
    }
  }

  attachWatcher();

  return {
    ready,
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      watcher?.close();
      watcher = null;
    },
  };
}
