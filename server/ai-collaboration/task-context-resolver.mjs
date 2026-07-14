import crypto from "node:crypto";
import { createDailyTasksStore, shanghaiDate } from "../daily-tasks-store.mjs";
import { AUTHORITATIVE_AI_CONTEXT_TYPES } from "./authoritative-context-resolver.mjs";

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export class AiTaskSourceValidationError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "AiTaskSourceValidationError";
  }
}

export class AiTaskSourceNotFoundError extends Error {
  constructor(message = "来源任务不存在") {
    super(message);
    this.name = "AiTaskSourceNotFoundError";
  }
}

export class AiTaskSourceConflictError extends Error {
  constructor(message = "来源任务或关联资产已经变化，请重新发起 AI 任务") {
    super(message);
    this.name = "AiTaskSourceConflictError";
  }
}

export class AiTaskSourceSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiTaskSourceSecurityError";
  }
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeTaskId(value) {
  if (typeof value !== "string" || !TASK_ID_RE.test(value)) {
    throw new AiTaskSourceValidationError("sourceTaskId 不是安全的任务标识");
  }
  return value;
}

function fingerprint(task) {
  return stableHash({
    id: task.id,
    title: task.title,
    linkType: task.linkType,
    linkId: task.linkId,
  });
}

function canonicalSourceEvidence(sourceRefs, stored) {
  if (!Array.isArray(sourceRefs)) throw new AiTaskSourceValidationError("AI 任务来源证据无效");
  return sourceRefs
    .filter((source) => typeof source?.ref === "string" && source.ref.startsWith("canonical:"))
    .map((source) => ({
      ref: source.ref,
      sha256: stored ? source.sha256 : source.expectedSha256,
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref));
}

function mapDailyStoreError(error) {
  if (typeof error?.name === "string" && error.name.endsWith("SecurityError")) {
    return new AiTaskSourceSecurityError("来源任务未通过路径或敏感信息校验", error);
  }
  if (typeof error?.name === "string" && error.name.endsWith("ValidationError")) {
    return new AiTaskSourceValidationError("来源任务文件结构无效", error);
  }
  if (typeof error?.name === "string" && error.name.endsWith("ConflictError")) {
    return new AiTaskSourceConflictError("来源任务文件已经变化");
  }
  return error;
}

function assertTaskRelationship(task) {
  if (!task.linkType || !task.linkId) {
    throw new AiTaskSourceValidationError("来源任务尚未关联业务资产，不能启动可交付的 AI 任务");
  }
  if (!AUTHORITATIVE_AI_CONTEXT_TYPES.includes(task.linkType)) {
    throw new AiTaskSourceValidationError("来源任务当前关联类型不能作为 AI 权威上下文");
  }
}

function assertRequestedContext(requestedContext, task) {
  if (!requestedContext || requestedContext.type !== task.linkType || requestedContext.id !== task.linkId) {
    throw new AiTaskSourceValidationError("浏览器 context 与来源任务持久化的资产关系不一致");
  }
}

export function createAiTaskContextResolver(options = {}) {
  const now = options.now ?? (() => new Date());
  const dailyTasksStore = options.dailyTasksStore ?? createDailyTasksStore(options);
  const contextResolver = options.contextResolver;
  if (!contextResolver || typeof contextResolver.resolve !== "function") {
    throw new AiTaskSourceValidationError("缺少权威资产解析器");
  }

  async function readTask(date, sourceTaskId) {
    let snapshot;
    try {
      snapshot = await dailyTasksStore.read(date);
    } catch (error) {
      throw mapDailyStoreError(error);
    }
    if (snapshot.notFound) throw new AiTaskSourceNotFoundError("来源任务日期文件不存在");
    const matches = snapshot.tasks.filter((task) => task.id === sourceTaskId);
    if (matches.length === 0) throw new AiTaskSourceNotFoundError();
    if (matches.length > 1) throw new AiTaskSourceValidationError("来源任务 ID 不唯一");
    return matches[0];
  }

  async function resolveForCreate({ sourceTaskId, requestedContext }) {
    const id = normalizeTaskId(sourceTaskId);
    const date = shanghaiDate(now());
    const task = await readTask(date, id);
    assertTaskRelationship(task);
    assertRequestedContext(requestedContext, task);
    const resolved = await contextResolver.resolve({ type: task.linkType, id: task.linkId });
    return {
      sourceTask: {
        id: task.id,
        date,
        title: task.title,
        linkType: task.linkType,
        linkId: task.linkId,
        fingerprint: fingerprint(task),
        assetSha256: resolved.currentHash,
      },
      resolvedContext: resolved,
    };
  }

  async function reverify(storedSourceTask, storedSourceRefs = []) {
    if (!storedSourceTask || typeof storedSourceTask !== "object") {
      throw new AiTaskSourceValidationError("AI 任务缺少来源任务证据");
    }
    const task = await readTask(storedSourceTask.date, normalizeTaskId(storedSourceTask.id));
    assertTaskRelationship(task);
    if (
      fingerprint(task) !== storedSourceTask.fingerprint
      || task.linkType !== storedSourceTask.linkType
      || task.linkId !== storedSourceTask.linkId
    ) {
      throw new AiTaskSourceConflictError("来源任务标题或关联资产已经变化，请重新发起 AI 任务");
    }
    const resolved = await contextResolver.resolve({ type: task.linkType, id: task.linkId });
    if (resolved.currentHash !== storedSourceTask.assetSha256) {
      throw new AiTaskSourceConflictError("来源任务关联的权威资产已经变化，请重新发起 AI 任务");
    }
    const originalEvidence = canonicalSourceEvidence(storedSourceRefs, true);
    const currentEvidence = canonicalSourceEvidence(resolved.sourceRefs, false);
    if (JSON.stringify(originalEvidence) !== JSON.stringify(currentEvidence)) {
      throw new AiTaskSourceConflictError("来源任务的完整权威资料集合已经变化，请重新发起 AI 任务");
    }
    return { task, resolvedContext: resolved };
  }

  return { resolveForCreate, reverify, dailyTasksStore };
}
