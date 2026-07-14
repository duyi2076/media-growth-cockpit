import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { createContentAssetsStore } from "../content-assets-store.mjs";
import { createReviewAssetsStore } from "../review-assets-store.mjs";
import { createDailyTasksStore, shanghaiDate } from "../daily-tasks-store.mjs";
import { contentDeliveryPayloadHash, reviewDeliveryPayloadHash } from "../lib/ai-delivery-integrity.mjs";
import { runWithSharedWriteQueue } from "../lib/shared-write-queue.mjs";
import { hasSecret } from "../../scripts/lib/security.mjs";

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const RUN_ID_RE = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const singleLine = (label, max) => z.string().trim().min(1, `${label}不能为空`).max(max)
  .refine((value) => !/[\r\n]/.test(value), `${label}必须是单行文字`)
  .refine((value) => !CONTROL_RE.test(value), `${label}包含控制字符`)
  .refine((value) => !/[<>]/.test(value), `${label}不能包含 HTML`)
  .refine((value) => !hasSecret(value), `${label}不能包含凭证或密钥`);
const multiline = (label, max) => z.string().trim().max(max)
  .refine((value) => !CONTROL_RE.test(value), `${label}包含控制字符`)
  .refine((value) => !/<(?:script|style|iframe|object|embed)\b/i.test(value), `${label}不能包含可执行 HTML`)
  .refine((value) => !hasSecret(value), `${label}不能包含凭证或密钥`);

export const aiDeliveryRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("content_draft"),
    contentFormat: z.enum(["文章", "短视频口播"]),
    title: singleLine("标题", 160),
  }).strict(),
  z.object({
    kind: z.literal("review_draft"),
    reviewKind: z.enum(["content-review", "account-breakdown"]),
    title: singleLine("标题", 160),
    summary: multiline("摘要", 4_000).optional().default(""),
    nextAction: multiline("下一步", 4_000).optional().default(""),
  }).strict(),
  z.object({
    kind: z.literal("next_day_task"),
    tasks: z.array(singleLine("次日任务", 200)).min(1).max(3),
  }).strict(),
]);

export class AiDeliveryValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "AiDeliveryValidationError";
  }
}

export class AiDeliveryConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiDeliveryConflictError";
  }
}

export class AiDeliveryCommitError extends Error {
  constructor(message, { cause, recoveryError } = {}) {
    super(message, { cause });
    this.name = "AiDeliveryCommitError";
    this.recoveryError = recoveryError;
  }
}

