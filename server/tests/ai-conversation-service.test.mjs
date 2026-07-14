import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  AiConversationServiceConflictError,
  createAiConversationService,
} from "../ai-collaboration/ai-conversation-service.mjs";

const temporaryDirectories = [];
const services = [];
async function makeTreeWritable(target) {
  let stat;
  try { stat = await fs.lstat(target); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await fs.chmod(target, 0o700);
    for (const name of await fs.readdir(target)) await makeTreeWritable(path.join(target, name));
  } else if (!stat.isSymbolicLink()) await fs.chmod(target, 0o600);
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await makeTreeWritable(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }));
});

async function waitFor(service, id, predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await service.get(id);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待会话状态超时");
}

function waitForPublished(service, id, predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    let timer;
    const unsubscribe = service.subscribe(id, (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    });
    timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("等待会话发布超时"));
    }, timeoutMs);
  });
}

async function setup(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-conversation-vault-"));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-conversation-service-"));
  temporaryDirectories.push(root, stateRoot);
  const runners = [];
  const imported = [];
  let contextCalls = 0;
  let catalogAvailable = true;
  const runnerFactory = (runnerOptions) => {
    let connected = true;
    let closed = false;
    let count = 0;
    let activeAbort = null;
    const prompts = [];
    const runner = {
      prompts,
      cwd: runnerOptions.cwd,
      async prompt(input) {
        count += 1;
        prompts.push(input.text);
        await options.onPrompt?.({ runnerOptions, input, count });
        await runnerOptions.onSession?.({
          providerSessionId: "private-provider-session",
          protocolVersion: 1,
          capabilities: { agentCapabilities: { sessionCapabilities: { resume: {} } } },
          continuityMode: runnerOptions.savedSession ? "resumed" : "live",
          lastAttachedAt: "2026-07-14T00:00:00.000Z",
        });
        await input.onEvent?.({ type: "message", text: `chunk-${count}`, createdAt: "2026-07-14T00:00:00.000Z" });
        if (input.text.includes("WAIT_PERMISSION")) {
          const decision = await input.requestPermission({
            toolCallId: "tool-1",
            title: "写入",
            kind: "edit",
            options: [
              { optionId: "allow", name: "允许一次", kind: "allow_once" },
              { optionId: "reject", name: "拒绝一次", kind: "reject_once" },
            ],
          }, input.signal);
          return { finalText: `permission:${decision.optionId}`, stopReason: "end_turn", protocolVersion: 1 };
        }
        if (input.text.includes("BLOCK")) {
          await new Promise((resolve) => {
            activeAbort = resolve;
            if (input.signal.aborted) resolve();
            else input.signal.addEventListener("abort", resolve, { once: true });
          });
          const error = new Error("cancelled"); error.name = "AbortError"; throw error;
        }
        return { finalText: options.finalText ?? `answer-${count}`, stopReason: "end_turn", protocolVersion: 1 };
      },
      async cancel() { if (!options.stubbornCancel) activeAbort?.(); },
      async close() { closed = true; connected = false; },
      async suspend() { closed = true; connected = false; },
      get connected() { return connected && !closed; },
    };
    runners.push(runner);
    return runner;
  };
  const service = createAiConversationService({
    root,
    stateRoot,
    runnerFactory,
    catalogService: {
      async list() {
        if (!catalogAvailable) throw new Error("catalog unavailable");
        return { agents: [{
          id: "codex", displayName: "Codex", installed: true, status: "ready", authStatus: "authenticated",
          executablePath: "/bin/echo", adapter: { executablePath: "/bin/echo", packageName: "codex-acp", version: "1.1.2" },
          version: "0.144.1", versionStatus: "current",
        }] };
      },
    },
    contextResolver: options.contextResolver ?? { async resolve() { contextCalls += 1; throw new Error("不应调用 context resolver"); } },
    taskContextResolver: { async resolveForCreate() { throw new Error("不应调用 task resolver"); } },
    importer: {
      async importConversation(value) {
        imported.push(value);
        return { relativePath: `50-进行中项目/demo/${value.turn.id}.md`, sha256: "b".repeat(64) };
      },
    },
    permissionTimeoutMs: options.permissionTimeoutMs,
    cancelDrainTimeoutMs: options.cancelDrainTimeoutMs,
  });
  services.push(service);
  await service.ready();
  return {
    root, stateRoot, service, runners, imported,
    setCatalogAvailable(value) { catalogAvailable = value; },
    get contextCalls() { return contextCalls; },
  };
}

