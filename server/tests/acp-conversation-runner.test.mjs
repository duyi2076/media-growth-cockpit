import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";
import { createMinimalRuntimeEnvironment } from "../ai-collaboration/acp-runner.mjs";
import { createAcpConversationRunner } from "../ai-collaboration/acp-conversation-runner.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(testDirectory, "fixtures", "mock-acp-agent.mjs");
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-conversation-acp-"));
  temporaryDirectories.push(directory);
  return directory;
}

function launch(extraEnv = {}) {
  return {
    provider: "kimi",
    executable: process.execPath,
    args: [mockAgentPath],
    env: { ...createMinimalRuntimeEnvironment(process.env), ...extraEnv },
  };
}

describe("ACP 长期会话 runner", () => {
  test("同一真实进程和 provider session 连续两轮，不重发历史", async () => {
    const cwd = await workspace();
    let snapshot;
    const runner = createAcpConversationRunner({
      launch: launch(), cwd, permissionMode: "readonly", onSession: (value) => { snapshot = value; },
    });
    const first = await runner.prompt({ text: "NO_PERMISSION MEMORY:海盐四七" });
    const second = await runner.prompt({ text: "NO_PERMISSION RECALL" });
    assert.match(first.finalText, /轮次：1/);
    assert.match(second.finalText, /记忆：海盐四七；轮次：2/);
    assert.ok(snapshot.providerSessionId.startsWith("mock-"));
    assert.equal(runner.connected, true);
    await runner.close();
    assert.equal(runner.connected, false);
  });

  test("新 Agent 进程使用公开 session/resume 恢复上下文", async () => {
    const cwd = await workspace();
    const stateFile = path.join(cwd, "mock-sessions.json");
    let saved;
    const firstRunner = createAcpConversationRunner({
      launch: launch({ MOCK_RESUME: "1", MOCK_SESSION_STATE_FILE: stateFile }),
      cwd,
      permissionMode: "readonly",
      onSession: (value) => { saved = value; },
    });
    await firstRunner.prompt({ text: "NO_PERMISSION MEMORY:松针九二" });
    await firstRunner.close();
    const secondRunner = createAcpConversationRunner({
      launch: launch({ MOCK_RESUME: "1", MOCK_SESSION_STATE_FILE: stateFile }),
      cwd,
      permissionMode: "readonly",
      savedSession: saved,
    });
    const resumed = await secondRunner.prompt({ text: "NO_PERMISSION RECALL" });
    assert.match(resumed.finalText, /记忆：松针九二；轮次：2/);
    assert.equal(resumed.continuityMode, "resumed");
    await secondRunner.close();
  });

  test("取消当前 turn 后同一 conversation 仍可继续", async () => {
    const cwd = await workspace();
    const runner = createAcpConversationRunner({ launch: launch(), cwd, permissionMode: "readonly" });
    const controller = new AbortController();
    const events = [];
    const slow = runner.prompt({
      text: "SLOW",
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.text === "等待取消") controller.abort();
      },
    });
    await assert.rejects(slow, (error) => error.name === "AbortError");
    assert.ok(events.some((event) => event.text === "等待取消"));
    const next = await runner.prompt({ text: "NO_PERMISSION MEMORY:继续" });
    await runner.close();
    assert.match(next.finalText, /已收到：NO_PERMISSION MEMORY:继续/);
  });

  test("close 调用 ACP close 并回收进程", async () => {
    const cwd = await workspace();
    const marker = path.join(cwd, "closed.txt");
    const runner = createAcpConversationRunner({
      launch: launch({ MOCK_RESUME: "1", MOCK_CLOSE_MARKER: marker }), cwd, permissionMode: "readonly",
    });
    await runner.prompt({ text: "NO_PERMISSION hello" });
    await runner.close();
    assert.match(await fs.readFile(marker, "utf8"), /^mock-/);
    assert.equal(runner.connected, false);
  });

  test("进程异常退出后用最新 session 快照恢复同一上下文", async () => {
    const cwd = await workspace();
    const stateFile = path.join(cwd, "crash-resume.json");
    const runner = createAcpConversationRunner({
      launch: launch({ MOCK_RESUME: "1", MOCK_SESSION_STATE_FILE: stateFile }), cwd, permissionMode: "readonly",
    });
    await assert.rejects(runner.prompt({ text: "NO_PERMISSION MEMORY:断线可续 CRASH_AFTER" }));
    const resumed = await runner.prompt({ text: "NO_PERMISSION RECALL" });
    assert.match(resumed.finalText, /记忆：断线可续；轮次：2/);
    assert.equal(resumed.continuityMode, "resumed");
    await runner.close();
  });

  test("进程异常退出且 provider 不支持 resume 时明确失败", async () => {
    const cwd = await workspace();
    const runner = createAcpConversationRunner({ launch: launch(), cwd, permissionMode: "readonly" });
    await assert.rejects(runner.prompt({ text: "NO_PERMISSION CRASH_AFTER" }));
    await assert.rejects(
      runner.prompt({ text: "不能伪装成连续会话" }),
      /不支持恢复长期会话/,
    );
    await runner.close();
  });

  test("跨 chunk 的凭证在流式事件和最终正文中统一脱敏", async () => {
    const cwd = await workspace();
    const events = [];
    const runner = createAcpConversationRunner({ launch: launch(), cwd, permissionMode: "readonly" });
    const result = await runner.prompt({
      text: "NO_PERMISSION SPLIT_SECRET",
      onEvent: (event) => events.push(event),
    });
    const streamed = events.filter((event) => event.type === "message").map((event) => event.text).join("");
    assert.doesNotMatch(streamed, /sk-ABCDEFGHIJK/);
    assert.doesNotMatch(result.finalText, /sk-ABCDEFGHIJK/);
    assert.match(streamed, /\[REDACTED\]/);
    assert.equal(streamed, result.finalText);
    await runner.close();
  });

  test("turn timeout 会取消协议请求并强制回收忽略取消的 Agent", async () => {
    const cwd = await workspace();
    const runner = createAcpConversationRunner({
      launch: launch(), cwd, permissionMode: "readonly", turnTimeoutMs: 50, cancelNotifyTimeoutMs: 20,
    });
    await assert.rejects(runner.prompt({ text: "IGNORE_CANCEL" }), /超时/);
    assert.equal(runner.connected, false);
    await runner.close();
  });

  test("session.close 卡死也会在短超时后回收进程", async () => {
    const cwd = await workspace();
    const runner = createAcpConversationRunner({
      launch: launch({ MOCK_RESUME: "1", MOCK_HANG_CLOSE: "1" }),
      cwd,
      permissionMode: "readonly",
      closeTimeoutMs: 50,
    });
    await runner.prompt({ text: "NO_PERMISSION hello" });
    const startedAt = Date.now();
    await runner.close();
    assert.ok(Date.now() - startedAt < 2_000);
    assert.equal(runner.connected, false);
  });
});
