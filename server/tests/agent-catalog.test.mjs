import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  AI_AGENT_PROVIDERS,
  AgentProbeTimeoutError,
  AUTH_PROBE_TIMEOUT_MS,
  CAPABILITY_PROBE_TIMEOUT_MS,
  VERSION_PROBE_TIMEOUT_MS,
  createAgentCatalogService,
  extractSemanticVersion,
  resolveExecutable,
} from "../agent-catalog.mjs";
import { createAiAgentsMiddleware } from "../ai-agents-api.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function fixedPaths() {
  return new Map([
    ["codex", "/private/safe/bin/codex"],
    ["codex-acp", "/private/safe/bin/codex-acp"],
    ["claude", "/private/safe/bin/claude"],
    ["claude-agent-acp", "/private/safe/bin/claude-agent-acp"],
    ["kimi", "/private/safe/bin/kimi"],
    ["agy", "/private/safe/bin/agy"],
    ["grok", "/private/safe/bin/grok"],
  ]);
}

const versionsByExecutable = new Map([
  ["codex", "codex-cli 0.144.1"],
  ["claude", "2.1.207 (Claude Code)"],
  ["kimi", "kimi 0.20.1"],
  ["agy", "1.1.2"],
  ["grok", "grok 0.2.99"],
]);

function successfulCapabilityOutput(executable) {
  if (executable.endsWith("codex-acp")) return "Usage: codex-acp - ACP adapter";
  if (executable.endsWith("claude-agent-acp")) return "Usage: claude-agent-acp - ACP adapter";
  if (executable.endsWith("kimi")) return "Usage: kimi acp - Agent Client Protocol";
  if (executable.endsWith("grok")) return "Commands: stdio";
  return "";
}

