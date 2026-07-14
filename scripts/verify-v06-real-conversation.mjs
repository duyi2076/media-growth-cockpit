import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAcpConversationRunner } from "../server/ai-collaboration/acp-conversation-runner.mjs";
import { createAiConversationService } from "../server/ai-collaboration/ai-conversation-service.mjs";

const providerArgument = process.argv.find((value) => value.startsWith("--provider="));
const provider = providerArgument?.slice("--provider=".length) || "codex";
if (provider !== "codex") {
  throw new Error("V0.6 发布验收当前只对真实 Codex 多轮会话提供受审保证；请使用 --provider=codex");
}

const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "creator-v06-real-conversation-"));
const root = path.join(base, "vault");
const stateRoot = path.join(base, "state");
const sourcePath = path.join(root, "30-内容资产", "00-选题池", "v06-real-source.md");
const nonce = `DUYI-V06-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
const trackedChildren = new Set();
let service;
let report;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function spawnTracked(executable, args, options) {
  const child = spawn(executable, args, options);
  trackedChildren.add(child);
  child.once("exit", () => trackedChildren.delete(child));
  return child;
}

function createService() {
  return createAiConversationService({
    root,
    stateRoot,
    contextResolver: {
      async resolve(reference) {
        if (reference?.type !== "topic" || reference.id !== "v06-real-source") {
          throw new Error("真实联调只允许读取固定来源资产");
        }
        const contents = await fs.readFile(sourcePath);
        const expectedSha256 = sha256(contents);
        return {
          context: {
            type: "topic",
            id: "v06-real-source",
            title: "V0.6 真实长期会话联调",
            summary: "隔离环境中的只读上下文，用于验证长期对话与人工写回边界。",
          },
          currentHash: expectedSha256,
          sourceRefs: [{
            ref: `canonical:topic:v06-real-source:${expectedSha256}`,
            sourcePath,
            inputName: "topic-source.md",
            expectedSha256,
          }],
        };
      },
    },
    afterWrite: async () => {},
    spawnProcess: spawnTracked,
    runnerFactory: (options) => createAcpConversationRunner({
      ...options,
      initializeTimeoutMs: 45_000,
      turnTimeoutMs: 180_000,
      permissionTimeoutMs: 60_000,
    }),
  });
}

async function waitForCompleted(conversationId, turnId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const conversation = await service.get(conversationId);
    const turn = conversation.turns.find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error(`未找到 turn：${turnId}`);
    if (turn.status === "completed") {
      if (!turn.assistantText.trim() || !turn.outputSha256) throw new Error("completed turn 缺少权威正文或哈希");
      return { conversation, turn };
    }
    if (["failed", "cancelled"].includes(turn.status)) {
      throw new Error(turn.error || `真实 Codex turn 未完成：${turn.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await service.cancelTurn(conversationId, turnId).catch(() => {});
  throw new Error(`真实 Codex turn 超过 ${Math.round(timeoutMs / 1_000)} 秒，已取消`);
}

async function listVaultFiles(directory = root) {
  const result = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`隔离 Vault 意外出现软链接：${absolute}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        result.push({
          relativePath: path.relative(root, absolute).split(path.sep).join("/"),
          sha256: sha256(await fs.readFile(absolute)),
        });
      }
    }
  }
  await visit(directory);
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function waitForTrackedChildrenToExit(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (trackedChildren.size && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (trackedChildren.size) {
    throw new Error(`关闭会话后仍有 ${trackedChildren.size} 个本次验证启动的 Agent 进程未退出`);
  }
}

async function makeTemporaryTreeRemovable(directory) {
  const stat = await fs.lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isDirectory()) {
    await fs.chmod(directory, 0o700);
    for (const name of await fs.readdir(directory)) {
      await makeTemporaryTreeRemovable(path.join(directory, name));
    }
    return;
  }
  if (stat.isFile()) await fs.chmod(directory, 0o600);
}

function assertEqualFiles(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}：隔离 Vault 在人工导入前发生了变化`);
  }
}