function requestHash(request) {
  return crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function summaryFrom(text) {
  const normalized = text.trim();
  return normalized.length <= 4_000 ? normalized : `${normalized.slice(0, 3_997)}...`;
}

function deliveryId(runId, hash) {
  return `delivery-${crypto.createHash("sha256").update(`${runId}:${hash}`).digest("hex").slice(0, 32)}`;
}

export function createAiDeliveryService(options = {}) {
  const workspaceStore = options.workspaceStore;
  const taskContextResolver = options.taskContextResolver;
  if (!workspaceStore?.get || !workspaceStore?.recordDelivery) {
    throw new AiDeliveryValidationError("缺少 AI 运行清单存储");
  }
  if (!taskContextResolver?.reverify) throw new AiDeliveryValidationError("缺少来源任务复核器");
  const contentStore = options.contentStore ?? createContentAssetsStore(options);
  const reviewStore = options.reviewStore ?? createReviewAssetsStore(options);
  const dailyTasksStore = options.dailyTasksStore ?? taskContextResolver.dailyTasksStore ?? createDailyTasksStore(options);
  const now = options.now ?? (() => new Date());
  const root = path.resolve(options.root ?? contentStore.root);
  const stateRoot = path.resolve(options.stateRoot ?? workspaceStore.stateRoot);
  const deliveryLockRoot = path.join(stateRoot, "locks", "ai-deliveries");

  function serialize(runId, operation) {
    if (!RUN_ID_RE.test(runId ?? "")) throw new AiDeliveryValidationError("runId 格式无效");
    return runWithSharedWriteQueue(path.join(deliveryLockRoot, `${runId}.lock`), operation);
  }

  async function recoverRecordedDelivery(runId, expected, created, originalError) {
    let current;
    try {
      current = await workspaceStore.get(runId);
    } catch (recoveryError) {
      throw new AiDeliveryCommitError(
        "业务成果已写入 Obsidian，但运行清单状态暂时无法确认；成果已保留，请重试认领",
        { cause: originalError, recoveryError },
      );
    }
    const recorded = current.deliveries?.[0] ?? null;
    if (!recorded) {
      throw new AiDeliveryCommitError(
        "业务成果已写入 Obsidian，但运行清单尚未记录；成果已保留，请重试认领",
        { cause: originalError },
      );
    }
    if (
      recorded.id !== expected.id
      || recorded.kind !== expected.kind
      || recorded.requestHash !== expected.requestHash
      || recorded.sourceRunId !== expected.sourceRunId
      || recorded.sourceTaskId !== expected.sourceTaskId
      || recorded.targetType !== expected.targetType
      || recorded.targetId !== expected.targetId
      || recorded.targetRelativePath !== expected.targetRelativePath
      || recorded.targetTitle !== expected.targetTitle
      || recorded.sha256 !== expected.sha256
    ) {
      throw new AiDeliveryConflictError("运行清单已记录另一份业务成果；当前成果已保留，请人工核对");
    }
    return { run: current, delivery: recorded, created };
  }

  function assertDeliveryMatrix(run, request) {
    const sourceType = run.sourceTask.linkType;
    if (request.kind === "content_draft") {
      if (!["topic", "content"].includes(sourceType)) {
        throw new AiDeliveryValidationError("内容草稿只能从选题或内容任务生成");
      }
      return;
    }
    if (request.kind === "review_draft") {
      if (!["topic", "content", "content-review", "account-breakdown"].includes(sourceType)) {
        throw new AiDeliveryValidationError("复盘草稿只能从选题、内容、内容复盘或账号拆解任务生成");
      }
      const expectedKind = sourceType === "account-breakdown" ? "account-breakdown" : "content-review";
      if (request.reviewKind !== expectedKind) {
        throw new AiDeliveryValidationError(
          sourceType === "account-breakdown"
            ? "账号拆解任务只能交付为账号拆解复盘"
            : "当前来源任务只能交付为内容复盘",
        );
      }
      return;
    }
    if (!["content-review", "account-breakdown", "daily-review"].includes(sourceType)) {
      throw new AiDeliveryValidationError("次日任务只能从内容复盘、账号拆解或每日复盘中提炼");
    }
  }

  function relationshipLinks(sourceRefs) {
    if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) {
      throw new AiDeliveryValidationError("权威来源资产为空");
    }
    const links = sourceRefs.map((source) => {
      if (typeof source?.sourcePath !== "string") throw new AiDeliveryValidationError("权威来源资产路径缺失");
      const relative = path.relative(root, source.sourcePath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !relative.toLowerCase().endsWith(".md")) {
        throw new AiDeliveryValidationError("权威来源资产路径超出 Vault");
      }
      return `[[${relative.slice(0, -3).split(path.sep).join("/")}]]`;
    });
    return [...new Set(links)];
  }

  function reviewBody(run, request) {
    const finalText = run.finalText.trim();
    if (finalText.length > 12_000) throw new AiDeliveryValidationError("AI 复盘结果超过 12000 字，请先让 Agent 精简后再交付");
    return finalText.replace(/^ {0,3}##[ \t]+/gm, "### ");
  }

  function reviewSummary(run, request) {
    return (request.summary || summaryFrom(run.finalText)).replace(/^ {0,3}##[ \t]+/gm, "### ");
  }

  async function reviewRelationship(run, request) {
    const source = run.sourceTask;
    if (request.reviewKind === "content-review") {
      if (["topic", "content"].includes(source.linkType)) {
        return { sourceUrl: null, platform: null, relatedContentId: source.linkId };
      }
      if (source.linkType === "content-review") {
        const snapshot = await reviewStore.findById(source.linkId);
        return {
          sourceUrl: snapshot.sourceUrl,
          platform: snapshot.platform,
          relatedContentId: snapshot.relatedContentId,
        };
      }
      throw new AiDeliveryValidationError("内容复盘交付必须来源于内容或已有内容复盘");
    }
    if (source.linkType !== "account-breakdown") {
      throw new AiDeliveryValidationError("账号拆解交付必须来源于已关联的账号拆解资产");
    }
    const snapshot = await reviewStore.findById(source.linkId);
    if (!snapshot.sourceUrl) throw new AiDeliveryValidationError("来源账号拆解缺少 https 链接");
    return { sourceUrl: snapshot.sourceUrl, platform: snapshot.platform, relatedContentId: null };
  }

  async function deliverContent(run, request, hash, currentSourceRefs) {
    const links = relationshipLinks(currentSourceRefs);
    const input = {
      title: request.title,
      summary: summaryFrom(run.finalText),
      status: "已立项",
      format: request.contentFormat,
      channels: [],
      priority: null,
      dueAt: null,
      nextAction: "人工审核后安排发布",
    };
    const body = run.finalText.trim();
    const payloadHash = contentDeliveryPayloadHash({
      ...input,
      body,
      derivedFrom: links,
      relatedAssets: links,
      sourceRun: run.runId,
      sourceTaskId: run.sourceTask.id,
      requestHash: hash,
    });
    let target = await contentStore.findBySourceRun(run.runId);
    let created = false;
    try {
      if (target && target.requestHash !== hash) {
        throw new AiDeliveryConflictError("该 AI 任务已经生成过另一份内容资产");
      }
      if (!target) {
        target = await contentStore.createDelivery(input, {
          body,
          sourceRun: run.runId,
          sourceTaskId: run.sourceTask.id,
          requestHash: hash,
          payloadHash,
          derivedFrom: links,
          relatedAssets: links,
        });
        created = true;
        target = await contentStore.findBySourceRun(run.runId);
        if (!target) throw new AiDeliveryConflictError("内容资产写入后无法重新读取");
      }
      if (target.deliveryPayloadHash !== payloadHash || target.currentPayloadHash !== payloadHash) {
        throw new AiDeliveryConflictError("历史内容交付已被修改，不能自动认领为本次成果");
      }
      const delivery = {
        id: deliveryId(run.runId, hash),
        kind: "content_draft",
        status: "completed",
        requestHash: hash,
        sourceRunId: run.runId,
        sourceTaskId: run.sourceTask.id,
        targetType: "content",
        targetId: target.id,
        targetRelativePath: target.targetRelativePath,
        targetTitle: target.title,
        sha256: target.hash,
        createdAt: now().toISOString(),
      };
      try {
        const updatedRun = await workspaceStore.recordDelivery(run.runId, delivery);
        return { run: updatedRun, delivery: updatedRun.deliveries[0], created };
      } catch (error) {
        return recoverRecordedDelivery(run.runId, delivery, created, error);
      }
    } catch (error) {
      throw error;
    }
  }

  async function deliverReview(run, request, hash, currentSourceRefs) {
    const relationship = await reviewRelationship(run, request);
    const links = relationshipLinks(currentSourceRefs);
    const input = {
      kind: request.reviewKind,
      title: request.title,
      sourceUrl: relationship.sourceUrl,
      platform: relationship.platform,
      relatedContentId: relationship.relatedContentId,
      summary: reviewSummary(run, request),
      findings: reviewBody(run, request),
      nextAction: request.nextAction || "人工确认后提炼下一步动作",
    };
    const payloadHash = reviewDeliveryPayloadHash({
      ...input,
      confirmation: "待人工确认",
      status: "待确认",
      derivedFrom: links,
      relatedAssets: links,
      sourceRun: run.runId,
      sourceTaskId: run.sourceTask.id,
      requestHash: hash,
    });
    let target = await reviewStore.findBySourceRun(run.runId);
    let created = false;
    try {
      if (target && target.requestHash !== hash) {
        throw new AiDeliveryConflictError("该 AI 任务已经生成过另一份复盘资产");
      }
      if (!target) {
        target = await reviewStore.createDelivery(input, {
          sourceRun: run.runId,
          sourceTaskId: run.sourceTask.id,
          requestHash: hash,
          payloadHash,
          derivedFrom: links,
          relatedAssets: links,
        });
        created = true;
        target = await reviewStore.findBySourceRun(run.runId);
        if (!target) throw new AiDeliveryConflictError("复盘资产写入后无法重新读取");
      }
      if (target.deliveryPayloadHash !== payloadHash || target.currentPayloadHash !== payloadHash) {
        throw new AiDeliveryConflictError("历史复盘交付已被修改，不能自动认领为本次成果");
      }
      const delivery = {
        id: deliveryId(run.runId, hash),
        kind: "review_draft",
        status: "completed",
        requestHash: hash,
        sourceRunId: run.runId,
        sourceTaskId: run.sourceTask.id,
        targetType: "review",
        targetId: target.id,
        targetRelativePath: target.targetRelativePath,
        targetTitle: target.title,
        sha256: target.hash,
        createdAt: now().toISOString(),
      };
      try {
        const updatedRun = await workspaceStore.recordDelivery(run.runId, delivery);
        return { run: updatedRun, delivery: updatedRun.deliveries[0], created };
      } catch (error) {
        return recoverRecordedDelivery(run.runId, delivery, created, error);
      }
    } catch (error) {
      throw error;
    }
  }

  function tomorrowDate() {
    const today = shanghaiDate(now());
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  async function deliverNextDayTasks(run, request, hash) {
    const date = tomorrowDate();
    const snapshot = await dailyTasksStore.read(date);
    const taskDeliveryKey = crypto.createHash("sha256").update(`${run.runId}:${hash}`).digest("hex").slice(0, 24);
    const ids = request.tasks.map((_, index) => `ai-${taskDeliveryKey}-${index + 1}`);
    const recovered = ids.map((id) => snapshot.tasks.find((task) => task.id === id));
    let written = snapshot;
    let created = false;
    if (recovered.some(Boolean)) {
      if (
        recovered.some((task, index) => (
          !task
          || task.title !== request.tasks[index]
          || task.done
          || task.linkType !== run.sourceTask.linkType
          || task.linkId !== run.sourceTask.linkId
        ))
      ) {
        throw new AiDeliveryConflictError("次日任务存在不完整或被修改的历史交付");
      }
    } else {
      if (snapshot.tasks.length + request.tasks.length > 3) {
        throw new AiDeliveryConflictError("次日任务最多 3 条，请先调整已有任务");
      }
      const additions = request.tasks.map((title, index) => ({
        id: ids[index],
        title,
        done: false,
        linkId: run.sourceTask.linkId,
        linkType: run.sourceTask.linkType,
      }));
      written = await dailyTasksStore.write(date, [...snapshot.tasks, ...additions], snapshot.hash);
      created = true;
    }
    const targetRelativePath = path.relative(root, dailyTasksStore.filePathForDate(date)).split(path.sep).join("/");
    if (!targetRelativePath || targetRelativePath.startsWith("..") || path.isAbsolute(targetRelativePath)) {
      throw new AiDeliveryValidationError("次日任务目标路径超出 Vault");
    }
    const delivery = {
      id: deliveryId(run.runId, hash),
      kind: "next_day_task",
      status: "completed",
      requestHash: hash,
      sourceRunId: run.runId,
      sourceTaskId: run.sourceTask.id,
      targetType: "task",
      targetId: null,
      targetRelativePath,
      targetTitle: `${date} 次日任务`,
      sha256: written.hash,
      createdAt: now().toISOString(),
    };
    try {
      const updatedRun = await workspaceStore.recordDelivery(run.runId, delivery);
      return { run: updatedRun, delivery: updatedRun.deliveries[0], created };
    } catch (error) {
      return recoverRecordedDelivery(run.runId, delivery, created, error);
    }
  }

  async function deliver(runId, value) {
    const parsed = aiDeliveryRequestSchema.safeParse(value);
    if (!parsed.success) {
      throw new AiDeliveryValidationError(parsed.error.issues[0]?.message ?? "交付字段无效", parsed.error);
    }
    const request = parsed.data;
    const hash = requestHash(request);
    return serialize(runId, async () => {
      const run = await workspaceStore.get(runId);
      const existing = run.deliveries?.[0] ?? null;
      if (existing) {
        if (existing.requestHash !== hash) throw new AiDeliveryConflictError("该 AI 任务已经交付过其他成果");
        return { run, delivery: existing, created: false };
      }
      if (run.status !== "completed") throw new AiDeliveryConflictError("只有已完成的 AI 任务可以交付");
      if (!run.sourceTask) throw new AiDeliveryConflictError("该 AI 任务不是由今日任务发起，不能交付业务成果");
      if (!run.finalText?.trim()) throw new AiDeliveryConflictError("AI 任务没有可交付的最终结果");
      assertDeliveryMatrix(run, request);
      const verified = await taskContextResolver.reverify(run.sourceTask, run.sourceRefs);
      if (request.kind === "content_draft") {
        return deliverContent(run, request, hash, verified.resolvedContext.sourceRefs);
      }
      if (request.kind === "review_draft") {
        return deliverReview(run, request, hash, verified.resolvedContext.sourceRefs);
      }
      return deliverNextDayTasks(run, request, hash);
    });
  }

  return { deliver };
}
