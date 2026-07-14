import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import {
  classifyAcpFailure,
  createMinimalRuntimeEnvironment,
  createProviderLaunch,
  runAcpSession,
  stripProviderRuntimeNotices,
} from "../ai-collaboration/acp-runner.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(testDirectory, "fixtures", "mock-acp-agent.mjs");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-acp-"));
  temporaryDirectories.push(directory);
  return directory;
}

function mockLaunch() {
  return {
    provider: "kimi",
    executable: process.execPath,
    args: [mockAgentPath],
    env: createMinimalRuntimeEnvironment(process.env),
  };
}

function readyAgent(id) {
  const names = { codex: "Codex", claude: "Claude Code", kimi: "Kimi Code", gemini: "Gemini CLI", antigravity: "Antigravity", grok: "Grok Build" };
  return {
    id,
    displayName: names[id],
    installed: true,
    status: "ready",
    executablePath: `/private/bin/${id}`,
    adapter: ["codex", "claude"].includes(id)
      ? { executablePath: `/private/bin/${id}-acp` }
      : undefined,
  };
}

describe("ACP Provider 启动配置", () => {
  test("六个兼容 Provider 只生成固定 executable、argv 和最小环境", () => {
    const secretEnv = {
      ...process.env,
      OPENAI_API_KEY: "sk-never-forward",
      ANTHROPIC_API_KEY: "secret",
      COOKIE: "session=secret",
    };
    const launches = Object.fromEntries(
      ["codex", "claude", "kimi", "gemini", "antigravity", "grok"].map((id) => [
        id,
        createProviderLaunch(readyAgent(id), { permissionMode: "readonly", env: secretEnv }),
      ]),
    );
    assert.deepEqual(launches.kimi.args, ["acp"]);
    assert.deepEqual(launches.gemini.args, ["--acp", "--approval-mode", "plan", "--skip-trust"]);
    assert.deepEqual(launches.grok.args, ["agent", "stdio"]);
    assert.deepEqual(launches.antigravity.args, []);
    assert.deepEqual(launches.codex.args, []);
    assert.equal(launches.codex.env.CODEX_PATH, "/private/bin/codex");
    assert.equal(launches.claude.env.CLAUDE_CODE_EXECUTABLE, "/private/bin/claude");
    for (const launch of Object.values(launches)) {
      assert.equal(launch.env.OPENAI_API_KEY, undefined);
      assert.equal(launch.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(launch.env.COOKIE, undefined);
      assert.ok(path.isAbsolute(launch.executable));
      assert.ok(launch.env.PATH.split(path.delimiter).includes(path.dirname(process.execPath)));
    }
  });
});
describe("ACP 单任务运行", () => {
  test("readonly 模式自动拒绝写入，但保留真实流式回复", async () => {
    const events = [];
    const cwd = await workspace();
    const fixedNow = new Date("2026-07-14T00:00:00.000Z");
    const result = await runAcpSession({
      launch: mockLaunch(),
      cwd,
      prompt: "请分析这个选题",
      permissionMode: "readonly",
      now: () => fixedNow,
      onEvent: (event) => events.push(event),
    });
    assert.match(result.finalText, /已收到：请分析这个选题/);
    assert.match(result.finalText, /权限结果：reject-once/);
    assert.equal(result.stopReason, "end_turn");
    assert.ok(events.some((event) => event.type === "tool_call"));
    assert.ok(events.some((event) => event.type === "completed"));
    assert.ok(events.every((event) => event.createdAt === fixedNow.toISOString()));
  });

  test("ask 模式只向界面暴露单次允许和单次拒绝", async () => {
    const cwd = await workspace();
    let permissionRequest;
    const result = await runAcpSession({
      launch: mockLaunch(),
      cwd,
      prompt: "生成一个草稿",
      permissionMode: "ask",
      requestPermission: async (request) => {
        permissionRequest = request;
        return { optionId: "allow-once" };
      },
    });
    assert.deepEqual(permissionRequest.options.map((option) => option.kind), ["allow_once", "reject_once"]);
    assert.match(result.finalText, /权限结果：allow-once/);
  });

  test("Prompt 中的 shell 特殊字符只作为 ACP 文本发送", async () => {
    const cwd = await workspace();
    const marker = path.join(cwd, "should-not-exist");
    const prompt = `请原样处理：$(touch ${marker}) && rm -rf /`;
    const result = await runAcpSession({
      launch: mockLaunch(),
      cwd,
      prompt,
      permissionMode: "readonly",
    });
    assert.match(result.finalText, /\$\(touch/);
    await assert.rejects(fs.access(marker));
  });

  test("取消会通过 ACP 停止当前会话并回收进程", async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    const events = [];
    const running = runAcpSession({
      launch: mockLaunch(),
      cwd,
      prompt: "SLOW",
      permissionMode: "readonly",
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.status === "running") controller.abort();
      },
    });
    await assert.rejects(running, (error) => error.name === "AbortError");
    assert.ok(events.some((event) => event.status === "cancelled"));
  });

  test("Claude readonly 会覆盖用户默认权限并强制切换到 plan", async () => {
    const cwd = await workspace();
    const events = [];
    const base = mockLaunch();
    const result = await runAcpSession({
      launch: {
        ...base,
        provider: "claude",
        env: { ...base.env, MOCK_SESSION_MODES: "1" },
      },
      cwd,
      prompt: "只读分析",
      permissionMode: "readonly",
      onEvent: (event) => events.push(event),
    });
    assert.match(result.finalText, /模式：plan/);
    assert.ok(events.some((event) => event.status === "mode_enforced" && event.details?.modeId === "plan"));
  });

  test("CLI 在探测后被移除时只让当前运行失败，不产生未处理 spawn error", async () => {
    const cwd = await workspace();
    await assert.rejects(
      runAcpSession({
        launch: {
          provider: "kimi",
          executable: path.join(cwd, "missing-agent"),
          args: [],
          env: createMinimalRuntimeEnvironment(process.env),
        },
        cwd,
        prompt: "连接测试",
        permissionMode: "readonly",
      }),
      /Agent 启动失败，请刷新状态后重试/,
    );
  });

  test("Gemini 旧认证被服务端拒绝时返回可行动提示且不暴露原始错误", async () => {
    const cwd = await workspace();
    const launch = {
      provider: "gemini",
      executable: process.execPath,
      args: ["-e", "console.error('IneligibleTierError: UNSUPPORTED_CLIENT token=secret-value'); process.exit(1)"],
      env: createMinimalRuntimeEnvironment(process.env),
    };
    await assert.rejects(
      runAcpSession({ launch, cwd, prompt: "连接测试", permissionMode: "readonly" }),
      (error) => {
        assert.match(error.message, /Gemini CLI 当前认证方式不受支持/);
        assert.doesNotMatch(error.message, /secret-value|token=/);
        return true;
      },
    );
  });

  test("Gemini ACP 返回迁移错误时沿 cause 链识别认证失效", () => {
    const nested = new Error("This client is no longer supported. Please migrate to the Antigravity suite of products.");
    const wrapped = new Error("Agent 运行失败", { cause: nested });
    const message = classifyAcpFailure("gemini", "", wrapped);
    assert.match(message, /Gemini CLI 当前认证方式不受支持/);
    assert.doesNotMatch(message, /Antigravity suite|client is no longer supported/i);
  });

  test("Codex 运行时技能预算提示不会混入最终交付结果", () => {
    const notice = "Warning: Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.";
    assert.equal(stripProviderRuntimeNotices("codex", `${notice}\n\n真正结果`), "真正结果");
    assert.equal(stripProviderRuntimeNotices("claude", `${notice}\n真正结果`), `${notice}\n真正结果`);
  });
});
