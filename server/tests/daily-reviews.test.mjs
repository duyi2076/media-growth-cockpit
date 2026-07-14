import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parse as parseYaml } from "yaml";
import { buildVaultIndex } from "../../scripts/build-vault-index.mjs";
import { validateIndexCandidate } from "../../scripts/validate-data.mjs";
import { createDailyReviewsMiddleware } from "../daily-reviews-api.mjs";
import {
  DAILY_REVIEWS_RELATIVE_DIR,
  DailyReviewsCommitError,
  DailyReviewsConflictError,
  DailyReviewsSecurityError,
  DailyReviewsValidationError,
  createDailyReviewsStore,
} from "../daily-reviews-store.mjs";
import {
  DEFAULT_COCKPIT_SETTINGS,
  createCockpitSettingsStore,
} from "../cockpit-settings-store.mjs";
import { createReviewAssetsStore } from "../review-assets-store.mjs";
import { readCockpitSettingsSync } from "../cockpit-settings-store.mjs";

const NOW = new Date("2026-07-14T12:00:00.000Z");
const REAL_ROOT = path.join(os.homedir(), "第二大脑-v2");
const HAS_REAL_ROOT = fsSync.existsSync(REAL_ROOT);
const temporaryDirectories = [];

async function project() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-daily-reviews-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "第二大脑-v2");
  const stateRoot = path.join(base, ".state");
  await fs.mkdir(root, { recursive: true });
  await createCockpitSettingsStore({ root, stateRoot, now: () => NOW, afterWrite: async () => {} }).write({
    ...DEFAULT_COCKPIT_SETTINGS,
    ownerName: "测试创作者",
  }, null);
  return { base, root, stateRoot, dailyReviewRoot: path.join(root, DAILY_REVIEWS_RELATIVE_DIR) };
}

function input(overrides = {}) {
  return {
    date: "2026-07-14",
    todayCompleted: "完成一篇文章和一条视频脚本。",
    facts: "文章发布 1 篇，视频脚本完成 1 条。",
    effectiveActions: "先写标题承诺，再补正文证据。",
    problems: "视频开头仍然太慢。",
    judgment: "今天的产量达标，但视频钩子需要继续收紧。",
    tomorrowAction: "先完成一条视频的前三秒重写。",
    ...overrides,
  };
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match);
  return parseYaml(match[1]);
}

function storeFor(value, options = {}) {
  return createDailyReviewsStore({
    root: value.root,
    stateRoot: value.stateRoot,
    now: () => NOW,
    afterWrite: async () => {},
    ...options,
  });
}

