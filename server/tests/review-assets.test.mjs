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
import { createReviewAssetsMiddleware } from "../review-assets-api.mjs";
import {
  DEFAULT_COCKPIT_SETTINGS,
  createCockpitSettingsStore,
} from "../cockpit-settings-store.mjs";
import {
  CONTENT_ASSETS_RELATIVE_DIR,
  createContentAssetsStore,
} from "../content-assets-store.mjs";
import {
  REVIEW_ASSETS_RELATIVE_DIR,
  ReviewAssetsCommitError,
  ReviewAssetsConflictError,
  ReviewAssetsNotFoundError,
  ReviewAssetsSecurityError,
  ReviewAssetsValidationError,
  createReviewAssetsStore,
} from "../review-assets-store.mjs";
import { readCockpitSettingsSync } from "../cockpit-settings-store.mjs";

const NOW = new Date("2026-07-13T04:05:06.789Z");
const REAL_ROOT = path.join(os.homedir(), "第二大脑-v2");
const HAS_REAL_ROOT = fsSync.existsSync(REAL_ROOT);
const temporaryDirectories = [];

async function project() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-review-assets-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "第二大脑-v2");
  const stateRoot = path.join(base, ".media-growth-cockpit");
  const reviewRoot = path.join(root, REVIEW_ASSETS_RELATIVE_DIR);
  const contentRoot = path.join(root, CONTENT_ASSETS_RELATIVE_DIR);
  const contentPath = path.join(contentRoot, "00-选题池", "原始内容.md");
  await fs.mkdir(reviewRoot, { recursive: true });
  await fs.mkdir(path.dirname(contentPath), { recursive: true });
  await fs.writeFile(
    contentPath,
    "---\nid: content-existing\ntype: 内容资产\nstatus: 候选选题\nconfirmation: 已确认\nsensitivity: 内部\n---\n\n# 原始内容\n",
    "utf8",
  );
  await createCockpitSettingsStore({ root, stateRoot, now: () => NOW, afterWrite: async () => {} }).write({
    ...DEFAULT_COCKPIT_SETTINGS,
    ownerName: "测试创作者",
  }, null);
  return { base, root, stateRoot, reviewRoot, contentRoot, contentPath };
}

function storeFor(value, options = {}) {
  return createReviewAssetsStore({
    root: value.root,
    stateRoot: value.stateRoot,
    now: () => NOW,
    afterWrite: async () => {},
    ...options,
  });
}

function contentReviewInput(overrides = {}) {
  return {
    kind: "content-review",
    title: "一篇公众号文章的内容复盘",
    sourceUrl: null,
    platform: "公众号",
    relatedContentId: "content-existing",
    summary: "文章有阅读，但没有形成有效转化。",
    findings: "开头明确，后半段的行动承接不足。",
    nextAction: "重写结尾，并补一条明确的领取路径。",
    ...overrides,
  };
}

function accountBreakdownInput(overrides = {}) {
  return {
    kind: "account-breakdown",
    title: "小红书账号拆解",
    sourceUrl: "https://www.xiaohongshu.com/user/profile/example",
    platform: "小红书",
    relatedContentId: null,
    summary: "账号围绕 AI 求职发布案例型内容。",
    findings: "高互动内容都有具体对象、结果和过程证据。",
    nextAction: "测试三条带完整证据链的案例内容。",
    ...overrides,
  };
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "expected YAML frontmatter");
  return parseYaml(match[1]);
}

