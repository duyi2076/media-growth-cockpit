import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDailyReview,
  type CreateDailyReviewInput,
  type DailyReviewSnapshot,
} from "@/data/dailyReviewsClient";

const clientRequestId = "99999999-9999-4999-8999-999999999999";

function input(): CreateDailyReviewInput {
  return {
    date: "2026-07-14",
    todayCompleted: "完成一篇文章。",
    facts: "发布 1 篇。",
    effectiveActions: "先写结论。",
    problems: "开头偏慢。",
    judgment: "文章产量达标。",
    tomorrowAction: "重写视频前三秒。",
  };
}

function snapshot(): DailyReviewSnapshot {
  return {
    id: "daily-review-2026-07-14",
    ...input(),
    confirmation: "待人工确认",
    confirmedAt: null,
    hash: "a".repeat(64),
    updatedAt: "2026-07-14T05:00:00.000Z",
    source: "60-数据与看板/05-经营看板/每日复盘/2026-07-14-每日复盘.md",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("每日复盘客户端", () => {
  it("POST 携带 X-Idempotency-Key 并解析成功快照", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("X-Idempotency-Key")).toBe(clientRequestId);
      return new Response(JSON.stringify(snapshot()), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(createDailyReview(input(), clientRequestId)).resolves.toMatchObject({
      id: "daily-review-2026-07-14",
      date: "2026-07-14",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("409 current 转成可供页面找回原记录的冲突错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "hash_conflict",
      current: snapshot(),
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(createDailyReview({ ...input(), judgment: "重试前改过的判断" }, clientRequestId))
      .rejects.toMatchObject({
        name: "DailyReviewsConflictError",
        snapshot: {
          id: "daily-review-2026-07-14",
          judgment: "文章产量达标。",
        },
      });
  });

  it("无效请求编号在发出网络请求前被拒绝", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(createDailyReview(input(), "not-a-uuid")).rejects.toThrow("请求编号无效");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