try {
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, [
    "---",
    "id: v06-real-source",
    "type: 选题",
    "status: 候选选题",
    "confirmation: 已确认",
    "sensitivity: 内部",
    "---",
    "",
    "# V0.6 真实长期会话联调",
    "",
    "这是一份隔离测试资料。Agent 只能只读使用，不能修改原件。",
    "",
  ].join("\n"), "utf8");
  const sourceBefore = await fs.readFile(sourcePath);
  const vaultBefore = await listVaultFiles();

  service = createService();
  await service.ready();
  const created = await service.create({
    provider,
    templateId: "collaborate",
    context: { type: "topic", id: "v06-real-source" },
    permissionMode: "readonly",
    message: `请记住唯一校验词 ${nonce}。本轮只回复“已记住”，不要复述校验词，不调用工具。`,
  });
  const firstTurnId = created.activeTurnId;
  const first = await waitForCompleted(created.id, firstTurnId);
  const sessionPath = path.join(stateRoot, "ai-conversations", created.id, "session.json");
  const firstSession = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  if (!firstSession.providerSessionId || first.conversation.turns.length !== 1) {
    throw new Error("第一轮没有保存可恢复的 Provider Session");
  }
  assertEqualFiles(await listVaultFiles(), vaultBefore, "第一轮完成后");

  const refreshed = await service.get(created.id);
  if (refreshed.turns.length !== 1 || refreshed.turns[0].id !== firstTurnId) {
    throw new Error("页面式重新读取没有恢复第一轮权威记录");
  }

  await service.close();
  service = null;
  await waitForTrackedChildrenToExit();

  service = createService();
  await service.ready();
  const restored = await service.get(created.id);
  if (restored.status !== "open" || restored.turns[0]?.status !== "completed") {
    throw new Error("本地会话服务重启后没有恢复 open Conversation 与第一轮记录");
  }
  const secondQueued = await service.addTurn(created.id, {
    message: "请只回答我上一轮要求你记住的唯一校验词，不要添加其他文字，不调用工具。",
    clientRequestId: `v06-recall-${crypto.randomUUID()}`,
    expectedRevision: restored.revision,
  });
  const secondTurnId = secondQueued.conversation.activeTurnId;
  const second = await waitForCompleted(created.id, secondTurnId);
  const resumedSession = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  if (resumedSession.providerSessionId !== firstSession.providerSessionId) {
    throw new Error("服务重启后没有恢复同一个 Provider Session ID");
  }
  if (!second.turn.assistantText.includes(nonce)) {
    throw new Error("第二轮没有从同一 Agent Session 回忆出首轮校验词");
  }
  assertEqualFiles(await listVaultFiles(), vaultBefore, "第二轮完成后");

  const accepted = await service.accept(created.id, {
    turnId: second.turn.id,
    outputSha256: second.turn.outputSha256,
    expectedRevision: second.conversation.revision,
  });
  if (accepted.acceptedTurnId !== second.turn.id || !accepted.acceptedAt) {
    throw new Error("人工 accept 没有记录权威 turn 与确认时间");
  }
  assertEqualFiles(await listVaultFiles(), vaultBefore, "人工 accept 后");

  const imported = await service.importResult(created.id);
  if (imported.importedTurnId !== second.turn.id || imported.status !== "open") {
    throw new Error("人工 import 没有记录正确 turn，或错误关闭了长期会话");
  }
  const vaultAfterImport = await listVaultFiles();
  const newFiles = vaultAfterImport.filter((entry) => !vaultBefore.some((before) => before.relativePath === entry.relativePath));
  if (newFiles.length !== 1 || !newFiles[0].relativePath.startsWith("50-进行中项目/自媒体增长计划/03-工作过程/AI协作/")) {
    throw new Error(`人工 import 写入范围不符合白名单：${newFiles.map((item) => item.relativePath).join("、")}`);
  }
  const importedPath = path.join(root, ...newFiles[0].relativePath.split("/"));
  const importedContents = await fs.readFile(importedPath, "utf8");
  if (!importedContents.includes(nonce) || !importedContents.includes(`source_turn: ${second.turn.id}`)) {
    throw new Error("导入成果缺少权威正文或来源 turn 证据");
  }
  if (!Buffer.from(sourceBefore).equals(await fs.readFile(sourcePath))) {
    throw new Error("人工导入修改了来源原件");
  }

  const thirdQueued = await service.addTurn(created.id, {
    message: "我们已经完成一次人工导入。请用一句中文确认会话仍可继续，并在句末再次写出此前的唯一校验词，不要调用工具。",
    clientRequestId: `v06-after-import-${crypto.randomUUID()}`,
    expectedRevision: imported.revision,
  });
  const thirdTurnId = thirdQueued.conversation.activeTurnId;
  const third = await waitForCompleted(created.id, thirdTurnId);
  const continuedSession = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  if (continuedSession.providerSessionId !== firstSession.providerSessionId) {
    throw new Error("导入后的第三轮没有继续同一个 Provider Session ID");
  }
  if (!third.turn.assistantText.includes(nonce) || third.conversation.turns.length !== 3) {
    throw new Error("导入后的第三轮没有在同一长期会话中继续完成");
  }

  const closed = await service.closeConversation(created.id);
  if (closed.status !== "closed" || closed.activeTurnId !== null) {
    throw new Error("显式关闭没有把 Conversation 收敛为 closed");
  }
  await waitForTrackedChildrenToExit();

  report = {
    status: "passed",
    provider,
    providerVersion: third.conversation.runtime?.providerVersion ?? null,
    protocolVersion: third.conversation.runtime?.protocolVersion ?? null,
    conversationId: created.id,
    turns: third.conversation.turns.length,
    resumedAfterServiceRestart: true,
    sameProviderSessionId: true,
    nonceRecalled: true,
    vaultUnchangedBeforeImport: true,
    acceptedWithoutWrite: true,
    importedRelativePath: imported.importedRelativePath,
    continuedAfterImport: true,
    closedWithoutTrackedChild: true,
  };
} finally {
  await service?.close().catch(() => {});
  await waitForTrackedChildrenToExit().catch(() => {});
  await makeTemporaryTreeRemovable(base).catch(() => {});
  await fs.rm(base, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