async function withServer(value, run) {
  const middleware = createDailyReviewsMiddleware({ store: storeFor(value) });
  const server = http.createServer((request, response) => middleware(request, response, () => {
    response.statusCode = 404;
    response.end("not found");
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { await run(baseUrl); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("每日整体复盘受控写回", () => {
  test("create/list：按日期写入经营看板目录，初始为待人工确认", async () => {
    const value = await project();
    const created = await storeFor(value).create(input());
    assert.equal(created.id, "daily-review-2026-07-14");
    assert.equal(created.confirmation, "待人工确认");
    assert.equal(created.confirmedAt, null);
    assert.equal(path.isAbsolute(created.source), false);
    assert.ok(created.source.startsWith(`${DAILY_REVIEWS_RELATIVE_DIR}${path.sep}`));
    const markdown = await fs.readFile(path.join(value.root, created.source), "utf8");
    const frontmatter = parseFrontmatter(markdown);
    assert.equal(frontmatter.type, "经营看板");
    assert.equal(frontmatter.dashboard_kind, "daily-review");
    assert.equal(frontmatter.status, "待确认");
    assert.equal(frontmatter.confirmed_at, null);
    assert.equal(frontmatter.origin_owner, "测试创作者");
    assert.match(markdown, /## 今日完成/);
    assert.match(markdown, /## 明日最重要动作/);
    assert.equal((await storeFor(value).list()).items.length, 1);
  });

  test("create 幂等：同一请求编号与载荷只写一次，改载荷返回当前记录", async () => {
    const value = await project();
    let afterWriteCalls = 0;
    const store = storeFor(value, { afterWrite: async () => { afterWriteCalls += 1; } });
    const clientRequestId = "77777777-7777-4777-8777-777777777777";
    const created = await store.create(input(), { clientRequestId });
    const replayed = await store.create(input(), { clientRequestId });

    assert.equal(replayed.id, created.id);
    assert.equal(replayed.hash, created.hash);
    assert.equal(afterWriteCalls, 1);
    assert.equal((await store.list()).items.length, 1);
    const markdown = await fs.readFile(path.join(value.root, created.source), "utf8");
    const frontmatter = parseFrontmatter(markdown);
    assert.equal(frontmatter.client_request_id, clientRequestId);
    assert.match(frontmatter.create_request_hash, /^[a-f0-9]{64}$/);

    await assert.rejects(
      store.create(input({ judgment: "同一个请求编号不能改写原始载荷。" }), { clientRequestId }),
      (error) => error instanceof DailyReviewsConflictError
        && error.current?.id === created.id
        && error.current?.judgment === created.judgment,
    );
  });

  test("create 崩溃恢复：缺少成功审计时重跑 afterWrite，而不是直接返回孤儿文件", async () => {
    const value = await project();
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const created = await storeFor(value).create(input(), { clientRequestId });
    await fs.rm(path.join(value.stateRoot, "audit", "daily-reviews.jsonl"));

    let recoveryCalls = 0;
    const recoveringStore = storeFor(value, {
      afterWrite: async (event) => {
        recoveryCalls += 1;
        assert.equal(event.recovered, true);
        assert.equal(event.id, created.id);
      },
    });
    const recovered = await recoveringStore.create(input(), { clientRequestId });

    assert.equal(recovered.id, created.id);
    assert.equal(recoveryCalls, 1);
    assert.equal((await recoveringStore.list()).items.length, 1);
    const audit = await fs.readFile(path.join(value.stateRoot, "audit", "daily-reviews.jsonl"), "utf8");
    assert.match(audit, /"action":"create-recovered"/);
    assert.match(audit, /"status":"success"/);
  });

  test("create 幂等审计读取拒绝跳出 stateRoot 的软链接目录", async () => {
    const value = await project();
    const clientRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const store = storeFor(value);
    await store.create(input(), { clientRequestId });

    const auditRoot = path.join(value.stateRoot, "audit");
    const outsideAuditRoot = path.join(value.base, "outside-audit");
    await fs.rename(auditRoot, outsideAuditRoot);
    await fs.symlink(outsideAuditRoot, auditRoot, "dir");

    await assert.rejects(
      store.create(input(), { clientRequestId }),
      DailyReviewsSecurityError,
    );
  });

  test("确认、审计与重新确认：确认需六项完整，编辑已确认记录会自动回到待确认", async () => {
    const value = await project();
    const store = storeFor(value);
    const created = await store.create(input({ judgment: "" }));
    await assert.rejects(
      store.update(created.id, { confirmation: "已确认" }, created.hash),
      (error) => error instanceof DailyReviewsValidationError && /今日判断/.test(error.message),
    );
    const completeDraft = await store.update(created.id, { judgment: input().judgment }, created.hash);
    const confirmed = await store.update(completeDraft.id, { confirmation: "已确认" }, completeDraft.hash);
    assert.equal(confirmed.confirmation, "已确认");
    assert.equal(confirmed.confirmedAt, NOW.toISOString());
    const edited = await store.update(confirmed.id, { problems: "重新判断后的问题。" }, confirmed.hash);
    assert.equal(edited.confirmation, "待人工确认");
    assert.equal(edited.confirmedAt, null);
    const markdown = await fs.readFile(path.join(value.root, edited.source), "utf8");
    assert.equal(parseFrontmatter(markdown).confirmed_at, null);
    const audit = await fs.readFile(path.join(value.stateRoot, "audit", "daily-reviews.jsonl"), "utf8");
    assert.match(audit, /"action":"confirm"/);
    assert.match(audit, /"action":"reopen-after-edit"/);
    assert.ok((await fs.readdir(path.join(value.stateRoot, "backups", "daily-reviews"))).length >= 3);
  });

  test("日期唯一、哈希冲突与回滚不会覆盖已有事实", async () => {
    const value = await project();
    const stable = storeFor(value);
    const created = await stable.create(input());
    await assert.rejects(stable.create(input()), DailyReviewsValidationError);
    await assert.rejects(
      stable.update(created.id, { judgment: "旧版本覆盖" }, "0".repeat(64)),
      DailyReviewsConflictError,
    );
    const filePath = path.join(value.root, created.source);
    const before = await fs.readFile(filePath, "utf8");
    const failing = storeFor(value, { afterWrite: async ({ rollback }) => { if (!rollback) throw new Error("模拟索引失败"); } });
    await assert.rejects(failing.update(created.id, { judgment: "不能留下" }, created.hash), DailyReviewsCommitError);
    assert.equal(await fs.readFile(filePath, "utf8"), before);
  });

  test("同进程双 store：同一旧哈希并发更新时仅一次成功", async () => {
    const value = await project();
    const firstStore = storeFor(value);
    const secondStore = storeFor(value);
    const initial = await firstStore.create(input());

    const results = await Promise.allSettled([
      firstStore.update(initial.id, { judgment: "第一个实例的修改" }, initial.hash),
      secondStore.update(initial.id, { judgment: "第二个实例的修改" }, initial.hash),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DailyReviewsConflictError);
    assert.equal((await firstStore.list()).items[0].judgment, fulfilled[0].value.judgment);
  });

  test("API：同源 GET/POST/PUT 可用，无 Origin 和旧哈希被拒绝", async () => {
    const value = await project();
    await withServer(value, async (baseUrl) => {
      const headers = {
        "content-type": "application/json",
        origin: baseUrl,
        "X-Idempotency-Key": "88888888-8888-4888-8888-888888888888",
      };
      const noOrigin = await fetch(`${baseUrl}/api/daily-reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input()),
      });
      assert.equal(noOrigin.status, 403);
      const missingKey = await fetch(`${baseUrl}/api/daily-reviews`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseUrl },
        body: JSON.stringify(input()),
      });
      assert.equal(missingKey.status, 400);
      const createdResponse = await fetch(`${baseUrl}/api/daily-reviews`, { method: "POST", headers, body: JSON.stringify(input()) });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();
      const replayedResponse = await fetch(`${baseUrl}/api/daily-reviews`, { method: "POST", headers, body: JSON.stringify(input()) });
      assert.equal(replayedResponse.status, 201);
      assert.equal((await replayedResponse.json()).id, created.id);
      const changedPayloadResponse = await fetch(`${baseUrl}/api/daily-reviews`, {
        method: "POST",
        headers,
        body: JSON.stringify(input({ judgment: "同一个幂等编号使用了不同载荷。" })),
      });
      assert.equal(changedPayloadResponse.status, 409);
      assert.equal((await changedPayloadResponse.json()).current.id, created.id);
      assert.equal((await (await fetch(`${baseUrl}/api/daily-reviews`)).json()).items.length, 1);
      const confirmedResponse = await fetch(`${baseUrl}/api/daily-reviews`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ id: created.id, patch: { confirmation: "已确认" }, expectedHash: created.hash }),
      });
      assert.equal(confirmedResponse.status, 200);
      assert.equal((await confirmedResponse.json()).confirmation, "已确认");
      const conflictResponse = await fetch(`${baseUrl}/api/daily-reviews`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ id: created.id, patch: { problems: "旧版本" }, expectedHash: created.hash }),
      });
      assert.equal(conflictResponse.status, 409);
    });
  });

  test("索引口径：只计已确认每日复盘，单条内容复盘不增加复盘目标", { skip: !HAS_REAL_ROOT }, async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-daily-review-index-"));
    temporaryDirectories.push(base);
    const root = path.join(base, "第二大脑-v2");
    const stateRoot = path.join(base, ".state");
    await fs.cp(REAL_ROOT, root, { recursive: true, dereference: false });
    const copiedDailyReviewRoot = path.join(root, DAILY_REVIEWS_RELATIVE_DIR);
    await fs.rm(copiedDailyReviewRoot, { recursive: true, force: true });
    await fs.mkdir(copiedDailyReviewRoot, { recursive: true });
    const targetPath = path.join(root, readCockpitSettingsSync(root).projectRelativeDir, "01-目标与验收.md");
    const targets = await fs.readFile(targetPath, "utf8");
    await fs.writeFile(targetPath, targets
      .replace(/^campaign_started_at:.*$/m, "campaign_started_at: 2026-07-14T00:00:00.000Z")
      .replaceAll("confirmed_content_reviews", "confirmed_daily_reviews"), "utf8");
    const build = () => buildVaultIndex(fsSync.realpathSync(root));
    const validate = async () => {
      const result = build();
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(validateIndexCandidate(result.index), []);
      return result.index;
    };
    const baseline = await validate();
    const before = baseline.actionTargets.find((item) => item.id === "content-review").current;
    const dailyStore = createDailyReviewsStore({ root, stateRoot, now: () => NOW, afterWrite: validate });
    const pending = await dailyStore.create(input());
    assert.equal((await validate()).actionTargets.find((item) => item.id === "content-review").current, before);
    const confirmed = await dailyStore.update(pending.id, { confirmation: "已确认" }, pending.hash);
    assert.equal((await validate()).actionTargets.find((item) => item.id === "content-review").current, before + 1);

    const singleReviewStore = createReviewAssetsStore({ root, stateRoot, now: () => NOW, afterWrite: validate });
    const single = await singleReviewStore.create({
      kind: "content-review",
      title: "单条内容复盘不计每日复盘",
      sourceUrl: "https://example.com/content-review",
      platform: "公众号",
      relatedContentId: null,
      summary: "一条内容的结果。",
      findings: "标题与正文承诺一致。",
      nextAction: "下一篇继续使用该结构。",
    });
    await singleReviewStore.update(single.id, { confirmation: "已确认" }, single.hash);
    assert.equal((await validate()).actionTargets.find((item) => item.id === "content-review").current, before + 1);

    const reopened = await dailyStore.update(confirmed.id, { judgment: "编辑后的新判断。" }, confirmed.hash);
    assert.equal(reopened.confirmation, "待人工确认");
    assert.equal((await validate()).actionTargets.find((item) => item.id === "content-review").current, before);
  });
});