async function withServer(value, run, options = {}) {
  const middleware = createReviewAssetsMiddleware({ store: storeFor(value, options) });
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("复盘资产安全双向写回", () => {
  test("create/list：两类复盘落入固定目录、固定元数据，并只返回 Vault 相对路径", async () => {
    const value = await project();
    const calls = [];
    const store = storeFor(value, { afterWrite: async (context) => calls.push(context) });

    const contentReview = await store.create(contentReviewInput());
    const accountBreakdown = await store.create(accountBreakdownInput());

    assert.equal(contentReview.kind, "content-review");
    assert.equal(accountBreakdown.kind, "account-breakdown");
    assert.equal(contentReview.confirmation, "待人工确认");
    assert.equal(accountBreakdown.confirmation, "待人工确认");
    assert.match(contentReview.hash, /^[a-f0-9]{64}$/);
    assert.equal(path.isAbsolute(contentReview.source), false);
    assert.ok(contentReview.source.startsWith(`${REVIEW_ASSETS_RELATIVE_DIR}${path.sep}`));
    assert.deepEqual(Object.keys(contentReview).sort(), [
      "confirmation",
      "confirmedAt",
      "findings",
      "hash",
      "id",
      "kind",
      "nextAction",
      "platform",
      "relatedContentId",
      "source",
      "sourceUrl",
      "summary",
      "title",
      "updatedAt",
    ].sort());
    assert.equal(calls.length, 2);

    const files = await fs.readdir(value.reviewRoot);
    assert.equal(files.length, 2);
    const metadata = [];
    for (const filename of files) {
      const contents = await fs.readFile(path.join(value.reviewRoot, filename), "utf8");
      metadata.push(parseFrontmatter(contents));
    }
    for (const frontmatter of metadata) {
      assert.equal(frontmatter.type, "复盘");
      assert.equal(frontmatter.status, "待确认");
      assert.equal(frontmatter.sensitivity, "内部");
      assert.equal(frontmatter.processed_by, "人机协作");
      assert.equal(frontmatter.confirmation, "待人工确认");
      assert.equal(frontmatter.confirmed_at, null);
    }
    const contentReviewMetadata = metadata.find((item) => item.topics.includes("内容复盘"));
    const accountBreakdownMetadata = metadata.find((item) => item.topics.includes("账号拆解"));
    assert.equal(contentReviewMetadata.origin_owner, "测试创作者");
    assert.equal(accountBreakdownMetadata.origin_owner, "外部来源");
    const contentReviewMarkdown = await fs.readFile(path.join(value.root, contentReview.source), "utf8");
    const contentReviewFrontmatter = parseFrontmatter(contentReviewMarkdown);
    assert.deepEqual(contentReviewFrontmatter.derived_from, ["[[30-内容资产/00-选题池/原始内容]]"]);
    const linkedPath = path.join(value.root, `${contentReviewFrontmatter.derived_from[0].slice(2, -2)}.md`);
    assert.equal((await fs.stat(linkedPath)).isFile(), true);
    const accountMarkdown = await fs.readFile(path.join(value.root, accountBreakdown.source), "utf8");
    assert.deepEqual(parseFrontmatter(accountMarkdown).derived_from, []);

    const listed = await store.list();
    assert.equal(listed.items.length, 2);
    assert.equal(listed.items.some((item) => "filePath" in item), false);
  });

  test("create：成功后再次提交同一 payload 会新建第二份独立资产", async () => {
    const value = await project();
    const store = storeFor(value);
    const first = await store.create(contentReviewInput());
    const second = await store.create(contentReviewInput());
    assert.notEqual(second.id, first.id);
    assert.equal((await store.list()).items.length, 2);
  });

  test("create：同一客户端请求编号重试只认领一份，载荷变化会冲突", async () => {
    const value = await project();
    const store = storeFor(value);
    const clientRequestId = "11111111-1111-4111-8111-111111111111";
    const first = await store.create(contentReviewInput(), { clientRequestId });
    const replayed = await store.create(contentReviewInput(), { clientRequestId });
    assert.equal(replayed.id, first.id);
    assert.equal((await store.list()).items.length, 1);
    await assert.rejects(
      store.create(contentReviewInput({ title: "同一编号不能换内容" }), { clientRequestId }),
      ReviewAssetsConflictError,
    );
  });

  test("create：同 key 的审计状态缺失或未知时重新执行恢复校验", async () => {
    const value = await project();
    const clientRequestId = "66666666-6666-4666-8666-666666666666";
    const first = await storeFor(value).create(contentReviewInput(), { clientRequestId });
    await fs.writeFile(path.join(value.stateRoot, "audit", "review-assets.jsonl"), "", "utf8");
    const calls = [];
    const replayed = await storeFor(value, {
      afterWrite: async (context) => calls.push(context),
    }).create(contentReviewInput(), { clientRequestId });

    assert.equal(replayed.id, first.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].recovered, true);
    assert.equal((await storeFor(value).list()).items.length, 1);

    await fs.appendFile(
      path.join(value.stateRoot, "audit", "review-assets.jsonl"),
      `${JSON.stringify({ action: "create-recovered", id: first.id, status: "unknown" })}\n`,
      "utf8",
    );
    const unknownCalls = [];
    const replayedUnknown = await storeFor(value, {
      afterWrite: async (context) => unknownCalls.push(context),
    }).create(contentReviewInput(), { clientRequestId });
    assert.equal(replayedUnknown.id, first.id);
    assert.equal(unknownCalls.length, 1);
    assert.equal(unknownCalls[0].recovered, true);
  });

  test("create：跨 key 恢复孤儿时保留旧 key，并让两个 key 都稳定认领同一资产", async () => {
    const value = await project();
    const firstRequestId = "77777777-7777-4777-8777-777777777777";
    const recoveryRequestId = "88888888-8888-4888-8888-888888888888";
    const failingStore = storeFor(value, {
      afterWrite: async () => { throw new Error("模拟索引失败"); },
    });
    await assert.rejects(
      failingStore.create(accountBreakdownInput(), { clientRequestId: firstRequestId }),
      ReviewAssetsCommitError,
    );
    const stableStore = storeFor(value);
    const orphan = (await stableStore.list()).items[0];
    const recovered = await stableStore.create(accountBreakdownInput(), { clientRequestId: recoveryRequestId });
    const replayedFirst = await stableStore.create(accountBreakdownInput(), { clientRequestId: firstRequestId });
    const replayedRecovery = await stableStore.create(accountBreakdownInput(), { clientRequestId: recoveryRequestId });

    assert.equal(recovered.id, orphan.id);
    assert.equal(replayedFirst.id, orphan.id);
    assert.equal(replayedRecovery.id, orphan.id);
    assert.equal((await stableStore.list()).items.length, 1);
    const frontmatter = parseFrontmatter(await fs.readFile(path.join(value.root, recovered.source), "utf8"));
    assert.equal(frontmatter.client_request_id, firstRequestId);
    assert.deepEqual(frontmatter.client_request_aliases, [recoveryRequestId]);
  });

  test("create：legacy 孤儿被带 key 请求恢复后会建立持久主映射", async () => {
    const value = await project();
    const clientRequestId = "99999999-9999-4999-8999-999999999999";
    const failingStore = storeFor(value, {
      afterWrite: async () => { throw new Error("模拟索引失败"); },
    });
    await assert.rejects(failingStore.create(accountBreakdownInput()), ReviewAssetsCommitError);
    const stableStore = storeFor(value);
    const orphan = (await stableStore.list()).items[0];
    const recovered = await stableStore.create(accountBreakdownInput(), { clientRequestId });
    const replayed = await stableStore.create(accountBreakdownInput(), { clientRequestId });

    assert.equal(recovered.id, orphan.id);
    assert.equal(replayed.id, orphan.id);
    assert.equal((await stableStore.list()).items.length, 1);
    const frontmatter = parseFrontmatter(await fs.readFile(path.join(value.root, recovered.source), "utf8"));
    assert.equal(frontmatter.client_request_id, clientRequestId);
    assert.deepEqual(frontmatter.client_request_aliases ?? [], []);
  });

  test("create：同进程并发提交同一 key 只创建一份资产", async () => {
    const value = await project();
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const [first, second] = await Promise.all([
      storeFor(value).create(contentReviewInput(), { clientRequestId }),
      storeFor(value).create(contentReviewInput(), { clientRequestId }),
    ]);
    assert.equal(second.id, first.id);
    assert.equal((await storeFor(value).list()).items.length, 1);
  });

  test("update：只改白名单字段，确认前必须同时具备核心发现和下一步", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = await store.create(contentReviewInput({ findings: "", nextAction: "" }));

    await assert.rejects(
      store.update(initial.id, { confirmation: "已确认" }, initial.hash),
      ReviewAssetsValidationError,
    );
    const unchanged = (await store.list()).items[0];
    assert.equal(unchanged.confirmation, "待人工确认");

    const confirmed = await store.update(initial.id, {
      sourceUrl: "https://example.com/published/content-existing",
      platform: "B站",
      relatedContentId: null,
      summary: "转化链路仍需补齐。",
      findings: "正文有价值，但结尾没有明确动作。",
      nextAction: "补充领取入口并再次发布。",
      confirmation: "已确认",
    }, unchanged.hash);
    assert.equal(confirmed.confirmation, "已确认");
    assert.equal(confirmed.findings, "正文有价值，但结尾没有明确动作。");
    assert.equal(confirmed.sourceUrl, "https://example.com/published/content-existing");
    assert.equal(confirmed.relatedContentId, null);

    const contents = await fs.readFile(path.join(value.root, confirmed.source), "utf8");
    assert.match(contents, /confirmation: 已确认/);
    assert.match(contents, /status: 已确认/);
    assert.equal(parseFrontmatter(contents).confirmed_at, NOW.toISOString());
    assert.deepEqual(parseFrontmatter(contents).derived_from, []);
    assert.match(contents, /## 核心发现\n\n正文有价值，但结尾没有明确动作。/);
    assert.equal((await fs.readdir(path.join(value.stateRoot, "backups", "review-assets"))).length, 1);
    const audit = await fs.readFile(path.join(value.stateRoot, "audit", "review-assets.jsonl"), "utf8");
    assert.match(audit, /"action":"confirm"/);
    assert.doesNotMatch(audit, /正文有价值/);

    const reopened = await store.update(confirmed.id, { confirmation: "待人工确认" }, confirmed.hash);
    const reopenedContents = await fs.readFile(path.join(value.root, reopened.source), "utf8");
    assert.equal(parseFrontmatter(reopenedContents).confirmed_at, null);
    assert.match(reopenedContents, /status: 待确认/);
  });

  test("validation：关系约束、https 约束和严格字段白名单均生效", async () => {
    const value = await project();
    const store = storeFor(value);

    await assert.rejects(
      store.create(contentReviewInput({ sourceUrl: null, relatedContentId: null })),
      ReviewAssetsValidationError,
    );
    await assert.rejects(
      store.create(accountBreakdownInput({ sourceUrl: "http://example.com/profile" })),
      ReviewAssetsValidationError,
    );
    await assert.rejects(
      store.create({ ...contentReviewInput(), unexpected: true }),
      ReviewAssetsValidationError,
    );
    await assert.rejects(
      store.create(contentReviewInput({ relatedContentId: "content-does-not-exist" })),
      ReviewAssetsValidationError,
    );
    await assert.rejects(
      store.create(contentReviewInput({ findings: "第一段\n\n   ## 下一步\n不能伪造章节" })),
      ReviewAssetsValidationError,
    );

    const saved = await store.create(accountBreakdownInput());
    const renamed = await store.update(saved.id, { title: "允许网页修改的拆解标题" }, saved.hash);
    assert.equal(renamed.title, "允许网页修改的拆解标题");
    assert.equal(renamed.source, saved.source);
    await assert.rejects(
      store.update(saved.id, { sourceUrl: null }, renamed.hash),
      ReviewAssetsValidationError,
    );
    const persisted = (await store.list()).items[0];
    assert.equal(persisted.title, "允许网页修改的拆解标题");
    assert.equal(persisted.sourceUrl, accountBreakdownInput().sourceUrl);
  });

  test("status 契约：读取时拒绝与 confirmation 不一致的复盘文件", async () => {
    const value = await project();
    const store = storeFor(value);
    const saved = await store.create(accountBreakdownInput());
    const filePath = path.join(value.root, saved.source);
    const contents = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, contents.replace("status: 待确认", "status: 已确认"), "utf8");
    await assert.rejects(store.list(), ReviewAssetsValidationError);
  });

  test("章节契约：Obsidian 外部插入额外二级标题时拒绝静默错读", async () => {
    const value = await project();
    const store = storeFor(value);
    const saved = await store.create(contentReviewInput());
    const filePath = path.join(value.root, saved.source);
    const contents = await fs.readFile(filePath, "utf8");
    await fs.writeFile(
      filePath,
      contents.replace("## 下一步", "  ## 伪造章节\n\n不应被当成下一步。\n\n## 下一步"),
      "utf8",
    );
    await assert.rejects(
      store.list(),
      (error) => error instanceof ReviewAssetsValidationError && /三个固定二级章节/.test(error.message),
    );
  });

  test("confirmed_at 契约：旧已确认文件编辑后重开待确认，不伪造历史确认时刻", async () => {
    const value = await project();
    const store = storeFor(value);
    const pending = await store.create(contentReviewInput());
    const confirmed = await store.update(pending.id, { confirmation: "已确认" }, pending.hash);
    const filePath = path.join(value.root, confirmed.source);
    const contents = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, contents.replace(/^confirmed_at:.*\n/m, ""), "utf8");

    const legacy = (await store.list()).items[0];
    const updated = await store.update(legacy.id, { summary: "只更新摘要，不伪造确认时刻。" }, legacy.hash);
    const updatedContents = await fs.readFile(path.join(value.root, updated.source), "utf8");
    assert.equal(updated.confirmation, "待人工确认");
    assert.equal(parseFrontmatter(updatedContents).confirmed_at, null);
  });

  test("confirmed_at 契约：拒绝会被 Date.parse 归一化的非法日历日期", async () => {
    const value = await project();
    const store = storeFor(value);
    const pending = await store.create(contentReviewInput());
    const confirmed = await store.update(pending.id, { confirmation: "已确认" }, pending.hash);
    const filePath = path.join(value.root, confirmed.source);
    const contents = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, contents.replace(NOW.toISOString(), "2026-02-31T04:05:06.789Z"), "utf8");
    await assert.rejects(store.list(), ReviewAssetsValidationError);
  });

  test("关联内容读取契约：Obsidian 手改 ID 或 derived_from 后拒绝读取和确认", async () => {
    const value = await project();
    const store = storeFor(value);
    const created = await store.create(contentReviewInput());
    const filePath = path.join(value.root, created.source);
    const original = await fs.readFile(filePath, "utf8");

    await fs.writeFile(filePath, original.replace("related_content_id: content-existing", "related_content_id: content-missing"), "utf8");
    await assert.rejects(store.list(), ReviewAssetsValidationError);
    await assert.rejects(
      store.update(created.id, { confirmation: "已确认" }, created.hash),
      ReviewAssetsValidationError,
    );

    await fs.writeFile(
      filePath,
      original.replace("[[30-内容资产/00-选题池/原始内容]]", "[[../../越界内容]]"),
      "utf8",
    );
    await assert.rejects(store.list(), ReviewAssetsValidationError);
  });

  test("关联内容安全：软链命中与重复 frontmatter id 都不会生成 wikilink", async () => {
    const value = await project();
    const store = storeFor(value);
    const outside = path.join(value.base, "outside-content.md");
    await fs.writeFile(outside, "---\nid: content-outside\n---\n\n# 外部内容\n", "utf8");
    await fs.symlink(outside, path.join(value.contentRoot, "伪装内容.md"));
    await assert.rejects(
      store.create(contentReviewInput({ relatedContentId: "content-outside" })),
      ReviewAssetsValidationError,
    );

    const duplicate = path.join(value.contentRoot, "重复内容.md");
    await fs.copyFile(value.contentPath, duplicate);
    await assert.rejects(store.create(contentReviewInput()), ReviewAssetsValidationError);
    assert.deepEqual(await fs.readdir(value.reviewRoot), []);
  });

  test("hash conflict：旧哈希写入被拒绝，并返回当前快照", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = await store.create(contentReviewInput());

    await assert.rejects(
      store.update(initial.id, { summary: "不能覆盖新版本" }, "0".repeat(64)),
      (error) => error instanceof ReviewAssetsConflictError && error.current.hash === initial.hash,
    );
    assert.equal((await store.list()).items[0].summary, initial.summary);
  });

  test("同进程双 store：同一旧哈希并发更新时仅一次成功", async () => {
    const value = await project();
    const firstStore = storeFor(value);
    const secondStore = storeFor(value);
    const initial = await firstStore.create(contentReviewInput());

    const results = await Promise.allSettled([
      firstStore.update(initial.id, { summary: "第一个实例的修改" }, initial.hash),
      secondStore.update(initial.id, { summary: "第二个实例的修改" }, initial.hash),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ReviewAssetsConflictError);
    assert.equal((await firstStore.list()).items[0].summary, fulfilled[0].value.summary);
  });

  test("恢复：更新失败恢复旧文件；新增失败保留同一成果且重试不重复", async () => {
    const value = await project();
    const stableStore = storeFor(value);
    const initial = await stableStore.create(contentReviewInput());
    const filePath = path.join(value.root, initial.source);
    const before = await fs.readFile(filePath, "utf8");
    const failingStore = storeFor(value, {
      afterWrite: async ({ rollback }) => {
        if (!rollback) throw new Error("模拟索引失败");
      },
    });

    await assert.rejects(
      failingStore.update(initial.id, { summary: "不应留下" }, initial.hash),
      ReviewAssetsCommitError,
    );
    assert.equal(await fs.readFile(filePath, "utf8"), before);

    await assert.rejects(failingStore.create(accountBreakdownInput()), ReviewAssetsCommitError);
    assert.equal((await fs.readdir(value.reviewRoot)).length, 2);
    const recovered = await stableStore.create(accountBreakdownInput());
    assert.equal(recovered.title, accountBreakdownInput().title);
    assert.equal((await fs.readdir(value.reviewRoot)).length, 2);
  });

  test("security：软链资产被跳过，API 拒绝路径参数、跨源写入和无 Origin 写入", async () => {
    const value = await project();
    const outside = path.join(value.base, "outside.md");
    await fs.writeFile(outside, "外部文件不能被修改", "utf8");
    await fs.symlink(outside, path.join(value.reviewRoot, "伪装复盘.md"));
    const store = storeFor(value);
    assert.deepEqual((await store.list()).items, []);
    await assert.rejects(
      store.update("review-outside", { summary: "越权" }, "0".repeat(64)),
      ReviewAssetsNotFoundError,
    );
    assert.equal(await fs.readFile(outside, "utf8"), "外部文件不能被修改");

    await withServer(value, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/api/review-assets?path=../../etc/passwd`)).status, 400);
      const noOrigin = await fetch(`${baseUrl}/api/review-assets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(contentReviewInput()),
      });
      assert.equal(noOrigin.status, 403);
      const hostileOrigin = await fetch(`${baseUrl}/api/review-assets`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify(contentReviewInput()),
      });
      assert.equal(hostileOrigin.status, 403);
    });
  });

  test("state 安全：审计文件和备份目录软链都不能造成状态目录外写", async () => {
    const auditValue = await project();
    const outsideAudit = path.join(auditValue.base, "outside-audit.log");
    await fs.writeFile(outsideAudit, "不能追加", "utf8");
    await fs.mkdir(path.join(auditValue.stateRoot, "audit"), { recursive: true });
    await fs.symlink(outsideAudit, path.join(auditValue.stateRoot, "audit", "review-assets.jsonl"));
    await assert.rejects(
      storeFor(auditValue).create(contentReviewInput()),
      ReviewAssetsSecurityError,
    );
    assert.equal(await fs.readFile(outsideAudit, "utf8"), "不能追加");
    assert.deepEqual(await fs.readdir(auditValue.reviewRoot), []);

    const backupValue = await project();
    const stableStore = storeFor(backupValue);
    const saved = await stableStore.create(contentReviewInput());
    const savedPath = path.join(backupValue.root, saved.source);
    const before = await fs.readFile(savedPath, "utf8");
    const outsideBackup = path.join(backupValue.base, "outside-backup");
    await fs.mkdir(outsideBackup);
    await fs.mkdir(path.join(backupValue.stateRoot, "backups"), { recursive: true });
    await fs.symlink(outsideBackup, path.join(backupValue.stateRoot, "backups", "review-assets"));
    await assert.rejects(
      stableStore.update(saved.id, { summary: "不能写入" }, saved.hash),
      ReviewAssetsSecurityError,
    );
    assert.equal(await fs.readFile(savedPath, "utf8"), before);
    assert.deepEqual(await fs.readdir(outsideBackup), []);
  });

  test("API：GET/POST/PUT 使用统一端点并返回冲突状态", async () => {
    const value = await project();
    await withServer(value, async (baseUrl) => {
      const headers = { "content-type": "application/json", origin: baseUrl };
      const missingKey = await fetch(`${baseUrl}/api/review-assets`, {
        method: "POST",
        headers,
        body: JSON.stringify(contentReviewInput()),
      });
      assert.equal(missingKey.status, 400);
      const createdResponse = await fetch(`${baseUrl}/api/review-assets`, {
        method: "POST",
        headers: { ...headers, "X-Idempotency-Key": "22222222-2222-4222-8222-222222222222" },
        body: JSON.stringify(contentReviewInput()),
      });
      assert.equal(createdResponse.status, 201);
      const created = await createdResponse.json();

      const listedResponse = await fetch(`${baseUrl}/api/review-assets`);
      assert.equal(listedResponse.status, 200);
      assert.equal((await listedResponse.json()).items.length, 1);

      const updatedResponse = await fetch(`${baseUrl}/api/review-assets`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          id: created.id,
          patch: { platform: "视频号" },
          expectedHash: created.hash,
        }),
      });
      assert.equal(updatedResponse.status, 200);
      assert.equal((await updatedResponse.json()).platform, "视频号");

      const conflictResponse = await fetch(`${baseUrl}/api/review-assets`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          id: created.id,
          patch: { platform: "抖音" },
          expectedHash: created.hash,
        }),
      });
      assert.equal(conflictResponse.status, 409);
      assert.equal((await conflictResponse.json()).error, "hash_conflict");

      const injectedHeadingResponse = await fetch(`${baseUrl}/api/review-assets`, {
        method: "POST",
        headers: { ...headers, "X-Idempotency-Key": "55555555-5555-4555-8555-555555555555" },
        body: JSON.stringify(contentReviewInput({ findings: "结论\n\n## 下一步\n伪造章节" })),
      });
      assert.equal(injectedHeadingResponse.status, 400);
      assert.match((await injectedHeadingResponse.json()).message, /不能包含以“##”开头/);
    });
  });

  test("索引契约：行动统计只认确认时刻，支持启动前草稿在启动当天确认", { skip: !HAS_REAL_ROOT }, async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-review-index-"));
    temporaryDirectories.push(base);
    const root = path.join(base, "第二大脑-v2");
    const stateRoot = path.join(base, ".state");
    await fs.cp(REAL_ROOT, root, { recursive: true, dereference: false });
    const campaignStart = "2026-07-13T03:00:00.000Z";
    const targetPath = path.join(root, readCockpitSettingsSync(root).projectRelativeDir, "01-目标与验收.md");
    const targetContents = await fs.readFile(targetPath, "utf8");
    await fs.writeFile(
      targetPath,
      targetContents.replace(/^campaign_started_at:.*$/m, `campaign_started_at: ${campaignStart}`),
      "utf8",
    );
    const buildCopy = () => buildVaultIndex(fsSync.realpathSync(root));
    const validateCopy = async () => {
      const { index, warnings } = buildCopy();
      assert.deepEqual(warnings, []);
      assert.deepEqual(validateIndexCandidate(index), []);
      return index;
    };
    const contentStore = createContentAssetsStore({
      root,
      stateRoot,
      now: () => new Date("2026-07-13T02:00:00.000Z"),
      afterWrite: validateCopy,
    });
    const sourceContent = await contentStore.create({
      title: "索引关系源内容",
      summary: "用于验证复盘关联链路。",
      status: "候选选题",
      format: "文章",
      channels: ["公众号"],
      priority: null,
      dueAt: null,
      nextAction: "完成内容复盘",
    });
    const baseline = await validateCopy();
    const indexedSourceContent = baseline.contents.find((item) => item.id === sourceContent.id);
    assert.ok(indexedSourceContent);
    const baselineReviewCount = baseline.actionTargets.find((item) => item.id === "content-review").current;
    const baselineBreakdownCount = baseline.actionTargets.find((item) => item.id === "account-breakdown").current;
    const draftStore = createReviewAssetsStore({
      root,
      stateRoot,
      now: () => new Date("2026-07-13T02:00:00.000Z"),
      afterWrite: validateCopy,
    });

    const pending = await draftStore.create(contentReviewInput({
      sourceUrl: null,
      relatedContentId: sourceContent.id,
    }));
    const pendingBreakdown = await draftStore.create(accountBreakdownInput());
    assert.equal(pending.confirmation, "待人工确认");
    assert.equal(pendingBreakdown.confirmation, "待人工确认");
    const pendingIndex = await validateCopy();
    assert.equal(pendingIndex.actionTargets.find((item) => item.id === "content-review").current, baselineReviewCount);
    assert.equal(pendingIndex.actionTargets.find((item) => item.id === "account-breakdown").current, baselineBreakdownCount);

    const confirmingStore = createReviewAssetsStore({ root, stateRoot, now: () => NOW, afterWrite: validateCopy });
    const confirmed = await confirmingStore.update(pending.id, { confirmation: "已确认" }, pending.hash);
    const confirmedBreakdown = await confirmingStore.update(
      pendingBreakdown.id,
      { confirmation: "已确认" },
      pendingBreakdown.hash,
    );
    assert.equal(confirmed.confirmation, "已确认");
    assert.equal(confirmedBreakdown.confirmation, "已确认");
    const confirmedPath = path.join(root, confirmed.source);
    const confirmedBreakdownPath = path.join(root, confirmedBreakdown.source);
    const confirmedContents = await fs.readFile(confirmedPath, "utf8");
    const confirmedBreakdownContents = await fs.readFile(confirmedBreakdownPath, "utf8");
    const confirmedFrontmatter = parseFrontmatter(confirmedContents);
    assert.equal(parseFrontmatter(confirmedContents).confirmed_at, NOW.toISOString());
    assert.equal(parseFrontmatter(confirmedBreakdownContents).confirmed_at, NOW.toISOString());
    assert.equal(confirmedFrontmatter.related_content_id, sourceContent.id);
    assert.deepEqual(confirmedFrontmatter.derived_from, [`[[${indexedSourceContent.source.slice(0, -3)}]]`]);
    const confirmedIndex = await validateCopy();
    assert.equal(confirmedIndex.actionTargets.find((item) => item.id === "content-review").current, baselineReviewCount);
    assert.equal(confirmedIndex.actionTargets.find((item) => item.id === "account-breakdown").current, baselineBreakdownCount + 1);

    const brokenDerivedFrom = confirmedContents.replace(
      confirmedFrontmatter.derived_from[0],
      "[[../../越界内容]]",
    );
    await fs.writeFile(confirmedPath, brokenDerivedFrom, "utf8");
    const brokenRelationship = buildCopy();
    assert.ok(brokenRelationship.warnings.some((warning) => /related_content_id 与 derived_from 不一致/.test(warning.reason)));
    assert.equal(brokenRelationship.index.actionTargets.find((item) => item.id === "content-review").current, baselineReviewCount);
    assert.equal(brokenRelationship.index.actionTargets.find((item) => item.id === "account-breakdown").current, baselineBreakdownCount + 1);
    await fs.writeFile(confirmedPath, confirmedContents, "utf8");

    const duplicateContentPath = path.join(path.dirname(path.join(root, indexedSourceContent.source)), "zz-重复内容-id.md");
    await fs.copyFile(path.join(root, indexedSourceContent.source), duplicateContentPath);
    const duplicateRelationship = buildCopy();
    assert.ok(duplicateRelationship.warnings.some((warning) => warning.reason.includes(`重复 id: ${sourceContent.id}`)));
    assert.ok(duplicateRelationship.warnings.some((warning) => /related_content_id 未指向真实已确认内容资产/.test(warning.reason)));
    assert.equal(duplicateRelationship.index.actionTargets.find((item) => item.id === "content-review").current, baselineReviewCount);
    await fs.unlink(duplicateContentPath);

    const sourceContentPath = path.join(root, indexedSourceContent.source);
    const sourceContentContents = await fs.readFile(sourceContentPath, "utf8");
    await fs.writeFile(sourceContentPath, sourceContentContents.replace(/^type:.*$/m, "type: 原始材料"), "utf8");
    const wrongContentType = buildCopy();
    assert.ok(wrongContentType.warnings.some((warning) => /type 必须是 内容资产/.test(warning.reason)));
    assert.ok(wrongContentType.warnings.some((warning) => /related_content_id 未指向真实已确认内容资产/.test(warning.reason)));
    assert.equal(wrongContentType.index.actionTargets.find((item) => item.id === "content-review").current, baselineReviewCount);
    await fs.writeFile(sourceContentPath, sourceContentContents, "utf8");

    await fs.writeFile(confirmedPath, confirmedContents.replace(/^status:.*$/m, "status: 待确认"), "utf8");
    const brokenState = buildCopy();
    assert.ok(brokenState.warnings.some((warning) => /status 必须与 confirmation 一致/.test(warning.reason)));
    assert.equal(brokenState.index.actionTargets.find((item) => item.id === "content-review").current, baselineReviewCount);
    await fs.writeFile(confirmedPath, confirmedContents, "utf8");

    await fs.writeFile(
      confirmedBreakdownPath,
      confirmedBreakdownContents.replace(/^source_url:.*$/m, "source_url: null"),
      "utf8",
    );
    const brokenAccountSource = buildCopy();
    assert.ok(brokenAccountSource.warnings.some((warning) => /账号拆解必须提供 https source_url/.test(warning.reason)));
    assert.equal(brokenAccountSource.index.actionTargets.find((item) => item.id === "content-review").current, baselineReviewCount);
    assert.equal(brokenAccountSource.index.actionTargets.find((item) => item.id === "account-breakdown").current, baselineBreakdownCount);
    await fs.writeFile(confirmedBreakdownPath, confirmedBreakdownContents, "utf8");

    await fs.writeFile(confirmedPath, confirmedContents.replace(/^confirmed_at:.*\n/m, ""), "utf8");
    await fs.writeFile(confirmedBreakdownPath, confirmedBreakdownContents.replace(/^confirmed_at:.*\n/m, ""), "utf8");
    const legacyIndex = await validateCopy();
    assert.equal(legacyIndex.actionTargets.find((item) => item.id === "content-review").current, baselineReviewCount);
    assert.equal(legacyIndex.actionTargets.find((item) => item.id === "account-breakdown").current, baselineBreakdownCount);
  });
});