async function createAndComplete(service, message = "你好") {
  const created = await service.create({ provider: "codex", permissionMode: "readonly", message });
  return waitFor(service, created.id, (value) => value.turns[0].status === "completed");
}

describe("AI Conversation service", () => {
  test("自由 create 不调用权威 context resolver，同 runner 真正连续多轮", async () => {
    const fixture = await setup();
    let conversation = await createAndComplete(fixture.service, "第一轮");
    assert.equal(fixture.contextCalls, 0);
    assert.equal(conversation.templateId, "collaborate");
    assert.equal(conversation.context, null);
    const second = await fixture.service.addTurn(conversation.id, {
      message: "第二轮只发送这句话",
      clientRequestId: "second-message",
      expectedRevision: conversation.revision,
    });
    conversation = await waitFor(fixture.service, conversation.id, (value) => value.turns[1]?.status === "completed");
    assert.equal(second.created, true);
    assert.equal(fixture.runners.length, 1);
    assert.match(fixture.runners[0].prompts[0], /可持续多轮/);
    assert.equal(fixture.runners[0].prompts[1], "第二轮只发送这句话");
    assert.equal("cwd" in conversation, false);
    assert.equal(JSON.stringify(conversation).includes("private-provider-session"), false);
    assert.ok(conversation.turns.every((turn) => turn.events.every((event) => event.id)));
  });

  test("create 网络重试与并发复用同一 conversation，首轮只执行一次", async () => {
    const fixture = await setup();
    const request = {
      provider: "codex",
      permissionMode: "readonly",
      message: "并发也只执行一次",
      clientRequestId: "create-concurrent-1",
    };
    const [first, retry] = await Promise.all([
      fixture.service.create(request),
      fixture.service.create(request),
    ]);
    assert.equal(retry.id, first.id);
    const completed = await waitFor(fixture.service, first.id, (value) => value.turns[0].status === "completed");
    assert.equal(completed.turns.length, 1);
    assert.equal(fixture.runners.length, 1);
    assert.equal(fixture.runners[0].prompts.length, 1);
    assert.equal((await fixture.service.list()).conversations.length, 1);

    fixture.setCatalogAvailable(false);
    assert.equal((await fixture.service.create(request)).id, first.id, "幂等复读不应再次依赖 catalog");
    await assert.rejects(
      fixture.service.create({ ...request, message: "同一个 id 的不同请求" }),
      /已用于其他创建请求/,
    );
    assert.equal(fixture.runners[0].prompts.length, 1);
  });

  test("clientRequestId 幂等先于 revision，旧 revision 重试不重复计费", async () => {
    const { service } = await setup();
    let conversation = await createAndComplete(service);
    const input = { message: "只执行一次", clientRequestId: "idem-1", expectedRevision: conversation.revision };
    await service.addTurn(conversation.id, input);
    conversation = await waitFor(service, conversation.id, (value) => value.turns[1]?.status === "completed");
    const duplicate = await service.addTurn(conversation.id, input);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.conversation.turns.length, 2);
    await assert.rejects(
      service.addTurn(conversation.id, { message: "不同正文", clientRequestId: "idem-1", expectedRevision: conversation.revision }),
      /已用于其他消息/,
    );
  });

  test("取消等待完成后才允许下一轮，旧 execute 不会覆盖新 controller", async () => {
    const { service } = await setup();
    const created = await service.create({ provider: "codex", permissionMode: "readonly", message: "BLOCK" });
    let conversation = await waitFor(service, created.id, (value) => value.turns[0].status === "running");
    conversation = await service.cancelTurn(conversation.id, conversation.activeTurnId);
    assert.equal(conversation.turns[0].status, "cancelled");
    const next = await service.addTurn(conversation.id, {
      message: "继续",
      clientRequestId: "after-cancel",
      expectedRevision: conversation.revision,
    });
    conversation = await waitFor(service, conversation.id, (value) => value.turns[1]?.status === "completed");
    assert.equal(next.created, true);
    assert.equal(conversation.status, "open");
  });

  test("权限响应绑定 conversation + turn + permission", async () => {
    const { service } = await setup();
    const created = await service.create({ provider: "codex", permissionMode: "ask", message: "WAIT_PERMISSION" });
    let conversation = await waitFor(service, created.id, (value) => value.pendingPermission !== null);
    const pending = conversation.pendingPermission;
    await assert.rejects(
      service.respondPermission(conversation.id, `turn-00000000-0000-4000-8000-000000000000`, pending.id, "reject"),
      AiConversationServiceConflictError,
    );
    await service.respondPermission(conversation.id, pending.turnId, pending.id, "reject");
    conversation = await waitFor(service, conversation.id, (value) => value.turns[0].status === "completed");
    assert.equal(conversation.turns[0].assistantText, "permission:reject");
  });

  test("accept/hash/import gate 只导入权威 turn，导入后仍 open", async () => {
    const { service, imported } = await setup();
    let conversation = await createAndComplete(service);
    await assert.rejects(service.importResult(conversation.id), /先确认/);
    const turn = conversation.turns[0];
    await assert.rejects(
      service.accept(conversation.id, { turnId: turn.id, outputSha256: "0".repeat(64), expectedRevision: conversation.revision }),
      /正文已变化/,
    );
    conversation = await service.accept(conversation.id, {
      turnId: turn.id, outputSha256: turn.outputSha256, expectedRevision: conversation.revision,
    });
    const acceptedAt = conversation.acceptedAt;
    conversation = await service.importResult(conversation.id);
    assert.equal(imported.length, 1);
    assert.equal(imported[0].turn.assistantText, "answer-1");
    assert.equal(conversation.status, "open");
    assert.equal(conversation.importedTurnId, turn.id);
    assert.equal(conversation.acceptedAt, acceptedAt);
    const next = await service.addTurn(conversation.id, {
      message: "保存后继续",
      clientRequestId: "after-import",
      expectedRevision: conversation.revision,
    });
    assert.equal(next.created, true);
  });

  test("service close 使用 suspend，不销毁 provider session", async () => {
    const { service, runners } = await setup();
    await createAndComplete(service);
    let suspended = 0;
    let destroyed = 0;
    runners[0].suspend = async () => { suspended += 1; };
    runners[0].close = async () => { destroyed += 1; };
    await service.close();
    assert.equal(suspended, 1);
    assert.equal(destroyed, 0);
  });

  test("sourceRefs 复制进独立 workspace；Agent 相对输出不能覆盖权威 manifest", async () => {
    let sourcePath;
    const fixture = await setup({
      contextResolver: {
        async resolve() {
          const contents = "# 原文\n\n真实上下文。\n";
          await fs.writeFile(sourcePath, contents, "utf8");
          return {
            context: { type: "topic", id: "topic-safe", title: "安全上下文", summary: "摘要" },
            sourceRefs: [{
              ref: "canonical:topic:topic-safe",
              sourcePath,
              inputName: "topic-source.md",
              expectedSha256: crypto.createHash("sha256").update(contents).digest("hex"),
            }],
          };
        },
      },
      async onPrompt({ runnerOptions }) {
        await fs.writeFile(path.join(runnerOptions.cwd, "manifest.json"), "agent-local-output", "utf8");
      },
    });
    sourcePath = path.join(await fs.realpath(fixture.root), "source.md");
    const created = await fixture.service.create({
      provider: "codex",
      permissionMode: "readonly",
      message: "分析上下文",
      context: { type: "topic", id: "topic-safe" },
    });
    const conversation = await waitFor(fixture.service, created.id, (value) => value.turns[0].status === "completed");
    assert.equal("cwd" in conversation, false);
    assert.equal("sourceRefs" in conversation, false);
    const root = path.join(fixture.stateRoot, "ai-conversations", conversation.id);
    assert.equal(fixture.runners[0].cwd, path.join(root, "workspace"));
    assert.equal(await fs.readFile(path.join(root, "workspace", "manifest.json"), "utf8"), "agent-local-output");
    const authoritative = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
    assert.equal(authoritative.id, conversation.id);
    assert.equal(authoritative.cwd, path.join(root, "workspace"));
  });

  test("inputs 快照在轮次之间漂移会失败且不会再次调用 Agent", async () => {
    let sourcePath;
    const fixture = await setup({
      contextResolver: {
        async resolve() {
          const contents = "可信原文";
          await fs.writeFile(sourcePath, contents, "utf8");
          return {
            context: { type: "topic", id: "topic-drift", title: "漂移" },
            sourceRefs: [{
              ref: "canonical:topic:topic-drift", sourcePath, inputName: "source.md",
              expectedSha256: crypto.createHash("sha256").update(contents).digest("hex"),
            }],
          };
        },
      },
    });
    sourcePath = path.join(await fs.realpath(fixture.root), "source.md");
    let conversation = await waitFor(
      fixture.service,
      (await fixture.service.create({
        provider: "codex", permissionMode: "readonly", message: "第一轮",
        context: { type: "topic", id: "topic-drift" },
      })).id,
      (value) => value.turns[0].status === "completed",
    );
    const inputPath = path.join(fixture.stateRoot, "ai-conversations", conversation.id, "workspace", "inputs", "source.md");
    await fs.chmod(path.dirname(inputPath), 0o700);
    await fs.chmod(inputPath, 0o600);
    await fs.writeFile(inputPath, "篡改", "utf8");
    const terminalPublished = waitForPublished(
      fixture.service,
      conversation.id,
      (value) => value.turns[1]?.status === "failed",
    );
    await fixture.service.addTurn(conversation.id, {
      message: "第二轮", clientRequestId: "after-drift", expectedRevision: conversation.revision,
    });
    conversation = await terminalPublished;
    assert.match(conversation.turns[1].error, /快照已经变化/);
    assert.equal(fixture.runners[0].prompts.length, 1);
  });

  test("完整 finalText 会再次脱敏，跨 chunk 凭证不进入 turn.json", async () => {
    const fixture = await setup({ finalText: "结果 sk-ABCDEFGHIJK 已隐藏" });
    const conversation = await createAndComplete(fixture.service);
    assert.doesNotMatch(conversation.turns[0].assistantText, /sk-ABCDEFGHIJK/);
    assert.match(conversation.turns[0].assistantText, /\[REDACTED\]/);
    const turnPath = path.join(
      fixture.stateRoot, "ai-conversations", conversation.id, "turns", `${conversation.turns[0].id}.json`,
    );
    assert.equal((await fs.readFile(turnPath, "utf8")).includes("sk-ABCDEFGHIJK"), false);
  });

  test("权限过期由服务端清理；晚到响应不会再次修改 store", async () => {
    const fixture = await setup({ permissionTimeoutMs: 30 });
    const created = await fixture.service.create({ provider: "codex", permissionMode: "ask", message: "WAIT_PERMISSION" });
    const waiting = await waitFor(fixture.service, created.id, (value) => value.pendingPermission !== null);
    const pending = waiting.pendingPermission;
    const completed = await waitFor(fixture.service, created.id, (value) => value.turns[0].status === "completed");
    assert.equal(completed.pendingPermission, null);
    await assert.rejects(
      fixture.service.respondPermission(created.id, pending.turnId, pending.id, "reject"),
      /不再等待响应/,
    );
    assert.equal((await fixture.service.get(created.id)).pendingPermission, null);
  });

  test("第三个会话会 suspend 最久未使用的 idle runner，而非永久 503", async () => {
    const fixture = await setup();
    const first = await createAndComplete(fixture.service, "会话一");
    await createAndComplete(fixture.service, "会话二");
    await createAndComplete(fixture.service, "会话三");
    assert.equal(fixture.runners.length, 3);
    assert.equal(fixture.runners[0].connected, false);
    const next = await fixture.service.addTurn(first.id, {
      message: "恢复会话一", clientRequestId: "resume-first", expectedRevision: first.revision,
    });
    const resumed = await waitFor(fixture.service, first.id, (value) => value.turns[1]?.status === "completed");
    assert.equal(next.created, true);
    assert.equal(resumed.turns.length, 2);
    assert.equal(fixture.runners.length, 4);
  });

  test("已完成请求的幂等重试不依赖当前 catalog 可用性", async () => {
    const fixture = await setup();
    let conversation = await createAndComplete(fixture.service);
    const request = { message: "只执行一次", clientRequestId: "catalog-idem", expectedRevision: conversation.revision };
    await fixture.service.addTurn(conversation.id, request);
    conversation = await waitFor(fixture.service, conversation.id, (value) => value.turns[1]?.status === "completed");
    fixture.setCatalogAvailable(false);
    const replay = await fixture.service.addTurn(conversation.id, request);
    assert.equal(replay.created, false);
    assert.equal(replay.conversation.turns.length, 2);
  });
});
