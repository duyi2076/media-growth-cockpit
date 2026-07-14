import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  AI_RUN_PROVIDERS,
  AI_RUN_STATUSES,
  AI_RUN_TEMPLATE_IDS,
  AiRunConcurrencyError,
  AiRunLimitError,
  AiRunSecurityError,
  AiRunValidationError,
  createAiRunWorkspaceStore,
} from "../ai-collaboration/run-workspace-store.mjs";
import {
  REDACTED_VALUE,
  redactAiLogValue,
  redactSensitiveString,
} from "../ai-collaboration/redaction.mjs";

const temporaryDirectories = [];
const FIXED_NOW = new Date("2026-07-14T03:00:00.000Z");

function validRunId(index) {
  return `run-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function project() {
  const realTemporaryRoot = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(realTemporaryRoot, "creator-ai-run-store-"));
  temporaryDirectories.push(base);
  const stateRoot = path.join(base, "state");
  const sourceRoot = path.join(base, "sources");
  await fs.mkdir(sourceRoot, { recursive: true });
  return { base, stateRoot, sourceRoot };
}

function storeFor(value, options = {}) {
  let counter = 0;
  return createAiRunWorkspaceStore({
    stateRoot: value.stateRoot,
    now: () => FIXED_NOW,
    idFactory: () => validRunId(++counter),
    ...options,
  });
}

function input(overrides = {}) {
  return {
    provider: "claude",
    templateId: "analyze-topic",
    context: {
      type: "topic",
      id: "topic-001",
      title: "AI 工具如何进入真实工作流",
      summary: "只提供经用户选择的选题摘要。",
    },
    instruction: "分析这个选题，但不要直接修改任何原文件。",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("AI 协作安全任务工作区", () => {
  test("create/list/get：固定写入 stateRoot/ai-runs，建立完整目录、默认只读和连续初始事件", async () => {
    const value = await project();
    const sourcePath = path.join(value.sourceRoot, "选题.md");
    await fs.writeFile(sourcePath, "# 选题原文\n\n真实证据。\n", "utf8");
    const expectedSha256 = crypto.createHash("sha256").update("# 选题原文\n\n真实证据。\n").digest("hex");
    const store = storeFor(value);

    const created = await store.create(input({
      sourceRefs: [{ ref: "30-内容资产/00-选题池/选题.md", sourcePath, expectedSha256 }],
    }));

    assert.equal(created.runId, validRunId(1));
    assert.equal(created.provider, "claude");
    assert.equal(created.displayName, "Claude Code");
    assert.equal(created.permissionMode, "readonly");
    assert.equal(created.status, "queued");
    assert.equal(created.cwd, path.join(value.stateRoot, "ai-runs", created.runId));
    assert.equal(created.finalText, null);
    assert.equal(created.pendingPermission, null);
    assert.deepEqual(created.events.map((event) => [event.seq, event.type, event.status]), [[1, "status", "queued"]]);
    assert.equal(created.sourceRefs.length, 2);
    const generatedContext = created.sourceRefs.find((entry) => entry.inputName === "context.md");
    const copiedSource = created.sourceRefs.find((entry) => entry.inputName === "选题.md");
    assert.equal(generatedContext.relativePath, "inputs/context.md");
    assert.equal(copiedSource.relativePath, "inputs/选题.md");
    assert.match(copiedSource.sha256, /^[a-f0-9]{64}$/);
    assert.equal("sourcePath" in copiedSource, false);

    const entries = (await fs.readdir(created.cwd)).sort();
    assert.deepEqual(entries, ["events.jsonl", "inputs", "manifest.json", "outputs"]);
    assert.equal(await fs.readFile(path.join(created.cwd, "inputs", "选题.md"), "utf8"), "# 选题原文\n\n真实证据。\n");
    const contextMarkdown = await fs.readFile(path.join(created.cwd, "inputs", "context.md"), "utf8");
    assert.match(contextMarkdown, /数据与指令边界/);
    assert.match(contextMarkdown, /selectedContext/);
    assert.match(contextMarkdown, /taskInstruction/);
    const manifest = JSON.parse(await fs.readFile(path.join(created.cwd, "manifest.json"), "utf8"));
    assert.equal(manifest.runId, created.runId);
    assert.ok(manifest.sourceRefs.some((entry) => entry.ref === "30-内容资产/00-选题池/选题.md"));
    const eventLines = (await fs.readFile(path.join(created.cwd, "events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(eventLines.length, 1);
    assert.equal(JSON.parse(eventLines[0]).id, `event-${created.runId}-1`);

    assert.equal((await store.get(created.runId)).instruction, input().instruction);
    const listed = await store.list();
    assert.equal(listed.total, 1);
    assert.equal(listed.activeCount, 1);
    assert.equal(listed.maxActive, 2);
    assert.equal(listed.runs[0].runId, created.runId);
  });

  test("固定枚举：保留旧 Gemini 并新增 Antigravity，八个模板和受控权限；claude-code 被拒绝", async () => {
    assert.deepEqual(AI_RUN_PROVIDERS, ["codex", "claude", "kimi", "gemini", "antigravity", "grok"]);
    assert.deepEqual(AI_RUN_TEMPLATE_IDS, [
      "analyze-topic", "break-down-content", "draft-article", "draft-video",
      "review-content", "analyze-account", "review-day", "plan-tomorrow",
    ]);
    assert.deepEqual(AI_RUN_STATUSES, ["queued", "running", "waiting_permission", "completed", "failed", "cancelled"]);
    const value = await project();
    const store = storeFor(value);
    await assert.rejects(store.create(input({ provider: "claude-code" })), AiRunValidationError);
    await assert.rejects(store.create(input({ provider: "openai" })), AiRunValidationError);
    await assert.rejects(store.create(input({ templateId: "arbitrary-shell" })), AiRunValidationError);
    await assert.rejects(store.create(input({ permissionMode: "yolo" })), AiRunValidationError);
    await assert.rejects(store.create(input({ unexpected: true })), AiRunValidationError);
    assert.throws(() => createAiRunWorkspaceStore({ stateRoot: "relative/state" }), AiRunValidationError);
  });

  test("路径白名单：拒绝 ../ runId、stateRoot 祖先软链、ai-runs 软链和非目录节点", async () => {
    const value = await project();
    const store = storeFor(value);
    await assert.rejects(store.get("../manifest.json"), (error) => error instanceof AiRunSecurityError || error instanceof AiRunValidationError);

    const realStateParent = path.join(value.base, "real-parent");
    const linkedParent = path.join(value.base, "linked-parent");
    await fs.mkdir(realStateParent);
    await fs.symlink(realStateParent, linkedParent, "dir");
    const linkedStore = createAiRunWorkspaceStore({ stateRoot: path.join(linkedParent, "state") });
    await assert.rejects(linkedStore.create(input()), AiRunSecurityError);

    const outside = path.join(value.base, "outside");
    await fs.mkdir(value.stateRoot, { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(value.stateRoot, "ai-runs"), "dir");
    await assert.rejects(store.create(input()), AiRunSecurityError);
    assert.deepEqual(await fs.readdir(outside), []);

    await fs.rm(path.join(value.stateRoot, "ai-runs"), { force: true });
    await fs.writeFile(path.join(value.stateRoot, "ai-runs"), "not a directory", "utf8");
    await assert.rejects(store.create(input()), AiRunSecurityError);
  });

  test("源文件复制逐级拒绝软链、相对路径逃逸和超限文件，失败不留下半成品 run", async () => {
    const value = await project();
    const store = storeFor(value);
    const realFile = path.join(value.sourceRoot, "real.md");
    const linkedFile = path.join(value.sourceRoot, "linked.md");
    await fs.writeFile(realFile, "safe", "utf8");
    await fs.symlink(realFile, linkedFile, "file");
    await assert.rejects(store.create(input({
      sourceRefs: [{ ref: "linked", sourcePath: linkedFile }],
    })), AiRunSecurityError);

    await assert.rejects(store.create(input({
      sourceRefs: [{ ref: "escape", sourcePath: `${value.sourceRoot}/../sources/real.md` }],
    })), AiRunSecurityError);

    const realDirectory = path.join(value.base, "real-sources");
    const linkedDirectory = path.join(value.base, "linked-sources");
    await fs.mkdir(realDirectory);
    await fs.writeFile(path.join(realDirectory, "source.md"), "safe", "utf8");
    await fs.symlink(realDirectory, linkedDirectory, "dir");
    await assert.rejects(store.create(input({
      sourceRefs: [{ ref: "linked-parent", sourcePath: path.join(linkedDirectory, "source.md") }],
    })), AiRunSecurityError);

    const large = path.join(value.sourceRoot, "large.bin");
    await fs.writeFile(large, Buffer.alloc(5 * 1024 * 1024 + 1));
    await assert.rejects(store.create(input({
      sourceRefs: [{ ref: "large", sourcePath: large }],
    })), AiRunLimitError);

    await assert.rejects(store.create(input({
      sourceRefs: [{ ref: "changed", sourcePath: realFile, expectedSha256: "0".repeat(64) }],
    })), /权威原文在复制前发生变化/);

    const aiRunsRoot = path.join(value.stateRoot, "ai-runs");
    assert.deepEqual(await fs.readdir(aiRunsRoot), []);
  });

  test("同一进程跨 store 全局最多两个活动 run；取消释放名额", async () => {
    const value = await project();
    let counter = 0;
    const options = {
      stateRoot: value.stateRoot,
      now: () => FIXED_NOW,
      idFactory: () => validRunId(++counter),
    };
    const firstStore = createAiRunWorkspaceStore(options);
    const secondStore = createAiRunWorkspaceStore(options);
    const results = await Promise.allSettled([
      firstStore.create(input({ provider: "codex" })),
      secondStore.create(input({ provider: "kimi" })),
      firstStore.create(input({ provider: "gemini" })),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 2);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof AiRunConcurrencyError);
    assert.equal((await firstStore.list()).activeCount, 2);

    await firstStore.cancel(fulfilled[0].value.runId);
    const replacement = await secondStore.create(input({ provider: "grok" }));
    assert.equal(replacement.status, "queued");
    assert.equal((await firstStore.list()).activeCount, 2);
  });

  test("同一 run 的并发取消严格串行且幂等，只产生一个取消事件", async () => {
    const value = await project();
    const firstStore = storeFor(value);
    const secondStore = createAiRunWorkspaceStore({ stateRoot: value.stateRoot, now: () => FIXED_NOW });
    const created = await firstStore.create(input());
    const [first, second] = await Promise.all([
      firstStore.cancel(created.runId, { reason: "用户停止" }),
      secondStore.cancel(created.runId, { reason: "重复停止" }),
    ]);
    assert.equal(first.status, "cancelled");
    assert.equal(second.status, "cancelled");
    const current = await firstStore.get(created.runId);
    assert.deepEqual(current.events.map((event) => event.seq), [1, 2]);
    assert.deepEqual(current.events.map((event) => event.status), ["queued", "cancelled"]);
    assert.equal((await firstStore.list()).activeCount, 0);
    assert.doesNotReject(async () => JSON.parse(await fs.readFile(path.join(created.cwd, "manifest.json"), "utf8")));
    assert.deepEqual((await fs.readdir(created.cwd)).filter((name) => name.endsWith(".tmp")), []);
  });

  test("真实 runner 持久化接口：状态迁移、事件、最终文本和确认导入形成连续证据链", async () => {
    const value = await project();
    const store = storeFor(value);
    const created = await store.create(input({ permissionMode: "ask" }));
    const running = await store.transition(created.runId, "running", { title: "ACP 已连接" });
    assert.equal(running.status, "running");

    const appended = await store.appendEvent(created.runId, {
      type: "message",
      text: "分析完成；Authorization: Bearer do-not-store-123",
      details: { apiKey: "do-not-store-key" },
    });
    assert.equal(appended.seq, 3);
    assert.equal(appended.text.includes("do-not-store-123"), false);
    assert.equal(appended.details.apiKey, REDACTED_VALUE);

    const withText = await store.setFinalText(created.runId, "这是经过确认前的最终输出。" );
    assert.equal(withText.finalText, "这是经过确认前的最终输出。");
    const completed = await store.transition(created.runId, "completed");
    assert.equal(completed.status, "completed");
    const imported = await store.recordImport(created.runId, {
      id: "import-001",
      relativePath: "30-内容资产/01-文章/确认稿.md",
      sha256: "a".repeat(64),
    });
    assert.equal(imported.imports.length, 1);
    assert.equal(imported.imports[0].relativePath, "30-内容资产/01-文章/确认稿.md");
    assert.deepEqual(imported.events.map((event) => event.seq), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(imported.events.map((event) => event.type), [
      "status", "status", "message", "status", "completed", "status",
    ]);
    assert.equal(JSON.stringify(imported.events).includes("do-not-store-123"), false);
    await assert.rejects(store.cancel(created.runId), /不能取消/);
    await assert.rejects(store.recordImport(created.runId, {
      id: "import-002",
      relativePath: "../escape.md",
      sha256: "b".repeat(64),
    }), AiRunSecurityError);
  });

  test("权限状态机：只允许 running 发起、ID 和选项严格匹配，处理后恢复 running", async () => {
    const value = await project();
    let currentNow = new Date(FIXED_NOW);
    const store = createAiRunWorkspaceStore({
      stateRoot: value.stateRoot,
      now: () => currentNow,
      idFactory: () => validRunId(1),
    });
    const created = await store.create(input({ permissionMode: "ask" }));
    await assert.rejects(store.setPendingPermission(created.runId, {
      toolCallId: "tool-1",
      title: "写入临时输出",
      options: [{ optionId: "allow", name: "本次允许", kind: "allow_once" }],
    }), /只有 running/);
    await store.transition(created.runId, "running");
    const waiting = await store.setPendingPermission(created.runId, {
      id: "perm-001",
      toolCallId: "tool-1",
      title: "写入临时输出",
      kind: "edit",
      options: [
        { optionId: "allow", name: "本次允许", kind: "allow_once" },
        { optionId: "reject", name: "本次拒绝", kind: "reject_once" },
      ],
      details: { Cookie: "private-session" },
    });
    assert.equal(waiting.status, "waiting_permission");
    assert.equal(waiting.pendingPermission.id, "perm-001");
    assert.equal(waiting.pendingPermission.expiresAt, "2026-07-14T03:01:00.000Z");
    assert.equal(JSON.stringify(waiting.events).includes("private-session"), false);
    await assert.rejects(store.transition(created.runId, "running"), /resolvePermission/);
    await assert.rejects(store.resolvePermission(created.runId, {
      permissionId: "wrong",
      optionId: "allow",
    }), /permissionId/);
    await assert.rejects(store.resolvePermission(created.runId, {
      permissionId: "perm-001",
      optionId: "unknown",
    }), /optionId/);
    const resumed = await store.resolvePermission(created.runId, {
      permissionId: "perm-001",
      optionId: "reject",
    });
    assert.equal(resumed.status, "running");
    assert.equal(resumed.pendingPermission, null);
    assert.equal(resumed.events.at(-1).details.outcome, "reject_once");

    const waitingAgain = await store.setPendingPermission(created.runId, {
      id: "perm-002",
      toolCallId: "tool-2",
      title: "执行命令",
      options: [{ optionId: "reject", name: "拒绝", kind: "reject_once" }],
    });
    currentNow = new Date("2026-07-14T03:02:00.000Z");
    await assert.rejects(store.resolvePermission(waitingAgain.runId, {
      permissionId: "perm-002",
      optionId: "reject",
    }), /已过期/);
  });

  test("错误持久化会脱敏并终结 run；非法状态跳转和超大最终输出被拒绝", async () => {
    const value = await project();
    const store = storeFor(value);
    const created = await store.create(input());
    await assert.rejects(store.transition(created.runId, "completed"), /不允许/);
    await assert.rejects(store.transition(created.runId, "waiting_permission"), /setPendingPermission/);
    await assert.rejects(store.transition(created.runId, "failed"), /patch.error/);
    await store.transition(created.runId, "running");
    await assert.rejects(store.setFinalText(created.runId, "x".repeat(2 * 1024 * 1024 + 1)), AiRunLimitError);
    const failed = await store.setError(created.runId, {
      code: "ACP_FAILURE",
      message: "Authorization: Bearer hidden-error-token",
      details: { Cookie: "hidden-cookie", api_key: "hidden-key" },
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.message.includes("hidden-error-token"), false);
    assert.equal(JSON.stringify(failed.error).includes("hidden-cookie"), false);
    assert.equal(JSON.stringify(failed.error).includes("hidden-key"), false);
    assert.equal(failed.events.at(-1).type, "error");
    await assert.rejects(store.transition(created.runId, "running"), /不允许/);
    assert.equal((await store.list()).activeCount, 0);
  });

  test("并发事件追加按 run 串行编号；事件过大时 manifest 原子回滚", async () => {
    const value = await project();
    const store = storeFor(value);
    const created = await store.create(input());
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.appendEvent(created.runId, {
      type: "thought",
      text: `chunk-${index}`,
    })));
    const withEvents = await store.get(created.runId);
    assert.deepEqual(withEvents.events.map((event) => event.seq), Array.from({ length: 13 }, (_, index) => index + 1));
    assert.equal(new Set(withEvents.events.map((event) => event.id)).size, 13);

    await assert.rejects(store.transition(created.runId, "running", {
      details: { huge: "x".repeat(70 * 1024) },
    }), AiRunLimitError);
    const rolledBack = await store.get(created.runId);
    assert.equal(rolledBack.status, "queued");
    assert.equal(rolledBack.events.length, 13);
    assert.doesNotReject(async () => JSON.parse(await fs.readFile(path.join(created.cwd, "manifest.json"), "utf8")));
  });

  test("日志脱敏：Authorization、Bearer、Cookie、API key 和常见 token 不进入事件文件", async () => {
    const direct = redactAiLogValue({
      headers: {
        Authorization: "Bearer topsecret123",
        Cookie: "session=private-cookie",
        "x-api-key": "private-key",
      },
      apiKey: "another-key",
      message: "Authorization: Bearer leakedtoken123 Cookie=session-secret api_key=key-secret sk-abcdefghijk",
    });
    assert.equal(direct.headers.Authorization, REDACTED_VALUE);
    assert.equal(direct.headers.Cookie, REDACTED_VALUE);
    assert.equal(direct.headers["x-api-key"], REDACTED_VALUE);
    assert.equal(direct.apiKey, REDACTED_VALUE);
    assert.equal(JSON.stringify(direct).includes("topsecret123"), false);
    assert.equal(JSON.stringify(direct).includes("session-secret"), false);
    assert.equal(JSON.stringify(direct).includes("key-secret"), false);
    assert.equal(JSON.stringify(direct).includes("sk-abcdefghijk"), false);
    assert.equal(redactSensitiveString("OPENAI_API_KEY=abcdef123456").includes("abcdef123456"), false);

    const value = await project();
    const store = storeFor(value);
    const created = await store.create(input());
    await store.cancel(created.runId, {
      reason: "Authorization: Bearer leakedtoken123 Cookie=session-secret api_key=key-secret",
    });
    const rawEvents = await fs.readFile(path.join(created.cwd, "events.jsonl"), "utf8");
    assert.equal(rawEvents.includes("leakedtoken123"), false);
    assert.equal(rawEvents.includes("session-secret"), false);
    assert.equal(rawEvents.includes("key-secret"), false);
    assert.match(rawEvents, /\[REDACTED\]/);
  });

  test("输出快照：给出文件级 hash、树 hash 及新增/修改/删除/未变 diff", async () => {
    const value = await project();
    const store = storeFor(value);
    const created = await store.create(input({ permissionMode: "ask" }));
    const outputs = path.join(created.cwd, "outputs");
    await fs.writeFile(path.join(outputs, "article.md"), "version one", "utf8");
    await fs.mkdir(path.join(outputs, "assets"));
    await fs.writeFile(path.join(outputs, "assets", "notes.txt"), "keep", "utf8");

    const first = await store.snapshotOutputs(created.runId);
    assert.match(first.snapshot.treeHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.snapshot.files.map((file) => file.path), ["article.md", "assets/notes.txt"]);
    assert.deepEqual(first.diff.added.map((file) => file.path), ["article.md", "assets/notes.txt"]);
    assert.deepEqual(first.diff.modified, []);
    assert.deepEqual(first.diff.deleted, []);

    await fs.writeFile(path.join(outputs, "article.md"), "version two", "utf8");
    await fs.rm(path.join(outputs, "assets", "notes.txt"));
    await fs.writeFile(path.join(outputs, "video.md"), "new", "utf8");
    const second = await store.snapshotOutputs(created.runId, { previousSnapshot: first.snapshot });
    assert.notEqual(second.snapshot.treeHash, first.snapshot.treeHash);
    assert.deepEqual(second.diff.added.map((file) => file.path), ["video.md"]);
    assert.deepEqual(second.diff.modified.map((file) => file.path), ["article.md"]);
    assert.deepEqual(second.diff.deleted.map((file) => file.path), ["assets/notes.txt"]);
    assert.deepEqual(second.diff.unchanged, []);
    assert.notEqual(second.diff.modified[0].beforeHash, second.diff.modified[0].afterHash);

    const third = await store.snapshotOutputs(created.runId, { previousSnapshot: second.snapshot });
    assert.equal(third.snapshot.treeHash, second.snapshot.treeHash);
    assert.deepEqual(third.diff.unchanged.map((file) => file.path), ["article.md", "video.md"]);
    const current = await store.get(created.runId);
    assert.deepEqual(current.events.map((event) => event.seq), [1, 2, 3, 4]);
    assert.deepEqual(current.events.map((event) => event.type), ["status", "diff", "diff", "diff"]);
  });

  test("输出扫描逐级拒绝软链、非普通节点、../ 快照和大小超限", async () => {
    const value = await project();
    const store = storeFor(value);
    const created = await store.create(input({ permissionMode: "ask" }));
    const outputs = path.join(created.cwd, "outputs");
    const outside = path.join(value.base, "outside.txt");
    await fs.writeFile(outside, "outside", "utf8");
    await fs.symlink(outside, path.join(outputs, "escape.txt"), "file");
    await assert.rejects(store.snapshotOutputs(created.runId), AiRunSecurityError);
    await fs.rm(path.join(outputs, "escape.txt"));

    await assert.rejects(store.snapshotOutputs(created.runId, {
      previousSnapshot: { files: [{ path: "../outside.txt", sha256: "0".repeat(64), size: 1 }] },
    }), AiRunSecurityError);

    await fs.writeFile(path.join(outputs, "large.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
    await assert.rejects(store.snapshotOutputs(created.runId), AiRunLimitError);
  });

  test("受管文件被替换成软链或 inputs 被换成文件时，读取立即失败且不读取链外内容", async () => {
    const value = await project();
    const store = storeFor(value);
    const created = await store.create(input());
    const outside = path.join(value.base, "outside.json");
    await fs.writeFile(outside, JSON.stringify({ status: "completed", secret: "must-not-read" }), "utf8");
    await fs.rm(path.join(created.cwd, "manifest.json"));
    await fs.symlink(outside, path.join(created.cwd, "manifest.json"), "file");
    await assert.rejects(store.get(created.runId), AiRunSecurityError);

    await fs.rm(path.join(created.cwd, "manifest.json"), { force: true });
    await fs.writeFile(path.join(created.cwd, "manifest.json"), "{}", "utf8");
    await fs.rm(path.join(created.cwd, "inputs"), { recursive: true });
    await fs.writeFile(path.join(created.cwd, "inputs"), "not a directory", "utf8");
    await assert.rejects(store.get(created.runId), AiRunSecurityError);
  });
});
