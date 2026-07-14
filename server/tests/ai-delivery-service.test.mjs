import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  createAiDeliveryService,
  AiDeliveryCommitError,
  AiDeliveryConflictError,
  AiDeliveryValidationError,
} from "../ai-collaboration/ai-delivery-service.mjs";
import { createAiTaskContextResolver, AiTaskSourceConflictError } from "../ai-collaboration/task-context-resolver.mjs";
import { createAiRunWorkspaceStore } from "../ai-collaboration/run-workspace-store.mjs";
import { createContentAssetsStore } from "../content-assets-store.mjs";
import { createReviewAssetsStore } from "../review-assets-store.mjs";
import { createDailyTasksStore } from "../daily-tasks-store.mjs";
import { AiRunServiceValidationError, createAiRunService } from "../ai-collaboration/ai-run-service.mjs";

const temporaryDirectories = [];
const NOW = new Date("2026-07-14T04:00:00.000Z");
const RUN_ID = "run-123e4567-e89b-42d3-a456-426614174000";

async function fixture({ sourceTaskLinkType = "topic", runId = RUN_ID } = {}) {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "creator-ai-delivery-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "vault");
  const stateRoot = path.join(base, "state");
  const inboxRoot = path.join(root, "30-内容资产", "00-选题池");
  await fs.mkdir(inboxRoot, { recursive: true });
  await fs.mkdir(path.join(root, "20-知识资产", "03-复盘"), { recursive: true });
  const contentStore = createContentAssetsStore({ root, stateRoot, now: () => NOW });
  const sourceAsset = await contentStore.create({
    title: "来源选题",
    summary: "真实原文。",
    status: "候选选题",
    format: "文章",
    channels: [],
    priority: null,
    dueAt: null,
    nextAction: "形成草稿",
  });
  const [sourceFileName] = await fs.readdir(inboxRoot);
  const sourcePath = path.join(inboxRoot, sourceFileName);
  const sourceContents = await fs.readFile(sourcePath);
  const sourceHash = crypto.createHash("sha256").update(sourceContents).digest("hex");
  const workspaceStore = createAiRunWorkspaceStore({
    stateRoot,
    now: () => NOW,
    idFactory: () => runId,
  });
  const sourceTask = {
    id: "task-001",
    date: "2026-07-14",
    title: "完成一篇 AI 应用文章",
    linkType: sourceTaskLinkType,
    linkId: sourceAsset.id,
    fingerprint: "1".repeat(64),
    assetSha256: sourceHash,
  };
  let run = await workspaceStore.create({
    provider: "codex",
    permissionMode: "readonly",
    templateId: "draft-article",
    context: { type: sourceTaskLinkType, id: sourceAsset.id, title: "来源选题", summary: "真实摘要" },
    instruction: "",
    sourceTask,
    sourceRefs: [{
      ref: `canonical:${sourceTaskLinkType}:${sourceAsset.id}:${sourceHash}`,
      sourcePath,
      expectedSha256: sourceHash,
    }],
  });
  run = await workspaceStore.transition(run.runId, "running");
  run = await workspaceStore.setFinalText(run.runId, "这是服务器保存的 AI 最终正文。\n\n不会采用浏览器伪造正文。");
  run = await workspaceStore.transition(run.runId, "completed");
  const taskContextResolver = {
    async reverify() {
      return {
        resolvedContext: {
          sourceRefs: [{ sourcePath, expectedSha256: sourceHash, ref: `canonical:${sourceTaskLinkType}:${sourceAsset.id}:${sourceHash}` }],
        },
      };
    },
  };
  return {
    base,
    root,
    stateRoot,
    sourcePath,
    sourceHash,
    sourceAsset,
    sourceFileName,
    workspaceStore,
    taskContextResolver,
    contentStore,
    run,
  };
}

function frontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match);
  return parseYaml(match[1]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("V0.5 AI 来源任务与内容成果交付", () => {
  test("由来源任务发起的可交付 run 固定只读，ask 在启动 CLI 前被拒绝", async () => {
    const value = await fixture();
    const service = createAiRunService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      contextResolver: { async resolve() { throw new Error("不应解析上下文"); } },
      taskContextResolver: { async resolveForCreate() { throw new Error("不应解析任务"); } },
      deliveryService: { async deliver() { throw new Error("不应交付"); } },
      catalogService: { async list() { throw new Error("不应探测 CLI"); } },
    });
    await assert.rejects(service.create({
      provider: "codex",
      templateId: "draft-article",
      context: { type: "topic", id: value.sourceAsset.id },
      instruction: "",
      permissionMode: "ask",
      sourceTaskId: "task-001",
    }), (error) => error instanceof AiRunServiceValidationError && /必须使用只读模式/.test(error.message));
    await service.close();
  });

  test("来源任务由服务端解析，并在任务或任一权威资料变化时拒绝交付", async () => {
    let task = {
      id: "task-001",
      title: "完成一篇 AI 应用文章",
      done: false,
      linkType: "topic",
      linkId: "content-source-001",
    };
    let secondaryHash = "2".repeat(64);
    const dailyTasksStore = { async read() { return { notFound: false, tasks: [task] }; } };
    const contextResolver = {
      async resolve() {
        return {
          context: { type: "topic", id: "content-source-001", title: "来源选题" },
          currentHash: "1".repeat(64),
          sourceRefs: [
            { ref: `canonical:topic:content-source-001:${"1".repeat(64)}`, expectedSha256: "1".repeat(64), sourcePath: "/vault/source.md" },
            { ref: `canonical:content:related:${secondaryHash}`, expectedSha256: secondaryHash, sourcePath: "/vault/related.md" },
          ],
        };
      },
    };
    const resolver = createAiTaskContextResolver({ now: () => NOW, dailyTasksStore, contextResolver });
    const created = await resolver.resolveForCreate({
      sourceTaskId: "task-001",
      requestedContext: { type: "topic", id: "content-source-001" },
    });
    const storedRefs = created.resolvedContext.sourceRefs.map((source) => ({ ref: source.ref, sha256: source.expectedSha256 }));
    await resolver.reverify(created.sourceTask, storedRefs);

    secondaryHash = "3".repeat(64);
    await assert.rejects(
      resolver.reverify(created.sourceTask, storedRefs),
      (error) => error instanceof AiTaskSourceConflictError && /完整权威资料集合/.test(error.message),
    );
    secondaryHash = "2".repeat(64);
    task = { ...task, title: "标题已被改动" };
    await assert.rejects(resolver.reverify(created.sourceTask, storedRefs), AiTaskSourceConflictError);
  });

  test("确认后只用 run.finalText 创建已立项内容，写入真实 Obsidian 关系且幂等", async () => {
    const value = await fixture();
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
    });
    const request = { kind: "content_draft", contentFormat: "文章", title: "AI 应用文章草稿" };
    const first = await service.deliver(RUN_ID, request);
    assert.equal(first.created, true);
    assert.equal(first.delivery.targetType, "content");
    assert.match(first.delivery.targetRelativePath, /^30-内容资产\/01-文章\//);
    const target = path.join(value.root, ...first.delivery.targetRelativePath.split("/"));
    const markdown = await fs.readFile(target, "utf8");
    const fm = frontmatter(markdown);
    assert.equal(fm.status, "已立项");
    assert.equal(fm.completed_at, null);
    assert.equal(fm.source_run, RUN_ID);
    assert.equal(fm.source_task_id, "task-001");
    assert.deepEqual(fm.derived_from, [`[[30-内容资产/00-选题池/${value.sourceFileName.slice(0, -3)}]]`]);
    assert.match(markdown, /这是服务器保存的 AI 最终正文/);

    const second = await service.deliver(RUN_ID, request);
    assert.equal(second.created, false);
    assert.equal(second.delivery.id, first.delivery.id);
    assert.equal((await value.contentStore.list()).items.length, 2);
    await assert.rejects(
      service.deliver(RUN_ID, { ...request, title: "另一份草稿" }),
      AiDeliveryConflictError,
    );
  });

  test("运行清单未记录时保留带哈希的内容成果，重试后幂等认领且不重复", async () => {
    const value = await fixture();
    const failingWorkspaceStore = {
      get: (runId) => value.workspaceStore.get(runId),
      async recordDelivery() { throw new Error("manifest write failed"); },
    };
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: failingWorkspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
    });
    const request = { kind: "content_draft", contentFormat: "短视频口播", title: "短视频草稿" };
    await assert.rejects(service.deliver(RUN_ID, request), (error) => (
      error instanceof AiDeliveryCommitError
      && /已保留.*重试认领/.test(error.message)
      && /manifest write failed/.test(error.cause?.message ?? "")
    ));
    assert.equal((await value.contentStore.list()).items.length, 2);
    const retry = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
    });
    const recovered = await retry.deliver(RUN_ID, request);
    assert.equal(recovered.created, false);
    assert.equal(recovered.delivery.targetType, "content");
    assert.equal((await value.contentStore.list()).items.length, 2);
    assert.equal((await value.workspaceStore.get(RUN_ID)).deliveries.length, 1);
  });

  test("运行清单已经写入但事件追加报错时，复读同一记录并直接视为成功", async () => {
    const value = await fixture();
    const partialWorkspaceStore = {
      get: (runId) => value.workspaceStore.get(runId),
      async recordDelivery(runId, delivery) {
        await value.workspaceStore.recordDelivery(runId, delivery);
        throw new Error("event append failed after manifest commit");
      },
    };
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: partialWorkspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
    });
    const result = await service.deliver(RUN_ID, {
      kind: "content_draft",
      contentFormat: "文章",
      title: "清单部分提交恢复测试",
    });
    assert.equal(result.created, true);
    assert.equal(result.delivery.targetType, "content");
    assert.equal((await value.workspaceStore.get(RUN_ID)).deliveries.length, 1);
    assert.equal((await value.contentStore.list()).items.length, 2);
  });

  test("运行清单复读不可用时保留成果并返回可重试的不确定状态", async () => {
    const value = await fixture();
    let readCount = 0;
    const unavailableWorkspaceStore = {
      async get(runId) {
        readCount += 1;
        if (readCount > 1) throw new Error("manifest temporarily unreadable");
        return value.workspaceStore.get(runId);
      },
      async recordDelivery() { throw new Error("manifest write failed"); },
    };
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: unavailableWorkspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
    });
    await assert.rejects(
      service.deliver(RUN_ID, { kind: "content_draft", contentFormat: "文章", title: "清单暂不可读" }),
      (error) => (
        error instanceof AiDeliveryCommitError
        && /状态暂时无法确认/.test(error.message)
        && /manifest temporarily unreadable/.test(error.recoveryError?.message ?? "")
      ),
    );
    assert.equal((await value.contentStore.list()).items.length, 2);
  });

  test("服务端强制交付矩阵并锁定账号拆解复盘类型", async () => {
    const contentReview = await fixture({ sourceTaskLinkType: "content-review" });
    const contentReviewService = createAiDeliveryService({
      root: contentReview.root,
      stateRoot: contentReview.stateRoot,
      now: () => NOW,
      workspaceStore: contentReview.workspaceStore,
      taskContextResolver: contentReview.taskContextResolver,
      contentStore: contentReview.contentStore,
    });
    await assert.rejects(
      contentReviewService.deliver(RUN_ID, { kind: "content_draft", contentFormat: "文章", title: "不应生成" }),
      (error) => error instanceof AiDeliveryValidationError && /只能从选题或内容任务/.test(error.message),
    );

    const topic = await fixture();
    const topicService = createAiDeliveryService({
      root: topic.root,
      stateRoot: topic.stateRoot,
      now: () => NOW,
      workspaceStore: topic.workspaceStore,
      taskContextResolver: topic.taskContextResolver,
      contentStore: topic.contentStore,
    });
    await assert.rejects(
      topicService.deliver(RUN_ID, { kind: "review_draft", reviewKind: "account-breakdown", title: "伪造账号拆解" }),
      (error) => error instanceof AiDeliveryValidationError && /只能交付为内容复盘/.test(error.message),
    );

    const account = await fixture({ sourceTaskLinkType: "account-breakdown" });
    const accountService = createAiDeliveryService({
      root: account.root,
      stateRoot: account.stateRoot,
      now: () => NOW,
      workspaceStore: account.workspaceStore,
      taskContextResolver: account.taskContextResolver,
      contentStore: account.contentStore,
    });
    await assert.rejects(
      accountService.deliver(RUN_ID, { kind: "review_draft", reviewKind: "content-review", title: "伪造内容复盘" }),
      (error) => error instanceof AiDeliveryValidationError && /只能交付为账号拆解复盘/.test(error.message),
    );
  });

  test("新建后载荷复核失败时保留可核对成果，不谎称回滚", async () => {
    const value = await fixture();
    const driftingStore = {
      ...value.contentStore,
      async findBySourceRun(runId) {
        const target = await value.contentStore.findBySourceRun(runId);
        return target ? { ...target, currentPayloadHash: "0".repeat(64) } : null;
      },
    };
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: driftingStore,
    });
    await assert.rejects(
      service.deliver(RUN_ID, { kind: "content_draft", contentFormat: "文章", title: "载荷漂移草稿" }),
      (error) => error instanceof AiDeliveryConflictError && /已被修改/.test(error.message),
    );
    assert.equal((await value.contentStore.list()).items.length, 2);
  });

  test("孤儿内容被人工改动后不能在重试时自动认领", async () => {
    const value = await fixture();
    const failingWorkspaceStore = {
      get: (runId) => value.workspaceStore.get(runId),
      async recordDelivery() { throw new Error("manifest write failed"); },
    };
    const request = { kind: "content_draft", contentFormat: "文章", title: "孤儿草稿" };
    const firstService = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: failingWorkspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
    });
    await assert.rejects(firstService.deliver(RUN_ID, request), AiDeliveryCommitError);
    const orphan = await value.contentStore.findBySourceRun(RUN_ID);
    assert.ok(orphan);
    const orphanPath = path.join(value.root, ...orphan.targetRelativePath.split("/"));
    await fs.appendFile(orphanPath, "\n人工改动。\n", "utf8");

    const retryService = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
    });
    await assert.rejects(
      retryService.deliver(RUN_ID, request),
      (error) => error instanceof AiDeliveryConflictError && /已被修改/.test(error.message),
    );
    assert.equal((await value.workspaceStore.get(RUN_ID)).deliveries.length, 0);
  });

  test("复盘交付保留 AI 最终正文，保持待人工确认且可以幂等恢复", async () => {
    const value = await fixture();
    const reviewStore = createReviewAssetsStore({ root: value.root, stateRoot: value.stateRoot, now: () => NOW });
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
      reviewStore,
    });
    const request = {
      kind: "review_draft",
      reviewKind: "content-review",
      title: "来源选题复盘",
    };
    const first = await service.deliver(RUN_ID, request);
    assert.equal(first.created, true);
    assert.equal(first.delivery.targetType, "review");
    assert.match(first.delivery.targetRelativePath, /^20-知识资产\/03-复盘\//);
    const markdown = await fs.readFile(path.join(value.root, ...first.delivery.targetRelativePath.split("/")), "utf8");
    const fm = frontmatter(markdown);
    assert.equal(fm.confirmation, "待人工确认");
    assert.equal(fm.status, "待确认");
    assert.equal(fm.confirmed_at, null);
    assert.equal(fm.source_run, RUN_ID);
    assert.equal(fm.related_content_id, value.sourceAsset.id);
    assert.match(markdown, /这是服务器保存的 AI 最终正文/);
    assert.match(markdown, /人工确认后提炼下一步动作/);

    const second = await service.deliver(RUN_ID, request);
    assert.equal(second.created, false);
    assert.equal(second.delivery.id, first.delivery.id);
    assert.equal((await reviewStore.list()).items.length, 1);
  });

  test("复盘清单未记录时保留待确认资产，重试后幂等认领", async () => {
    const value = await fixture();
    const reviewStore = createReviewAssetsStore({ root: value.root, stateRoot: value.stateRoot, now: () => NOW });
    const failingWorkspaceStore = {
      get: (runId) => value.workspaceStore.get(runId),
      async recordDelivery() { throw new Error("manifest write failed"); },
    };
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: failingWorkspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
      reviewStore,
    });
    const request = {
      kind: "review_draft",
      reviewKind: "content-review",
      title: "失败回滚复盘",
    };
    await assert.rejects(service.deliver(RUN_ID, request), AiDeliveryCommitError);
    assert.equal((await reviewStore.list()).items.length, 1);
    const retry = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
      reviewStore,
    });
    const recovered = await retry.deliver(RUN_ID, request);
    assert.equal(recovered.created, false);
    assert.equal((await reviewStore.list()).items.length, 1);
    assert.equal((await value.workspaceStore.get(RUN_ID)).deliveries.length, 1);
  });

  test("次日任务追加到服务器计算的明日文件，不完成来源任务并且重复确认不重复写", async () => {
    const value = await fixture({ sourceTaskLinkType: "content-review" });
    const dailyTasksStore = createDailyTasksStore({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
    });
    await dailyTasksStore.write("2026-07-15", [{
      id: "existing-linked",
      title: "保留关联任务",
      done: false,
      linkId: value.sourceAsset.id,
      linkType: "content",
    }], null);
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
      dailyTasksStore,
    });
    const request = { kind: "next_day_task", tasks: ["写公众号文章", "拍一条短视频"] };
    const first = await service.deliver(RUN_ID, request);
    assert.equal(first.created, true);
    assert.equal(first.delivery.targetType, "task");
    assert.equal(first.delivery.targetId, null);
    assert.match(first.delivery.targetRelativePath, /2026-07-15-今日三件事\.md$/);
    const tomorrow = await dailyTasksStore.read("2026-07-15");
    assert.deepEqual(tomorrow.tasks.map((task) => [task.title, task.done]), [
      ["保留关联任务", false],
      ["写公众号文章", false],
      ["拍一条短视频", false],
    ]);
    assert.equal(tomorrow.tasks[0].linkId, value.sourceAsset.id);
    assert.equal(tomorrow.tasks[0].linkType, "content");
    assert.equal(tomorrow.tasks[1].linkId, value.sourceAsset.id);
    assert.equal(tomorrow.tasks[1].linkType, "content-review");
    assert.equal(tomorrow.tasks[2].linkId, value.sourceAsset.id);
    assert.equal(tomorrow.tasks[2].linkType, "content-review");
    const second = await service.deliver(RUN_ID, request);
    assert.equal(second.created, false);
    assert.equal((await dailyTasksStore.read("2026-07-15")).tasks.length, 3);
    const originalRun = await value.workspaceStore.get(RUN_ID);
    assert.equal(originalRun.sourceTask.id, "task-001");
  });

  test("未经过复盘的选题或内容不能直接生成次日任务", async () => {
    const value = await fixture();
    const dailyTasksStore = createDailyTasksStore({ root: value.root, stateRoot: value.stateRoot, now: () => NOW });
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
      dailyTasksStore,
    });
    await assert.rejects(
      service.deliver(RUN_ID, { kind: "next_day_task", tasks: ["不应生成"] }),
      (error) => error instanceof AiDeliveryValidationError && /只能从内容复盘/.test(error.message),
    );
    assert.equal((await dailyTasksStore.read("2026-07-15")).notFound, true);
  });

  test("不同 run 提交相同次日任务不会误判为同一交付", async () => {
    const value = await fixture({ sourceTaskLinkType: "content-review" });
    const secondRunId = "run-223e4567-e89b-42d3-a456-426614174000";
    const secondStore = createAiRunWorkspaceStore({
      stateRoot: value.stateRoot,
      now: () => NOW,
      idFactory: () => secondRunId,
    });
    let second = await secondStore.create({
      provider: "codex",
      permissionMode: "readonly",
      templateId: "plan-tomorrow",
      context: { type: "content-review", id: value.sourceAsset.id, title: "来源复盘" },
      instruction: "",
      sourceTask: {
        id: "task-002",
        date: "2026-07-14",
        title: "另一份复盘",
        linkType: "content-review",
        linkId: value.sourceAsset.id,
        fingerprint: "2".repeat(64),
        assetSha256: value.sourceHash,
      },
      sourceRefs: [{
        ref: `canonical:content-review:${value.sourceAsset.id}:${value.sourceHash}`,
        sourcePath: value.sourcePath,
        expectedSha256: value.sourceHash,
      }],
    });
    second = await secondStore.transition(second.runId, "running");
    second = await secondStore.setFinalText(second.runId, "第二份 AI 复盘结果");
    await secondStore.transition(second.runId, "completed");
    const dailyTasksStore = createDailyTasksStore({ root: value.root, stateRoot: value.stateRoot, now: () => NOW });
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: secondStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
      dailyTasksStore,
    });
    const request = { kind: "next_day_task", tasks: ["同一动作"] };
    await service.deliver(RUN_ID, request);
    await service.deliver(secondRunId, request);
    const tasks = (await dailyTasksStore.read("2026-07-15")).tasks;
    assert.equal(tasks.length, 2);
    assert.notEqual(tasks[0].id, tasks[1].id);
    assert.equal(tasks[0].title, tasks[1].title);
  });

  test("次日任务在运行清单未记录时保留新增项，重试后认领且不重复", async () => {
    const value = await fixture({ sourceTaskLinkType: "content-review" });
    const dailyTasksStore = createDailyTasksStore({ root: value.root, stateRoot: value.stateRoot, now: () => NOW });
    const before = await dailyTasksStore.write("2026-07-15", [{
      id: "existing-1",
      title: "保留已有任务",
      done: false,
      linkId: null,
      linkType: null,
    }], null);
    assert.ok(before.hash);
    const failingWorkspaceStore = {
      get: (runId) => value.workspaceStore.get(runId),
      async recordDelivery() { throw new Error("manifest write failed"); },
    };
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: failingWorkspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
      dailyTasksStore,
    });
    const request = { kind: "next_day_task", tasks: ["新增任务"] };
    await assert.rejects(service.deliver(RUN_ID, request), AiDeliveryCommitError);
    assert.deepEqual((await dailyTasksStore.read("2026-07-15")).tasks.map((task) => task.title), ["保留已有任务", "新增任务"]);
    const retry = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: value.workspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
      dailyTasksStore,
    });
    const recovered = await retry.deliver(RUN_ID, request);
    assert.equal(recovered.created, false);
    assert.deepEqual((await dailyTasksStore.read("2026-07-15")).tasks.map((task) => task.title), ["保留已有任务", "新增任务"]);
  });

  test("运行清单失败前若任务文件被其他写入修改，仍保留全部新状态", async () => {
    const value = await fixture({ sourceTaskLinkType: "content-review" });
    const dailyTasksStore = createDailyTasksStore({ root: value.root, stateRoot: value.stateRoot, now: () => NOW });
    const filePath = dailyTasksStore.filePathForDate("2026-07-15");
    const failingWorkspaceStore = {
      get: (runId) => value.workspaceStore.get(runId),
      async recordDelivery() {
        await fs.appendFile(filePath, "\n外部并发修改\n", "utf8");
        throw new Error("manifest write failed");
      },
    };
    const service = createAiDeliveryService({
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      workspaceStore: failingWorkspaceStore,
      taskContextResolver: value.taskContextResolver,
      contentStore: value.contentStore,
      dailyTasksStore,
    });
    let failure;
    try {
      await service.deliver(RUN_ID, { kind: "next_day_task", tasks: ["并发任务"] });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof AiDeliveryCommitError);
    assert.match(failure?.message ?? "", /成果已保留/);
    assert.match(await fs.readFile(filePath, "utf8"), /外部并发修改/);
  });
});
