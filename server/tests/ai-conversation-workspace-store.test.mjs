import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  AiConversationConflictError,
  AiConversationSecurityError,
  createAiConversationWorkspaceStore,
} from "../ai-collaboration/conversation-workspace-store.mjs";

const temporaryDirectories = [];
async function makeTreeWritable(target) {
  let stat;
  try { stat = await fs.lstat(target); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await fs.chmod(target, 0o700);
    for (const name of await fs.readdir(target)) await makeTreeWritable(path.join(target, name));
  } else if (!stat.isSymbolicLink()) {
    await fs.chmod(target, 0o600);
  }
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await makeTreeWritable(directory);
    await fs.rm(directory, { recursive: true, force: true });
  }));
});

async function setup() {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-conversation-store-"));
  temporaryDirectories.push(stateRoot);
  let tick = 0;
  const store = createAiConversationWorkspaceStore({
    stateRoot,
    now: () => new Date(Date.parse("2026-07-14T00:00:00.000Z") + tick++ * 1_000),
  });
  return { stateRoot, store };
}

async function createConversation(store) {
  return store.create({
    provider: "codex",
    permissionMode: "readonly",
    message: "先讨论这个工作",
    clientRequestId: "create-request",
  });
}

describe("Conversation 权威工作区", () => {
  test("无 context 也能创建 collaborate 会话并生成固定目录", async () => {
    const { stateRoot, store } = await setup();
    const conversation = await createConversation(store);
    assert.equal(conversation.templateId, "collaborate");
    assert.equal(conversation.context, null);
    assert.equal(conversation.status, "open");
    assert.equal(conversation.turns[0].status, "queued");
    const root = path.join(stateRoot, "ai-conversations", conversation.id);
    for (const relative of ["manifest.json", `turns/${conversation.turns[0].id}.json`, `events/${conversation.turns[0].id}.jsonl`]) {
      assert.equal((await fs.lstat(path.join(root, relative))).isFile(), true);
    }
    assert.equal((await fs.lstat(path.join(root, "workspace"))).isDirectory(), true);
    await assert.rejects(fs.lstat(path.join(root, "workspace", "inputs")), { code: "ENOENT" });
    await assert.rejects(fs.lstat(path.join(root, "workspace", "manifest.json")), { code: "ENOENT" });
    await store.setSession(conversation.id, {
      providerSessionId: "private-session-id",
      protocolVersion: 1,
      capabilities: { agentCapabilities: { sessionCapabilities: { resume: {} } } },
      continuityMode: "live",
      lastAttachedAt: "2026-07-14T00:00:01.000Z",
    });
    assert.equal((await store.getSession(conversation.id)).providerSessionId, "private-session-id");
  });

  test("create 的 clientRequestId 在并发与网络重试下只创建一个会话", async () => {
    const { store } = await setup();
    const request = {
      provider: "codex",
      permissionMode: "readonly",
      message: "只创建一次",
      clientRequestId: "create-idempotent",
      createRequestSha256: "a".repeat(64),
    };
    const [first, retry] = await Promise.all([store.create(request), store.create(request)]);
    assert.equal(retry.id, first.id);
    assert.equal(retry.turns[0].id, first.turns[0].id);
    assert.equal((await store.list()).conversations.length, 1);
    assert.equal((await store.findConversationByClientRequest({
      clientRequestId: request.clientRequestId,
      message: request.message,
      createRequestSha256: request.createRequestSha256,
    })).id, first.id);
    await assert.rejects(store.create({ ...request, message: "不同正文" }), /已用于其他创建请求/);
    await assert.rejects(
      store.create({ ...request, createRequestSha256: "b".repeat(64) }),
      /已用于其他创建请求/,
    );
  });

  test("manifest 幂等映射严格校验，同时兼容没有创建指纹的旧会话", async () => {
    const { stateRoot, store } = await setup();
    const conversation = await createConversation(store);
    const manifestPath = path.join(stateRoot, "ai-conversations", conversation.id, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    delete manifest.clientRequests["create-request"].createRequestSha256;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const restarted = createAiConversationWorkspaceStore({ stateRoot });
    assert.equal((await restarted.get(conversation.id)).id, conversation.id);
    await assert.rejects(restarted.findConversationByClientRequest({
      clientRequestId: "create-request",
      message: "先讨论这个工作",
      createRequestSha256: "a".repeat(64),
    }), /旧会话，无法安全重放/);

    manifest.clientRequests["create-request"].unexpected = true;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(restarted.get(conversation.id), /包含未知字段/);
  });

  test("同会话多轮、幂等键和 revision 冲突均由权威 store 控制", async () => {
    const { store } = await setup();
    let conversation = await createConversation(store);
    const firstId = conversation.activeTurnId;
    await store.startTurn(conversation.id, firstId);
    conversation = (await store.completeTurn(conversation.id, firstId, { assistantText: "第一轮回答", stopReason: "end_turn" })).conversation;
    const revision = conversation.revision;
    const second = await store.createTurn(conversation.id, {
      message: "请继续",
      clientRequestId: "message-2",
      expectedRevision: revision,
    });
    assert.equal(second.created, true);
    assert.equal(second.turn.seq, 2);
    const duplicate = await store.createTurn(conversation.id, {
      message: "请继续",
      clientRequestId: "message-2",
      expectedRevision: revision,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.turn.id, second.turn.id);
    await assert.rejects(
      store.createTurn(conversation.id, { message: "其他正文", clientRequestId: "message-2", expectedRevision: duplicate.conversation.revision }),
      AiConversationConflictError,
    );
    await assert.rejects(
      store.createTurn(conversation.id, { message: "第三条", clientRequestId: "message-3", expectedRevision: revision }),
      /版本已变化/,
    );
  });

  test("取消或失败只结束当前 turn，会话仍 open 且可继续", async () => {
    const { store } = await setup();
    let conversation = await createConversation(store);
    await store.startTurn(conversation.id, conversation.activeTurnId);
    conversation = (await store.cancelTurn(conversation.id, conversation.activeTurnId)).conversation;
    assert.equal(conversation.status, "open");
    assert.equal(conversation.activeTurnId, null);
    const next = await store.createTurn(conversation.id, {
      message: "取消后继续",
      clientRequestId: "after-cancel",
      expectedRevision: conversation.revision,
    });
    assert.equal(next.turn.seq, 2);
  });

  test("权限严格绑定当前 turn，事件有稳定 id", async () => {
    const { store } = await setup();
    let conversation = await createConversation(store);
    const turnId = conversation.activeTurnId;
    await store.startTurn(conversation.id, turnId);
    const event = await store.appendEvent(conversation.id, turnId, {
      type: "message", text: "你好", createdAt: "2026-07-14T00:00:02.000Z",
    });
    assert.equal(event.id, `event-${turnId}-1`);
    await store.setPendingPermission(conversation.id, turnId, {
      id: "perm-one",
      toolCallId: "tool-1",
      title: "写文件",
      kind: "edit",
      options: [{ optionId: "reject", name: "拒绝", kind: "reject_once" }],
      createdAt: "2026-07-14T00:00:03.000Z",
      expiresAt: "2026-07-14T00:01:03.000Z",
    });
    await assert.rejects(
      store.resolvePermission(conversation.id, `turn-${crypto.randomUUID()}`, "perm-one", "reject"),
      AiConversationConflictError,
    );
    conversation = await store.resolvePermission(conversation.id, turnId, "perm-one", "reject");
    assert.equal(conversation.pendingPermission, null);
    assert.equal(conversation.turns[0].status, "running");
  });

  test("accept 校验权威 hash；import 记录后仍 open 并可继续", async () => {
    const { store } = await setup();
    let conversation = await createConversation(store);
    const turnId = conversation.activeTurnId;
    await store.startTurn(conversation.id, turnId);
    conversation = (await store.completeTurn(conversation.id, turnId, { assistantText: "可导入成果", stopReason: "end_turn" })).conversation;
    const turn = conversation.turns[0];
    await assert.rejects(
      store.accept(conversation.id, { turnId, outputSha256: "0".repeat(64), expectedRevision: conversation.revision }),
      /正文已变化/,
    );
    conversation = await store.accept(conversation.id, {
      turnId, outputSha256: turn.outputSha256, expectedRevision: conversation.revision,
    });
    conversation = await store.recordImport(conversation.id, {
      turnId,
      outputSha256: turn.outputSha256,
      expectedRevision: conversation.revision,
      relativePath: "50-进行中项目/demo/成果.md",
      sha256: "a".repeat(64),
    });
    assert.equal(conversation.status, "open");
    assert.equal(conversation.importedTurnId, turnId);
    const next = await store.createTurn(conversation.id, {
      message: "导入后继续",
      clientRequestId: "after-import",
      expectedRevision: conversation.revision,
    });
    assert.equal(next.created, true);
  });

  test("状态目录中的软链接会被拒绝", async () => {
    const { stateRoot } = await setup();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-outside-"));
    temporaryDirectories.push(outside);
    await fs.symlink(outside, path.join(stateRoot, "ai-conversations"));
    const store = createAiConversationWorkspaceStore({ stateRoot });
    await assert.rejects(createConversation(store), AiConversationSecurityError);
  });

  test("启动修复会清理 manifest 指向 terminal turn 的 stale activeTurnId", async () => {
    const { stateRoot, store } = await setup();
    let conversation = await createConversation(store);
    const turnId = conversation.activeTurnId;
    await store.startTurn(conversation.id, turnId);
    conversation = (await store.completeTurn(conversation.id, turnId, { assistantText: "完成", stopReason: "end_turn" })).conversation;
    const manifestPath = path.join(stateRoot, "ai-conversations", conversation.id, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.activeTurnId = turnId;
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const restarted = createAiConversationWorkspaceStore({ stateRoot });
    const listed = await restarted.list();
    assert.equal(listed.conversations[0].activeTurnId, null);
    const next = await restarted.createTurn(conversation.id, {
      message: "修复后继续",
      clientRequestId: "after-repair",
      expectedRevision: listed.conversations[0].revision,
    });
    assert.equal(next.created, true);
  });

  test("权威 sourceRefs 只复制到隔离 workspace，manifest 不保留源绝对路径", async () => {
    const { stateRoot, store } = await setup();
    const realStateRoot = await fs.realpath(stateRoot);
    const sourcePath = path.join(realStateRoot, "source.md");
    const sourceText = "# 权威原文\n\n真实证据。\n";
    await fs.writeFile(sourcePath, sourceText, "utf8");
    const expectedSha256 = crypto.createHash("sha256").update(sourceText).digest("hex");
    const conversation = await store.create({
      provider: "codex",
      permissionMode: "readonly",
      message: "基于原文讨论",
      clientRequestId: "with-source",
      context: { type: "topic", id: "topic-1", title: "测试选题", summary: "摘要" },
      sourceRefs: [{ ref: "canonical:topic:topic-1", sourcePath, inputName: "topic-source.md", expectedSha256 }],
    });
    const root = path.join(stateRoot, "ai-conversations", conversation.id);
    assert.equal(
      await fs.readFile(path.join(root, "workspace", "inputs", "topic-source.md"), "utf8"),
      sourceText,
    );
    const manifestText = await fs.readFile(path.join(root, "manifest.json"), "utf8");
    assert.equal(manifestText.includes(sourcePath), false);
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(manifest.sourceRefs, [{
      ref: "canonical:topic:topic-1",
      inputName: "topic-source.md",
      relativePath: "workspace/inputs/topic-source.md",
      sha256: expectedSha256,
      size: Buffer.byteLength(sourceText),
    }]);
    assert.equal(await store.verifyInputs(conversation.id), true);
  });

  test("inputs 快照 hash 或文件集合漂移会阻断后续执行", async () => {
    const { stateRoot, store } = await setup();
    const sourcePath = path.join(await fs.realpath(stateRoot), "source.md");
    const sourceText = "不可变快照";
    await fs.writeFile(sourcePath, sourceText, "utf8");
    const conversation = await store.create({
      provider: "codex", permissionMode: "readonly", message: "读取", clientRequestId: "drift-source",
      context: { type: "topic", id: "topic-2", title: "漂移测试" },
      sourceRefs: [{
        ref: "canonical:topic:topic-2",
        sourcePath,
        inputName: "source.md",
        expectedSha256: crypto.createHash("sha256").update(sourceText).digest("hex"),
      }],
    });
    const inputPath = path.join(stateRoot, "ai-conversations", conversation.id, "workspace", "inputs", "source.md");
    await fs.chmod(path.dirname(inputPath), 0o700);
    await fs.chmod(inputPath, 0o600);
    await fs.writeFile(inputPath, "已被篡改", "utf8");
    await assert.rejects(store.verifyInputs(conversation.id), /快照已经变化/);
  });

  test("repair 会补齐崩溃窗口中的事件计数，坏会话不会拖垮其他会话", async () => {
    const { stateRoot, store } = await setup();
    const conversation = await createConversation(store);
    const turnId = conversation.activeTurnId;
    const eventPath = path.join(stateRoot, "ai-conversations", conversation.id, "events", `${turnId}.jsonl`);
    const event = { id: `event-${turnId}-1`, seq: 1, type: "message", text: "已落盘", createdAt: "2026-07-14T00:00:02.000Z" };
    await fs.appendFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");

    const orphanId = `conv-${crypto.randomUUID()}`;
    await fs.mkdir(path.join(stateRoot, "ai-conversations", orphanId, "workspace"), { recursive: true });
    const restarted = createAiConversationWorkspaceStore({ stateRoot });
    const listed = await restarted.list();
    assert.equal(listed.conversations.length, 1);
    assert.equal(listed.conversations[0].turns[0].eventCount, 1);
    assert.deepEqual(listed.conversations[0].turns[0].events, [event]);
    assert.deepEqual(listed.errors, [{ conversationId: orphanId, code: "AiConversationNotFoundError" }]);
  });

  test("错误 source hash 在创建任何 conversation 目录前被拒绝", async () => {
    const { stateRoot, store } = await setup();
    const sourcePath = path.join(await fs.realpath(stateRoot), "source.md");
    await fs.writeFile(sourcePath, "原文", "utf8");
    await assert.rejects(store.create({
      provider: "codex", permissionMode: "readonly", message: "读取", clientRequestId: "wrong-hash",
      context: { type: "topic", id: "topic-3", title: "错误哈希" },
      sourceRefs: [{ ref: "canonical:topic:topic-3", sourcePath, inputName: "source.md", expectedSha256: "0".repeat(64) }],
    }), /原文已经变化/);
    const entries = await fs.readdir(path.join(stateRoot, "ai-conversations")).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    assert.deepEqual(entries, []);
  });
});
