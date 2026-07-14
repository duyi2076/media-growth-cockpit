import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";
import {
  AiEnvironmentConflictError,
  AiEnvironmentValidationError,
  createAiEnvironmentActionService,
} from "../ai-environment-actions.mjs";
import { createAiEnvironmentMiddleware } from "../ai-environment-api.mjs";

function catalogAgent(overrides = {}) {
  return {
    id: "codex",
    displayName: "Codex",
    installed: false,
    executablePath: null,
    status: "missing",
    authStatus: "unknown",
    versionStatus: "unknown",
    ...overrides,
  };
}

async function terminalJob(service, id) {
  for (let index = 0; index < 100; index += 1) {
    const job = service.get(id);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("job did not finish");
}

async function withServer(middleware, run) {
  const server = http.createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404;
    response.end("not found");
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try { await run(baseUrl); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe("AI environment action service", () => {
  test("安装只执行服务端固定 npm 包与参数，完成后可重新探测", async () => {
    const calls = [];
    let probes = 0;
    const service = createAiEnvironmentActionService({
      platform: "darwin",
      catalogService: { async list() {
        probes += 1;
        return { agents: [probes === 1 ? catalogAgent() : catalogAgent({ installed: true, status: "ready", versionStatus: "current", version: "0.144.3" })] };
      } },
      resolveExecutable: async (command) => command === "npm" ? "/private/safe/bin/npm" : null,
      runCommand: async (executable, args, options) => {
        calls.push({ executable, args: [...args], options });
        return { stdout: "TOKEN=must-not-persist", stderr: "" };
      },
    });
    const started = await service.start({ provider: "codex", action: "install", command: "rm -rf /" });
    const finished = await terminalJob(service, started.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.message, "安装完成");
    assert.equal(probes, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, "/private/safe/bin/npm");
    assert.deepEqual(calls[0].args, ["install", "-g", "@openai/codex@latest"]);
    assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
    assert.doesNotMatch(JSON.stringify(finished), /TOKEN|rm -rf|openai\/codex/);
    await service.close();
  });

  test("Antigravity 更新只调用已验证 CLI 的官方 update，并复验版本真的变化", async () => {
    const calls = [];
    let probes = 0;
    const service = createAiEnvironmentActionService({
      platform: "darwin",
      catalogService: { async list() {
        probes += 1;
        return { agents: [catalogAgent({
          id: "antigravity",
          displayName: "Antigravity",
          installed: true,
          executablePath: "/private/safe/bin/agy",
          status: "ready",
          authStatus: "ready",
          version: probes === 1 ? "1.0.16" : "1.1.2",
          versionStatus: probes === 1 ? "outdated" : "current",
        })] };
      } },
      runCommand: async (executable, args, options) => {
        calls.push({ executable, args: [...args], options });
        return { stdout: "updated", stderr: "" };
      },
    });
    const started = await service.start({ provider: "antigravity", action: "update" });
    const finished = await terminalJob(service, started.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.message, "更新完成");
    assert.equal(probes, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, "/private/safe/bin/agy");
    assert.deepEqual(calls[0].args, ["update"]);
    await service.close();
  });

  test("npm 更新锁定当前 CLI 所属前缀，并绕过目录缓存重新探测", async () => {
    const calls = [];
    const listCalls = [];
    let probes = 0;
    const service = createAiEnvironmentActionService({
      platform: "darwin",
      catalogService: { async list(options) {
        listCalls.push(options);
        probes += 1;
        return { agents: [catalogAgent({
          installed: true,
          executablePath: "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
          status: "ready",
          authStatus: "ready",
          version: probes === 1 ? "0.144.1" : "0.144.4",
          versionStatus: probes === 1 ? "outdated" : "current",
        })] };
      } },
      resolveExecutable: async (command, options) => {
        assert.equal(command, "npm");
        assert.equal(options.additionalDirectories[0], "/opt/homebrew/bin");
        return "/opt/homebrew/bin/npm";
      },
      runCommand: async (executable, args, options) => {
        calls.push({ executable, args: [...args], options });
        return { stdout: "updated", stderr: "" };
      },
    });
    const started = await service.start({ provider: "codex", action: "update" });
    const finished = await terminalJob(service, started.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.message, "更新完成");
    assert.deepEqual(listCalls, [undefined, { refresh: true }]);
    assert.equal(calls[0].executable, "/opt/homebrew/bin/npm");
    assert.deepEqual(calls[0].args, ["install", "--global", "--prefix", "/opt/homebrew", "@openai/codex@latest"]);
    await service.close();
  });

  test("无法确认安装来源时拒绝写入另一份 npm 全局目录", async () => {
    const service = createAiEnvironmentActionService({
      platform: "darwin",
      catalogService: { async list() { return { agents: [catalogAgent({
        installed: true,
        executablePath: "/Applications/Codex.app/Contents/MacOS/codex",
        status: "ready",
        versionStatus: "outdated",
        version: "0.144.1",
      })] }; } },
      resolveExecutable: async () => { throw new Error("不应查找 npm"); },
      runCommand: async () => { throw new Error("不应执行更新"); },
    });
    const started = await service.start({ provider: "codex", action: "update" });
    const finished = await terminalJob(service, started.id);
    assert.equal(finished.status, "failed");
    assert.match(finished.message, /无法确认当前 AI 的 npm 安装目录/);
    await service.close();
  });

  test("不会把未生效安装或无变化更新报告成成功，也不执行不需要的登录", async () => {
    const missing = createAiEnvironmentActionService({
      platform: "darwin",
      catalogService: { async list() { return { agents: [catalogAgent()] }; } },
      resolveExecutable: async () => "/private/safe/bin/npm",
      runCommand: async () => ({ stdout: "", stderr: "" }),
    });
    const install = await missing.start({ provider: "codex", action: "install" });
    assert.equal((await terminalJob(missing, install.id)).status, "failed");
    assert.match(missing.get(install.id).message, /仍未检测到/);
    await missing.close();

    const ready = createAiEnvironmentActionService({
      platform: "darwin",
      catalogService: { async list() { return { agents: [catalogAgent({ installed: true, executablePath: "/private/safe/bin/codex", status: "ready", authStatus: "ready", versionStatus: "current", version: "0.144.3" })] }; } },
    });
    const login = await ready.start({ provider: "codex", action: "login" });
    assert.equal((await terminalJob(ready, login.id)).status, "failed");
    assert.match(ready.get(login.id).message, /不需要重新登录/);
    await ready.close();
  });

  test("只允许一个环境任务，活动会话 Provider 不允许安装或更新", async () => {
    let release;
    let probes = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    const service = createAiEnvironmentActionService({
      platform: "darwin",
      catalogService: { async list() {
        probes += 1;
        return { agents: [probes === 1 ? catalogAgent() : catalogAgent({ installed: true, status: "ready", versionStatus: "current", version: "0.144.3" })] };
      } },
      resolveExecutable: async () => "/private/safe/bin/npm",
      runCommand: async () => gate,
    });
    const first = await service.start({ provider: "codex", action: "install" });
    await assert.rejects(service.start({ provider: "grok", action: "install" }), AiEnvironmentConflictError);
    release({ stdout: "", stderr: "" });
    assert.equal((await terminalJob(service, first.id)).status, "completed");
    await service.close();

    const guarded = createAiEnvironmentActionService({
      platform: "darwin",
      isProviderActive: (provider) => provider === "codex",
      catalogService: { async list() { return { agents: [catalogAgent()] }; } },
    });
    const blocked = await guarded.start({ provider: "codex", action: "install" });
    assert.equal((await terminalJob(guarded, blocked.id)).status, "failed");
    assert.match(guarded.get(blocked.id).message, /正在会话/);
    await guarded.close();
  });

  test("登录仅打开固定 Terminal 流程；无效 Provider 和操作直接拒绝", async () => {
    const calls = [];
    const service = createAiEnvironmentActionService({
      platform: "darwin",
      catalogService: { async list() { return { agents: [catalogAgent({ id: "antigravity", displayName: "Antigravity", installed: true, executablePath: "/private/safe/bin/agy", status: "ready", authStatus: "login_required" })] }; } },
      runCommand: async (executable, args) => { calls.push({ executable, args: [...args] }); return { stdout: "", stderr: "" }; },
    });
    await assert.rejects(service.start({ provider: "unknown", action: "install" }), AiEnvironmentValidationError);
    await assert.rejects(service.start({ provider: "codex", action: "shell" }), AiEnvironmentValidationError);
    const started = await service.start({ provider: "antigravity", action: "login" });
    const finished = await terminalJob(service, started.id);
    assert.equal(finished.status, "terminal_opened");
    assert.equal(calls[0].executable, "/usr/bin/open");
    assert.deepEqual(calls[0].args.slice(0, 2), ["-a", "Terminal"]);
    assert.equal(calls[0].args.length, 3);
    await service.close();
  });
});

describe("AI environment HTTP API", () => {
  test("POST 需要回环同源与 CSRF，strict schema 拒绝浏览器命令字段", async () => {
    const service = {
      async start(input) { return { id: "ai-env-11111111-1111-4111-8111-111111111111", ...input, status: "queued", message: "等待处理", createdAt: "2026-07-14T00:00:00.000Z", updatedAt: "2026-07-14T00:00:00.000Z" }; },
      get() { throw new Error("unused"); },
    };
    const middleware = createAiEnvironmentMiddleware({ service });
    await withServer(middleware, async (baseUrl) => {
      const missingCsrf = await fetch(`${baseUrl}/api/ai-environment/actions`, {
        method: "POST",
        headers: { Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", action: "install" }),
      });
      assert.equal(missingCsrf.status, 403);

      const injected = await fetch(`${baseUrl}/api/ai-environment/actions`, {
        method: "POST",
        headers: { Origin: baseUrl, "X-Cockpit-CSRF": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", action: "install", command: "rm -rf /" }),
      });
      assert.equal(injected.status, 400);

      const valid = await fetch(`${baseUrl}/api/ai-environment/actions`, {
        method: "POST",
        headers: { Origin: baseUrl, "X-Cockpit-CSRF": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", action: "install" }),
      });
      assert.equal(valid.status, 202);
      assert.equal((await valid.json()).job.provider, "codex");
    });
  });
});
