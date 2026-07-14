import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAiRunService } from "../server/ai-collaboration/ai-run-service.mjs";
import { createContentAssetsStore } from "../server/content-assets-store.mjs";
import { createDailyTasksStore, shanghaiDate } from "../server/daily-tasks-store.mjs";

const providerArgument = process.argv.find((value) => value.startsWith("--provider="));
const provider = providerArgument?.slice("--provider=".length) || "codex";
if (!["codex", "claude", "kimi", "grok"].includes(provider)) {
  throw new Error("V0.5 一次性任务只支持 codex、claude、kimi 或 grok；Antigravity 请使用 V0.6.1 长期会话验证");
}

const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "creator-v05-real-agent-"));
const root = path.join(base, "vault");
const stateRoot = path.join(base, "state");
const date = shanghaiDate(new Date());
let service;

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function waitForTerminal(runId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const run = await service.get(runId);
    if (["completed", "failed", "cancelled"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await service.cancel(runId).catch(() => {});
  throw new Error("真实 Agent 联调超过 120 秒，已取消");
}

try {
  await fs.mkdir(root, { recursive: true });
  const contentStore = createContentAssetsStore({ root, stateRoot });
  const dailyTasksStore = createDailyTasksStore({ root, stateRoot });
  const source = await contentStore.create({
    title: "V0.5 真实联调选题",
    summary: "验证今日任务经过本机 Agent 后，可以在人工确认环节生成可追溯内容草稿。",
    status: "候选选题",
    format: "文章",
    channels: [],
    priority: null,
    dueAt: null,
    nextAction: "交给 AI 形成草稿",
  });
  const sourceDirectory = path.join(root, "30-内容资产", "00-选题池");
  const sourceFileName = (await fs.readdir(sourceDirectory)).find((name) => name.endsWith(".md"));
  if (!sourceFileName) throw new Error("未找到真实联调来源文件");
  const sourcePath = path.join(sourceDirectory, sourceFileName);

  await dailyTasksStore.write(date, [{
    id: "v05-real-agent-task",
    title: "用本机 AI 完成一篇可审核文章草稿",
    done: false,
    linkType: "topic",
    linkId: source.id,
  }], null);

  const contextResolver = {
    async resolve(reference) {
      if (reference?.type !== "topic" || reference.id !== source.id) {
        throw new Error("真实联调只允许读取固定来源选题");
      }
      const contents = await fs.readFile(sourcePath);
      const currentHash = sha256(contents);
      return {
        context: {
          type: "topic",
          id: source.id,
          title: source.title,
          summary: "将真实选题形成一份短小、可审核的文章草稿。",
        },
        currentHash,
        sourceRefs: [{
          ref: `canonical:topic:${source.id}:${currentHash}`,
          sourcePath,
          inputName: "topic-source.md",
          expectedSha256: currentHash,
        }],
      };
    },
  };

  service = createAiRunService({
    root,
    stateRoot,
    contextResolver,
    contentStore,
    dailyTasksStore,
  });
  const created = await service.create({
    provider,
    templateId: "draft-article",
    context: { type: "topic", id: source.id },
    permissionMode: "readonly",
    instruction: "只输出一份 200 字以内的中文文章草稿，不调用工具，不解释工作过程。",
    sourceTaskId: "v05-real-agent-task",
  });
  const completed = await waitForTerminal(created.id);
  if (completed.status !== "completed" || !completed.finalText.trim()) {
    throw new Error(completed.error || `真实 Agent 运行未完成：${completed.status}`);
  }
  const result = await service.deliverResult(completed.id, {
    kind: "content_draft",
    contentFormat: "文章",
    title: "V0.5 真实 Agent 联调草稿",
  });
  const targetPath = path.join(root, ...result.delivery.targetRelativePath.split("/"));
  const targetContents = await fs.readFile(targetPath, "utf8");
  const tasks = await dailyTasksStore.read(date);
  const deliveredContent = await contentStore.findBySourceRun(completed.id);
  if (!targetContents.includes(completed.finalText.trim())) throw new Error("交付正文与 Agent 最终结果不一致");
  if (!targetContents.includes(`source_run: ${completed.id}`)) throw new Error("交付文件缺少来源运行记录");
  if (tasks.tasks[0]?.done !== false) throw new Error("AI 交付不应自动完成今日任务");
  if (!deliveredContent || deliveredContent.targetRelativePath !== result.delivery.targetRelativePath) {
    throw new Error("交付文件未被内容资产存储稳定回读");
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    provider,
    providerVersion: completed.runtime?.providerVersion ?? null,
    protocolVersion: completed.runtime?.protocolVersion ?? null,
    runId: completed.id,
    deliveryKind: result.delivery.kind,
    taskStillOpen: true,
    targetType: result.delivery.targetType,
  }, null, 2)}\n`);
} finally {
  await service?.close().catch(() => {});
  await fs.rm(base, { recursive: true, force: true });
}
