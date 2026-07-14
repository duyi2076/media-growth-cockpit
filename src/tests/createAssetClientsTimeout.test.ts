import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContentAsset,
  type ContentAssetSnapshot,
  type CreateContentAssetInput,
} from "@/data/contentAssetsClient";
import {
  createDailyReview,
  type CreateDailyReviewInput,
  type DailyReviewSnapshot,
} from "@/data/dailyReviewsClient";
import {
  createReviewAsset,
  type CreateReviewAssetInput,
  type ReviewAssetSnapshot,
} from "@/data/reviewAssetsClient";

const clientRequestId = "88888888-8888-4888-8888-888888888888";
const writeTimeoutMs = 30_000;
let timeoutDescriptor: PropertyDescriptor | undefined;

function json(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timeoutThenSuccess(snapshot: unknown) {
  const keys: Array<string | null> = [];
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    keys.push(new Headers(init?.headers).get("X-Idempotency-Key"));
    if (keys.length > 1) return Promise.resolve(json(snapshot));

    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing timeout signal"));
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, keys };
}

async function expectBoundedTimeoutAndSafeRetry<T>(
  operation: () => Promise<T>,
  keys: Array<string | null>,
): Promise<T> {
  let settled = false;
  const firstAttempt = operation().finally(() => { settled = true; });
  const rejection = expect(firstAttempt).rejects.toThrow("无法确认保存结果");

  await vi.advanceTimersByTimeAsync(writeTimeoutMs - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejection;
  expect(settled).toBe(true);

  const recovered = await operation();
  expect(keys).toEqual([clientRequestId, clientRequestId]);
  return recovered;
}

beforeEach(() => {
  vi.useFakeTimers();
  timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });
});

afterEach(() => {
  if (timeoutDescriptor) Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
  else Reflect.deleteProperty(AbortSignal, "timeout");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("新建资产写回超时", () => {
  it("内容新建在 30 秒结束等待，重试沿用同一幂等编号", async () => {
    const input: CreateContentAssetInput = {
      title: "超时恢复选题",
      summary: "用于验证有界写回。",
      status: "候选选题",
      format: "文章",
      channels: ["公众号"],
      priority: null,
      dueAt: null,
      nextAction: "确认是否值得发布",
    };
    const snapshot: ContentAssetSnapshot = {
      id: "content-timeout-recovered",
      title: input.title,
      status: input.status,
      format: input.format,
      channels: input.channels,
      priority: input.priority,
      dueAt: input.dueAt,
      nextAction: input.nextAction,
      completedAt: null,
      publicationRecords: [],
      hash: "a".repeat(64),
      updatedAt: "2026-07-14T06:00:00.000Z",
    };
    const { fetchMock, keys } = timeoutThenSuccess(snapshot);

    await expect(expectBoundedTimeoutAndSafeRetry(
      () => createContentAsset(input, clientRequestId),
      keys,
    )).resolves.toMatchObject({ id: snapshot.id });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("复盘新建在 30 秒结束等待，重试沿用同一幂等编号", async () => {
    const input: CreateReviewAssetInput = {
      kind: "content-review",
      title: "超时恢复复盘",
      sourceUrl: "https://example.com/content",
      platform: "公众号",
      relatedContentId: null,
      summary: "验证复盘写回超时。",
      findings: "等待必须有上限。",
      nextAction: "使用同一请求编号重试。",
    };
    const snapshot: ReviewAssetSnapshot = {
      id: "review-timeout-recovered",
      ...input,
      confirmation: "待人工确认",
      confirmedAt: null,
      hash: "b".repeat(64),
      updatedAt: "2026-07-14T06:00:00.000Z",
      source: "20-知识资产/复盘/review-timeout-recovered.md",
    };
    const { fetchMock, keys } = timeoutThenSuccess(snapshot);

    await expect(expectBoundedTimeoutAndSafeRetry(
      () => createReviewAsset(input, clientRequestId),
      keys,
    )).resolves.toMatchObject({ id: snapshot.id });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("每日复盘新建在 30 秒结束等待，重试沿用同一幂等编号", async () => {
    const input: CreateDailyReviewInput = {
      date: "2026-07-14",
      todayCompleted: "完成超时修复。",
      facts: "首次响应没有返回。",
      effectiveActions: "保留请求编号后重试。",
      problems: "写入此前可能无限等待。",
      judgment: "写回必须有界。",
      tomorrowAction: "继续验证完整流程。",
    };
    const snapshot: DailyReviewSnapshot = {
      id: "daily-review-2026-07-14",
      ...input,
      confirmation: "待人工确认",
      confirmedAt: null,
      hash: "c".repeat(64),
      updatedAt: "2026-07-14T06:00:00.000Z",
      source: "60-数据与看板/05-经营看板/每日复盘/2026-07-14-每日复盘.md",
    };
    const { fetchMock, keys } = timeoutThenSuccess(snapshot);

    await expect(expectBoundedTimeoutAndSafeRetry(
      () => createDailyReview(input, clientRequestId),
      keys,
    )).resolves.toMatchObject({ id: snapshot.id });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
