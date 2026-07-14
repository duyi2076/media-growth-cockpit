import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createActionTargetsMiddleware } from "../action-targets-api.mjs";
import { createCockpitSettingsStore } from "../cockpit-settings-store.mjs";
import {
  ACTION_TARGETS_RELATIVE_PATH,
  ActionTargetsCommitError,
  ActionTargetsConflictError,
  ActionTargetsSecurityError,
  ActionTargetsValidationError,
  createActionTargetsStore,
} from "../action-targets-store.mjs";

const NOW = new Date("2026-07-12T04:00:00.000Z");
const temporaryDirectories = [];

function targets(publish = null) {
  return [
    { id: "article-output", target: 100 },
    { id: "video-output", target: 60 },
    { id: "platform-publish", target: publish },
    { id: "content-review", target: 60 },
    { id: "account-breakdown", target: 10 },
  ];
}

function markdown() {
  return `---
id: goals
type: 项目目标
status: 进行中
updated_at: 2026-07-11
confirmation: 已确认
action_targets:
  - id: article-output
    label: 文章
    target: 100
    unit: 篇
    count_rule: completed_article_assets
  - id: video-output
    label: 视频
    target: 60
    unit: 条
    count_rule: completed_video_assets
  - id: platform-publish
    label: 发布
    target: null
    unit: 次
    count_rule: platform_publication_records
  - id: content-review
    label: 复盘
    target: 60
    unit: 次
    count_rule: confirmed_content_reviews
  - id: account-breakdown
    label: 账号拆解
    target: 10
    unit: 个
    count_rule: confirmed_account_breakdowns
---

# 目标与验收

正文必须保留。

## 行动目标

| 动作 | 目标 | 完成数来源 |
|---|---:|---|
| 文章 | 100 篇 | 旧口径 |
| 视频 | 60 条 | 旧口径 |
| 发布 | 待填写 | 旧口径 |
| 复盘 | 60 次 | 旧口径 |
| 账号拆解 | 10 个 | 旧口径 |
`;
}

async function project() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-action-targets-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "第二大脑-v2");
  const stateRoot = path.join(base, ".media-growth-cockpit");
  const filePath = path.join(root, ACTION_TARGETS_RELATIVE_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, markdown(), "utf8");
  return { base, root, stateRoot, filePath };
}

