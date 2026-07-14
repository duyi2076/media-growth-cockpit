import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { buildVaultIndex } from "../../scripts/build-vault-index.mjs";
import { validateIndexCandidate } from "../../scripts/validate-data.mjs";
import { createActionTargetsStore } from "../action-targets-store.mjs";
import { createContentAssetsStore, ContentAssetsValidationError } from "../content-assets-store.mjs";
import { createDailyTasksStore } from "../daily-tasks-store.mjs";
import { createPlatformFollowersStore } from "../platform-followers-store.mjs";

const REAL_ROOT = path.join(os.homedir(), "第二大脑-v2");
const HAS_REAL_ROOT = fs.existsSync(REAL_ROOT);
const NOW = new Date("2026-07-13T12:00:00.000Z");

describe("网页写回与完整索引契约", { skip: !HAS_REAL_ROOT }, () => {
  let base;
  let root;
  let stateRoot;

  before(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), "creator-cross-layer-"));
    root = path.join(base, "第二大脑-v2");
    stateRoot = path.join(base, ".state");
    await fsp.cp(REAL_ROOT, root, { recursive: true, dereference: false });
  });

  after(async () => {
    await fsp.rm(base, { recursive: true, force: true });
  });

  async function validateCopy() {
    const { index } = buildVaultIndex(fs.realpathSync(root));
    assert.deepEqual(validateIndexCandidate(index), []);
  }

  test("平台粉丝日期推进后仍能通过完整索引门禁", async () => {
    const store = createPlatformFollowersStore({ root, stateRoot, now: () => NOW, afterWrite: validateCopy });
    const initial = await store.read();
    const targetId = initial.accounts[0]?.id;
    assert.ok(targetId);
    const next = initial.accounts.map((account) => ({
      id: account.id,
      currentFollowers: account.id === targetId ? account.currentFollowers + 1 : account.currentFollowers,
    }));
    const saved = await store.write(next, initial.hash);
    assert.equal(saved.accounts.find((account) => account.id === targetId).asOf, "2026-07-13");
  });

  test("今日任务与行动目标写回后仍能通过完整索引门禁", async () => {
    const daily = createDailyTasksStore({ root, stateRoot, now: () => NOW, afterWrite: validateCopy });
    const dailyInitial = await daily.read("2026-07-13");
    const dailySaved = await daily.write(
      "2026-07-13",
      dailyInitial.tasks.map((task, index) => index === 0 ? { ...task, title: `${task.title}（契约测试）` } : task),
      dailyInitial.hash,
    );
    assert.match(dailySaved.tasks[0].title, /契约测试/);

    const targets = createActionTargetsStore({ root, stateRoot, now: () => NOW, afterWrite: validateCopy });
    const targetInitial = await targets.read();
    const targetSaved = await targets.write(
      targetInitial.targets.map((item) => ({ ...item, target: item.id === "account-breakdown" ? 11 : item.target })),
      targetInitial.hash,
    );
    assert.equal(targetSaved.targets.find((item) => item.id === "account-breakdown").target, 11);
  });

  test("正常图片术语可保存，疑似凭证会在写入前拒绝", async () => {
    const content = createContentAssetsStore({ root, stateRoot, now: () => NOW, afterWrite: validateCopy });
    const created = await content.create({
      title: "PNG 图片如何做",
      summary: "讲清 hero.png 的使用方法",
      status: "候选选题",
      format: "文章",
      channels: ["B站"],
      priority: null,
      dueAt: null,
      nextAction: "完成选题判断",
    });
    assert.deepEqual(created.channels, ["B 站"]);
    await assert.rejects(
      content.create({
        title: "敏感测试",
        summary: "api_token: sk-abc123xyz",
        status: "候选选题",
        format: "文章",
        channels: ["公众号"],
        priority: null,
        dueAt: null,
        nextAction: "停止",
      }),
      ContentAssetsValidationError,
    );
  });

  test("制作完成与平台发布分别写入事实并自动回算行动目标", async () => {
    const content = createContentAssetsStore({ root, stateRoot, now: () => NOW, afterWrite: validateCopy });
    const before = buildVaultIndex(fs.realpathSync(root)).index;
    const beforeArticle = before.actionTargets.find((item) => item.id === "article-output").current;
    const beforePublish = before.actionTargets.find((item) => item.id === "platform-publish").current;
    const created = await content.create({
      title: "制作与发布计数契约",
      summary: "隔离副本中的完整统计链路测试。",
      status: "候选选题",
      format: "文章",
      channels: ["公众号"],
      priority: null,
      dueAt: null,
      nextAction: "标记完成",
    });

    const completed = await content.complete(created.id, created.hash);
    assert.equal(completed.status, "待发布");
    assert.equal(completed.completedAt, NOW.toISOString());
    let index = buildVaultIndex(fs.realpathSync(root)).index;
    assert.equal(index.actionTargets.find((item) => item.id === "article-output").current, beforeArticle + 1);
    assert.equal(index.actionTargets.find((item) => item.id === "platform-publish").current, beforePublish);

    const firstPublication = await content.registerPublication(created.id, {
      platform: "公众号",
      publishedAt: "2026-07-13T11:00:00.000Z",
      url: "https://example.com/cross-layer/article",
      confirmed: true,
    }, completed.hash);
    index = buildVaultIndex(fs.realpathSync(root)).index;
    assert.equal(firstPublication.status, "已发布");
    assert.equal(index.actionTargets.find((item) => item.id === "article-output").current, beforeArticle + 1);
    assert.equal(index.actionTargets.find((item) => item.id === "platform-publish").current, beforePublish + 1);

    const secondPublication = await content.registerPublication(created.id, {
      platform: "小红书",
      publishedAt: "2026-07-13T11:30:00.000Z",
      url: "https://example.com/cross-layer/article-xhs",
      confirmed: true,
    }, firstPublication.hash);
    index = buildVaultIndex(fs.realpathSync(root)).index;
    assert.equal(index.actionTargets.find((item) => item.id === "article-output").current, beforeArticle + 1);
    assert.equal(index.actionTargets.find((item) => item.id === "platform-publish").current, beforePublish + 2);

    await assert.rejects(
      content.registerPublication(created.id, {
        platform: "公众号",
        publishedAt: "2026-07-13T11:45:00.000Z",
        url: "https://example.com/cross-layer/article",
        confirmed: true,
      }, secondPublication.hash),
      ContentAssetsValidationError,
    );
    index = buildVaultIndex(fs.realpathSync(root)).index;
    assert.equal(index.actionTargets.find((item) => item.id === "platform-publish").current, beforePublish + 2);
  });
});