describe("AI Agent Catalog", () => {
  test("注册表固定为五个 provider，适配器只保留元数据", () => {
    assert.deepEqual(AI_AGENT_PROVIDERS.map((provider) => provider.id), [
      "codex",
      "claude",
      "kimi",
      "antigravity",
      "grok",
    ]);
    assert.deepEqual(AI_AGENT_PROVIDERS.map((provider) => provider.displayName), [
      "Codex",
      "Claude Code",
      "Kimi Code",
      "Antigravity",
      "Grok Build",
    ]);
    assert.equal(AI_AGENT_PROVIDERS.find((provider) => provider.id === "codex").adapter.packageName, "@agentclientprotocol/codex-acp");
    assert.equal(AI_AGENT_PROVIDERS.find((provider) => provider.id === "claude").adapter.packageName, "@agentclientprotocol/claude-agent-acp");
  });

  test("可执行文件解析忽略相对 PATH，并把软链接归一为绝对 realpath", async () => {
    const base = await temporaryDirectory("agent-catalog-path-");
    const bin = path.join(base, "bin");
    const realBin = path.join(base, "real-bin");
    await fs.mkdir(bin);
    await fs.mkdir(realBin);
    const target = path.join(realBin, "real-codex");
    await fs.writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.symlink(target, path.join(bin, "codex"));

    const resolved = await resolveExecutable("codex", {
      env: { PATH: `relative-bin${path.delimiter}${bin}` },
    });
    assert.equal(resolved, await fs.realpath(target));
    assert.equal(path.isAbsolute(resolved), true);
    assert.equal(await resolveExecutable("../codex", { env: { PATH: bin } }), null);

    const adapter = path.join(realBin, "codex-acp");
    await fs.writeFile(adapter, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    assert.equal(await resolveExecutable("codex-acp", {
      env: { PATH: "" },
      additionalDirectories: [realBin],
    }), await fs.realpath(adapter));
  });

  test("不存在的 CLI 返回 missing，且不启动任何子进程", async () => {
    let runs = 0;
    const result = await createAgentCatalogService({
      env: { PATH: "/private/empty" },
      resolveExecutable: async () => null,
      runCommand: async () => {
        runs += 1;
        throw new Error("不应调用");
      },
    }).list();

    assert.equal(runs, 0);
    assert.equal(result.agents.length, 5);
    assert.ok(result.agents.every((agent) => agent.status === "missing" && !agent.installed));
    assert.deepEqual(result.policy, {
      automaticInstall: false,
      automaticUpgrade: false,
      credentialAccess: false,
      userConfirmedActions: true,
      supportedPlatform: "macos",
    });
  });

  test("常驻服务可从固定本机目录发现 CLI，不依赖交互式 shell PATH", async () => {
    const seen = [];
    const result = await createAgentCatalogService({
      env: { PATH: "/usr/bin:/bin" },
      cliBinDirectories: ["/private/runtime/bin", "/private/user/.kimi-code/bin"],
      resolveExecutable: async (command, options) => {
        seen.push({ command, directories: options.additionalDirectories });
        return null;
      },
    }).list();
    assert.ok(result.agents.every((agent) => agent.status === "missing"));
    assert.equal(seen.length, 5);
    assert.ok(seen.every((entry) => entry.directories.includes("/private/runtime/bin")));
    assert.ok(seen.every((entry) => entry.directories.includes("/private/user/.kimi-code/bin")));
  });

  test("版本和 ACP 能力探测只使用固定参数、绝对路径、shell:false 与固定超时", async () => {
    const paths = fixedPaths();
    const calls = [];
    const env = {
      PATH: "/private/safe/bin",
      HOME: "/private/user-home",
      OPENAI_API_KEY: "never-forward-this",
      LANG: "zh_CN.UTF-8",
    };
    const result = await createAgentCatalogService({
      env,
      resolveExecutable: async (command) => paths.get(command) ?? null,
      runCommand: async (executable, args, options) => {
        calls.push({ executable, args: [...args], options });
        if (args.length === 1 && args[0] === "--version") {
          return { stdout: versionsByExecutable.get(path.basename(executable)) ?? "", stderr: "" };
        }
        return { stdout: successfulCapabilityOutput(executable), stderr: "" };
      },
    }).list();

    assert.ok(result.agents.every((agent) => agent.status === "ready"));
    assert.equal(result.agents.find((agent) => agent.id === "codex").versionStatus, "outdated");
    assert.equal(result.agents.find((agent) => agent.id === "claude").versionStatus, "outdated");
    assert.equal(result.agents.find((agent) => agent.id === "codex").adapter.installed, true);
    assert.equal(result.agents.find((agent) => agent.id === "codex").adapter.version, "1.1.2");
    assert.equal(result.agents.find((agent) => agent.id === "claude").adapter.version, "0.59.0");
    assert.equal(calls.length, 12);
    assert.ok(calls.every((call) => path.isAbsolute(call.executable)));
    assert.ok(calls.every((call) => call.options.shell === false));
    assert.ok(calls.filter((call) => call.args[0] === "--version").every((call) => call.options.timeout === VERSION_PROBE_TIMEOUT_MS));
    const capabilityCalls = calls.filter((call) => ["acp", "agent"].includes(call.args[0]));
    const authCalls = calls.filter((call) => !["--version", "acp", "agent"].includes(call.args[0]));
    assert.ok(capabilityCalls.every((call) => call.options.timeout === CAPABILITY_PROBE_TIMEOUT_MS));
    assert.ok(authCalls.every((call) => call.options.timeout === AUTH_PROBE_TIMEOUT_MS));
    assert.ok(calls.every((call) => call.options.env.HOME === "/private/user-home"));
    assert.ok(calls.every((call) => call.options.env.OPENAI_API_KEY === undefined));
    assert.equal(calls.some((call) => /^(?:npm|npx|pnpm|yarn)$/.test(path.basename(call.executable))), false);

    const callsByExecutable = new Map(calls.map((call) => [`${path.basename(call.executable)}:${call.args.join(" ")}`, call]));
    assert.ok(callsByExecutable.has("codex:--version"));
    assert.ok(callsByExecutable.has("claude:--version"));
    assert.ok(callsByExecutable.has("kimi:acp --help"));
    assert.ok(callsByExecutable.has("agy:models"));
    assert.ok(callsByExecutable.has("grok:agent --help"));
    assert.equal(result.agents.find((agent) => agent.id === "codex").acpStatus, "available");
    assert.equal(result.agents.find((agent) => agent.id === "claude").acpStatus, "available");
  });

  test("Codex 和 Claude 缺少本机适配器时返回 adapter_required，绝不尝试 npx", async () => {
    const launched = [];
    const result = await createAgentCatalogService({
      env: { PATH: "/private/safe/bin" },
      resolveExecutable: async (command) => {
        if (["codex", "claude"].includes(command)) return `/private/safe/bin/${command}`;
        return null;
      },
      runCommand: async (executable, args) => {
        launched.push({ executable, args: [...args] });
        return {
          stdout: path.basename(executable) === "codex" ? "codex-cli 0.144.1" : "2.1.207 (Claude Code)",
          stderr: "",
        };
      },
    }).list();

    assert.equal(result.agents.find((agent) => agent.id === "codex").status, "adapter_required");
    assert.equal(result.agents.find((agent) => agent.id === "claude").status, "adapter_required");
    assert.equal(result.agents.find((agent) => agent.id === "codex").adapter.automaticInstall, false);
    assert.deepEqual(launched.map((call) => path.basename(call.executable)).sort(), ["claude", "codex"]);
  });

  test("分别标记版本探测和能力探测超时", async () => {
    const versionTimeout = await createAgentCatalogService({
      resolveExecutable: async (command) => command === "kimi" ? "/private/safe/bin/kimi" : null,
      runCommand: async () => { throw new AgentProbeTimeoutError("timeout"); },
    }).list();
    assert.equal(versionTimeout.agents.find((agent) => agent.id === "kimi").status, "timeout");
    assert.equal(versionTimeout.agents.find((agent) => agent.id === "kimi").version, null);

    let calls = 0;
    const capabilityTimeout = await createAgentCatalogService({
      resolveExecutable: async (command) => command === "kimi" ? "/private/safe/bin/kimi" : null,
      runCommand: async () => {
        calls += 1;
        if (calls === 1) return { stdout: "kimi 0.20.1", stderr: "" };
        throw new AgentProbeTimeoutError("timeout");
      },
    }).list();
    const kimi = capabilityTimeout.agents.find((agent) => agent.id === "kimi");
    assert.equal(kimi.status, "timeout");
    assert.equal(kimi.version, "0.20.1");
  });

  test("恶意或超长版本输出不会进入响应；ANSI 包裹的合法版本仍可解析", async () => {
    assert.equal(extractSemanticVersion({ stdout: "\u001b[32mcodex-cli 0.144.1\u001b[0m", stderr: "" }), "0.144.1");
    assert.equal(extractSemanticVersion({ stdout: "x".repeat(17 * 1024), stderr: "" }), null);

    const payload = `<script>globalThis.pwned=true</script>${"x".repeat(17 * 1024)}`;
    const result = await createAgentCatalogService({
      resolveExecutable: async (command) => command === "agy" ? "/private/safe/bin/agy" : null,
      runCommand: async () => ({ stdout: payload, stderr: "TOKEN=never-leak" }),
    }).list();
    const serialized = JSON.stringify(result);
    const antigravity = result.agents.find((agent) => agent.id === "antigravity");
    assert.equal(antigravity.status, "error");
    assert.equal(antigravity.version, null);
    assert.doesNotMatch(serialized, /script|pwned|TOKEN|never-leak/);
    assert.ok(result.agents.every((agent) => ["unknown", "ready", "login_required"].includes(agent.authStatus)));
  });

  test("能力输出缺少固定 ACP 标记时返回 incompatible", async () => {
    let runs = 0;
    const result = await createAgentCatalogService({
      resolveExecutable: async (command) => command === "grok" ? "/private/safe/bin/grok" : null,
      runCommand: async () => {
        runs += 1;
        return runs === 1
          ? { stdout: "grok 0.2.101", stderr: "" }
          : { stdout: "ordinary help without protocol support", stderr: "" };
      },
    }).list();
    assert.equal(result.agents.find((agent) => agent.id === "grok").status, "incompatible");
  });

  test("登录探测失败只标记 login_required，不暴露命令输出", async () => {
    let runs = 0;
    const result = await createAgentCatalogService({
      resolveExecutable: async (command) => command === "agy" ? "/private/safe/bin/agy" : null,
      runCommand: async (_executable, args) => {
        runs += 1;
        if (args[0] === "--version") return { stdout: "agy 1.1.2", stderr: "" };
        throw new Error("TOKEN=never-leak login required");
      },
    }).list();
    const antigravity = result.agents.find((agent) => agent.id === "antigravity");
    assert.equal(runs, 2);
    assert.equal(antigravity.status, "ready");
    assert.equal(antigravity.authStatus, "login_required");
    assert.doesNotMatch(JSON.stringify(result), /TOKEN|never-leak/);
  });

  test("短期复用探测结果、并发请求去重，显式 refresh 才重新探测", async () => {
    let runs = 0;
    let releaseFirstProbe;
    const firstProbeGate = new Promise((resolve) => { releaseFirstProbe = resolve; });
    const service = createAgentCatalogService({
      cacheTtlMs: 60_000,
      resolveExecutable: async (command) => command === "agy" ? "/private/safe/bin/agy" : null,
      runCommand: async (_executable, args) => {
        runs += 1;
        if (runs === 1) await firstProbeGate;
        return args[0] === "--version"
          ? { stdout: "agy 1.1.2", stderr: "" }
          : { stdout: "models", stderr: "" };
      },
    });

    const first = service.list();
    const concurrent = service.list();
    releaseFirstProbe();
    assert.equal(await first, await concurrent);
    assert.equal(runs, 2);

    await service.list();
    assert.equal(runs, 2);
    await service.list({ refresh: true });
    assert.equal(runs, 4);
  });

  test("显式 refresh 抵达旧探测途中时，会等待并强制再探测一次", async () => {
    let version = "1.0.16";
    let runs = 0;
    let releaseFirstAuth;
    let markFirstAuthStarted;
    const firstAuthGate = new Promise((resolve) => { releaseFirstAuth = resolve; });
    const firstAuthStarted = new Promise((resolve) => { markFirstAuthStarted = resolve; });
    const service = createAgentCatalogService({
      cacheTtlMs: 60_000,
      resolveExecutable: async (command) => command === "agy" ? "/private/safe/bin/agy" : null,
      runCommand: async (_executable, args) => {
        runs += 1;
        if (args[0] === "--version") return { stdout: `agy ${version}`, stderr: "" };
        if (runs === 2) {
          markFirstAuthStarted();
          await firstAuthGate;
        }
        return { stdout: "models", stderr: "" };
      },
    });

    const first = service.list();
    await firstAuthStarted;
    version = "1.1.2";
    const refreshed = service.list({ refresh: true });
    releaseFirstAuth();

    assert.equal((await first).agents.find((agent) => agent.id === "antigravity").version, "1.0.16");
    assert.equal((await refreshed).agents.find((agent) => agent.id === "antigravity").version, "1.1.2");
    assert.equal(runs, 4);
  });
});

async function withServer(middleware, run) {
  const server = http.createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404;
    response.end("not found");
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function invokeMiddleware(middleware, request) {
  return new Promise((resolve, reject) => {
    const headers = Object.create(null);
    const response = {
      statusCode: 200,
      setHeader(name, value) { headers[name.toLowerCase()] = value; },
      end(body = "") { resolve({ status: this.statusCode, headers, body: JSON.parse(body) }); },
    };
    Promise.resolve(middleware(request, response, () => reject(new Error("unexpected next")))).catch(reject);
  });
}

describe("AI Agent Catalog HTTP API", () => {
  const catalog = {
    agents: [{
      id: "kimi",
      displayName: "Kimi Code",
      installed: true,
      executablePath: "/private/safe/bin/kimi",
      version: "0.23.6",
      latestStable: "0.23.6",
      testedVersion: "0.20.1",
      versionStatus: "current",
      acpMode: "native",
      status: "ready",
      authStatus: "unknown",
    }],
    policy: { automaticInstall: false, automaticUpgrade: false, credentialAccess: false },
  };

  test("GET 返回 no-store JSON，只允许固定刷新参数，并拒绝跨源和非 GET", async () => {
    let listCalls = 0;
    const listOptions = [];
    const middleware = createAiAgentsMiddleware({
      service: { async list(options) { listCalls += 1; listOptions.push(options); return catalog; } },
    });
    await withServer(middleware, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/ai-agents`, { headers: { Origin: baseUrl } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const body = await response.json();
      assert.equal(body.agents[0].id, "kimi");
      assert.equal(body.agents[0].version, "0.23.6");
      assert.equal(body.agents[0].executablePath, undefined);
      assert.doesNotMatch(JSON.stringify(body), /private\/safe\/bin/);
      assert.deepEqual(body.policy, catalog.policy);

      assert.equal((await fetch(`${baseUrl}/api/ai-agents?refresh=true`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/api/ai-agents?refresh=1`)).status, 403);
      assert.equal((await fetch(`${baseUrl}/api/ai-agents?refresh=1`, {
        headers: { "X-Cockpit-CSRF": "1" },
      })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/ai-agents?refresh=1&refresh=1`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/api/ai-agents`, {
        method: "GET",
        headers: { Origin: "http://evil.test" },
      })).status, 403);
      const post = await fetch(`${baseUrl}/api/ai-agents`, { method: "POST" });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get("allow"), "GET");
      assert.equal(listCalls, 2);
      assert.deepEqual(listOptions, [{ refresh: false }, { refresh: true }]);
    });
  });

  test("拒绝非回环 remoteAddress 和非回环 Host", async () => {
    const middleware = createAiAgentsMiddleware({ service: { async list() { return catalog; } } });
    const remote = await invokeMiddleware(middleware, {
      url: "/api/ai-agents",
      method: "GET",
      headers: { host: "127.0.0.1:4173" },
      socket: { remoteAddress: "10.0.0.8" },
    });
    assert.equal(remote.status, 403);

    const hostileHost = await invokeMiddleware(middleware, {
      url: "/api/ai-agents",
      method: "GET",
      headers: { host: "evil.test" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    assert.equal(hostileHost.status, 403);
  });

  test("探测内部异常只返回固定错误，不泄露路径或凭证", async () => {
    const middleware = createAiAgentsMiddleware({
      service: { async list() { throw new Error("/Users/private/.config TOKEN=secret"); } },
    });
    await withServer(middleware, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/ai-agents`);
      assert.equal(response.status, 500);
      const body = await response.text();
      assert.match(body, /probe_failed/);
      assert.doesNotMatch(body, /Users|TOKEN|secret/);
    });
  });
});