function storeFor(value, options = {}) {
  return createActionTargetsStore({
    root: value.root,
    stateRoot: value.stateRoot,
    now: () => NOW,
    afterWrite: async () => {},
    ...options,
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("行动目标安全存储", () => {
  test("读取、写入并保留正文", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = await store.read();
    assert.equal(initial.targets[2].target, null);
    assert.equal(initial.campaignStartedAt, null);
    const saved = await store.write(targets(180), initial.hash);
    assert.equal(saved.targets[2].target, 180);
    const contents = await fs.readFile(value.filePath, "utf8");
    assert.match(contents, /count_rule: confirmed_daily_reviews/);
    assert.match(contents, /已确认的每日整体复盘/);
    assert.match(contents, /正文必须保留/);
    assert.match(contents, /updated_at: 2026-07-12/);
    assert.match(contents, /target: 180/);
    assert.match(contents, /\| 发布 \| 180 次 \|/);
    assert.match(contents, /人工确认成稿的文章内容资产/);
    assert.doesNotMatch(contents, /旧口径/);
  });

  test("拒绝非法目标和旧哈希", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = await store.read();
    await assert.rejects(store.write(targets(0), initial.hash), ActionTargetsValidationError);
    await assert.rejects(store.write(targets(100), "0".repeat(64)), ActionTargetsConflictError);
  });

  test("同一旧哈希并发写入只允许一个成功", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = await store.read();
    const results = await Promise.allSettled([
      store.write(targets(180), initial.hash),
      store.write(targets(240), initial.hash),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.ok(results.some((item) => item.status === "rejected" && item.reason instanceof ActionTargetsConflictError));
  });

  test("两个目标 store 实例写同一文件时共享乐观锁队列", async () => {
    const value = await project();
    const storeA = storeFor(value);
    const storeB = storeFor(value);
    const initial = await storeA.read();

    const results = await Promise.allSettled([
      storeA.write(targets(180), initial.hash),
      storeB.write(targets(240), initial.hash),
    ]);

    const fulfilled = results.filter((item) => item.status === "fulfilled");
    const rejected = results.filter((item) => item.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ActionTargetsConflictError);
    assert.equal(rejected[0].reason.current.hash, fulfilled[0].value.hash);
  });

  test("拒绝目标文件软链接", async () => {
    const value = await project();
    const outside = path.join(value.base, "outside.md");
    await fs.writeFile(outside, markdown(), "utf8");
    await fs.rm(value.filePath);
    await fs.symlink(outside, value.filePath);
    await assert.rejects(storeFor(value).read(), ActionTargetsSecurityError);
  });

  test("拒绝软链接备份目录，目标原文不会泄露到链外", async () => {
    const value = await project();
    const outsideBackup = path.join(value.base, "outside-action-backups");
    const backupsParent = path.join(value.stateRoot, "backups");
    await fs.mkdir(outsideBackup, { recursive: true });
    await fs.mkdir(backupsParent, { recursive: true });
    await fs.symlink(outsideBackup, path.join(backupsParent, "action-targets"));
    const store = storeFor(value);
    const initial = await store.read();
    const before = await fs.readFile(value.filePath, "utf8");

    await assert.rejects(store.write(targets(180), initial.hash), ActionTargetsSecurityError);

    assert.equal(await fs.readFile(value.filePath, "utf8"), before);
    assert.deepEqual(await fs.readdir(outsideBackup), []);
  });

  test("索引失败时恢复旧文件", async () => {
    const value = await project();
    let attempts = 0;
    const store = storeFor(value, {
      afterWrite: async ({ rollback }) => {
        attempts += 1;
        if (!rollback) throw new Error("模拟索引失败");
      },
    });
    const initial = await store.read();
    await assert.rejects(store.write(targets(180), initial.hash), ActionTargetsCommitError);
    assert.equal(attempts, 2);
    const restored = await store.read();
    assert.equal(restored.hash, initial.hash);
    assert.equal(restored.targets[2].target, null);
  });

  test("正式开始统计只记录一次服务端时间", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = await store.read();
    const started = await store.write(initial.targets, initial.hash, { startCampaign: true });
    assert.equal(started.campaignStartedAt, NOW.toISOString());
    const repeated = await store.write(started.targets, started.hash, { startCampaign: true });
    assert.equal(repeated.campaignStartedAt, NOW.toISOString());
    const contents = await fs.readFile(value.filePath, "utf8");
    assert.match(contents, /campaign_started_at: 2026-07-12T04:00:00\.000Z/);
  });

  test("同一目标服务在设置更新后立即读取新项目目录", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-action-targets-runtime-settings-"));
    temporaryDirectories.push(base);
    const root = path.join(base, "第二大脑-v2");
    const stateRoot = path.join(base, ".media-growth-cockpit");
    await fs.mkdir(root, { recursive: true });
    const settingsStore = createCockpitSettingsStore({ root, stateRoot, now: () => NOW, afterWrite: async () => {} });
    const baseSettings = {
      productName: "创作者驾驶舱",
      ownerName: "使用者",
      creatorPositioning: "科普博主",
      campaignName: "增长计划",
      growthTarget: 10_000,
      startDate: null,
      deadline: null,
      projectRelativeDir: "50-进行中项目/旧项目",
      baselineDate: "2026-07-12",
      baselineRelativePath: "60-数据与看板/01-内容数据/2026-07-12-平台粉丝基线.md",
    };
    const initialSettings = await settingsStore.write(baseSettings, null);
    const oldPath = path.join(root, "50-进行中项目/旧项目/01-目标与验收.md");
    const newPath = path.join(root, "50-进行中项目/新项目/01-目标与验收.md");
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.writeFile(oldPath, markdown(), "utf8");
    await fs.writeFile(newPath, markdown().replace("target: 100", "target: 222"), "utf8");
    const store = createActionTargetsStore({ root, stateRoot, now: () => NOW, afterWrite: async () => {} });

    await settingsStore.write({ ...baseSettings, projectRelativeDir: "50-进行中项目/新项目" }, initialSettings.hash);
    const current = await store.read();

    assert.equal(store.filePath, newPath);
    assert.equal(current.targets[0].target, 222);
  });
});

describe("行动目标 HTTP API", () => {
  async function withServer(value, run) {
    const middleware = createActionTargetsMiddleware({ store: storeFor(value) });
    const server = http.createServer((request, response) => middleware(request, response, () => {
      response.statusCode = 404;
      response.end("not found");
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      await run(baseUrl);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  test("GET 与同源 PUT 往返", async () => {
    const value = await project();
    await withServer(value, async (baseUrl) => {
      const initial = await (await fetch(`${baseUrl}/api/action-targets`)).json();
      assert.equal(initial.campaignStartedAt, null);
      const response = await fetch(`${baseUrl}/api/action-targets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ targets: targets(180), expectedHash: initial.hash }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).targets[2].target, 180);

      const latest = await (await fetch(`${baseUrl}/api/action-targets`)).json();
      const startResponse = await fetch(`${baseUrl}/api/action-targets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ targets: targets(180), expectedHash: latest.hash, startCampaign: true }),
      });
      assert.equal(startResponse.status, 200);
      assert.equal((await startResponse.json()).campaignStartedAt, NOW.toISOString());
    });
  });

  test("拒绝查询参数和缺失 Origin", async () => {
    const value = await project();
    await withServer(value, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/api/action-targets?path=x`)).status, 400);
      const initial = await (await fetch(`${baseUrl}/api/action-targets`)).json();
      const response = await fetch(`${baseUrl}/api/action-targets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets: targets(180), expectedHash: initial.hash }),
      });
      assert.equal(response.status, 403);
    });
  });
});
