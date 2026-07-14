import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  CONTENT_ASSETS_RELATIVE_DIR,
  CONTENT_INBOX_RELATIVE_DIR,
  createContentAssetsStore,
} from "../content-assets-store.mjs";
import {
  REVIEW_ASSETS_RELATIVE_DIR,
  createReviewAssetsStore,
} from "../review-assets-store.mjs";

const NOW = new Date("2026-07-13T06:30:00.000Z");
const TITLE = "我花了 2 亿 Token，做了一个内容工作台";
const ACCOUNT_SOURCE_URL = "https://www.bilibili.com/video/BV1MZ5x68EoW";
const temporaryDirectories = [];

async function project() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-content-flow-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "第二大脑-v2");
  const stateRoot = path.join(base, ".media-growth-cockpit");
  const contentRoot = path.join(root, CONTENT_ASSETS_RELATIVE_DIR);
  const inboxRoot = path.join(root, CONTENT_INBOX_RELATIVE_DIR);
  const reviewRoot = path.join(root, REVIEW_ASSETS_RELATIVE_DIR);
  await Promise.all([
    fs.mkdir(inboxRoot, { recursive: true }),
    fs.mkdir(reviewRoot, { recursive: true }),
  ]);
  return { base, root, stateRoot, contentRoot, inboxRoot, reviewRoot };
}

function markdownParts(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(match, "expected YAML frontmatter and Markdown body");
  return { frontmatter: parseYaml(match[1]), body: match[2] };
}

function assertNoAbsolutePathLeak(value, projectRoot) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(projectRoot.base), false);
  assert.equal(serialized.includes(projectRoot.root), false);
  assert.equal(serialized.includes(projectRoot.stateRoot), false);
  assert.equal("filePath" in value, false);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("内容生产到复盘的跨功能状态流", () => {
  test("候选、内容复盘、归档恢复和账号拆解共享同一临时 Vault 且不伪造发布事实", async () => {
    const value = await project();
    const options = {
      root: value.root,
      stateRoot: value.stateRoot,
      now: () => NOW,
      afterWrite: async () => {},
    };
    const contentStore = createContentAssetsStore(options);
    const reviewStore = createReviewAssetsStore(options);

    const candidate = await contentStore.create({
      title: TITLE,
      summary: "记录内容工作台从个人工具走向可复用产品的真实过程。",
      status: "候选选题",
      format: "文章",
      channels: ["公众号", "B 站"],
      priority: "P0",
      dueAt: "2026-07-20",
      nextAction: "完成选题判断",
    });
    const established = await contentStore.update(candidate.id, {
      status: "已立项",
      nextAction: "整理两亿 Token 的关键过程",
    }, candidate.hash);
    const pendingPublication = await contentStore.update(established.id, {
      status: "待发布",
      nextAction: "完成发布前检查",
    }, established.hash);

    assert.deepEqual(
      [candidate.status, established.status, pendingPublication.status],
      ["候选选题", "已立项", "待发布"],
    );
    assert.equal([candidate, established, pendingPublication].some((item) => item.status === "已发布"), false);

    const contentFiles = await fs.readdir(value.inboxRoot);
    assert.equal(contentFiles.length, 1);
    const contentPath = path.join(value.inboxRoot, contentFiles[0]);
    const contentRelativePath = path.relative(value.root, contentPath);
    const contentStem = contentRelativePath
      .slice(0, -path.extname(contentRelativePath).length)
      .split(path.sep)
      .join("/");
    assert.ok(contentRelativePath.startsWith(`${CONTENT_INBOX_RELATIVE_DIR}${path.sep}`));
    const beforeReview = markdownParts(await fs.readFile(contentPath, "utf8"));
    assert.equal(beforeReview.frontmatter.id, candidate.id);
    assert.equal(beforeReview.frontmatter.status, "待发布");
    assert.deepEqual(beforeReview.frontmatter.published_records, []);
    assert.ok(beforeReview.body.includes(`# ${TITLE}`));

    const pendingReview = await reviewStore.create({
      kind: "content-review",
      title: `${TITLE}：内容复盘`,
      sourceUrl: null,
      platform: "公众号",
      relatedContentId: candidate.id,
      summary: "先验证内容结构，再决定是否扩大分发。",
      findings: "",
      nextAction: "",
    });
    assert.equal(pendingReview.confirmation, "待人工确认");
    assert.equal(pendingReview.relatedContentId, candidate.id);
    const pendingReviewMarkdown = markdownParts(await fs.readFile(path.join(value.root, pendingReview.source), "utf8"));
    assert.equal(pendingReviewMarkdown.frontmatter.status, "待确认");
    assert.equal(pendingReviewMarkdown.frontmatter.confirmation, "待人工确认");
    assert.deepEqual(pendingReviewMarkdown.frontmatter.derived_from, [`[[${contentStem}]]`]);

    const confirmedReview = await reviewStore.update(pendingReview.id, {
      findings: "测试发现：真实投入和具体产物比抽象方法更容易建立可信度。",
      nextAction: "补齐关键截图后再安排正式发布。",
      confirmation: "已确认",
    }, pendingReview.hash);
    assert.equal(confirmedReview.confirmation, "已确认");

    const archived = await contentStore.update(pendingPublication.id, { status: "已归档" }, pendingPublication.hash);
    assert.equal(archived.status, "已归档");
    assert.deepEqual(await fs.readdir(value.inboxRoot), contentFiles);
    assert.equal((await fs.stat(contentPath)).isFile(), true);

    const restored = await contentStore.update(archived.id, { status: "候选选题" }, archived.hash);
    assert.equal(restored.status, "候选选题");
    assert.deepEqual(await fs.readdir(value.inboxRoot), contentFiles);
    const restoredContent = markdownParts(await fs.readFile(contentPath, "utf8"));
    assert.equal(restoredContent.frontmatter.status, "候选选题");
    assert.deepEqual(restoredContent.frontmatter.published_records, []);
    assert.ok(restoredContent.body.includes("记录内容工作台从个人工具走向可复用产品的真实过程。"));

    const accountBreakdown = await reviewStore.create({
      kind: "account-breakdown",
      title: "B 站内容工作台案例拆解",
      sourceUrl: ACCOUNT_SOURCE_URL,
      platform: "B 站",
      relatedContentId: null,
      summary: "记录该视频的内容组织方式。",
      findings: "测试发现：标题同时包含投入量和具体产物。",
      nextAction: "",
    });
    assert.equal(accountBreakdown.confirmation, "待人工确认");
    assert.equal(accountBreakdown.sourceUrl, ACCOUNT_SOURCE_URL);

    const contentReviewPath = path.join(value.root, confirmedReview.source);
    const accountBreakdownPath = path.join(value.root, accountBreakdown.source);
    for (const reviewPath of [contentReviewPath, accountBreakdownPath]) {
      assert.equal(path.relative(value.reviewRoot, reviewPath).startsWith(".."), false);
      assert.equal((await fs.stat(reviewPath)).isFile(), true);
    }
    const reviewFiles = await fs.readdir(value.reviewRoot);
    assert.equal(reviewFiles.length, 2);

    const contentReviewMarkdown = markdownParts(await fs.readFile(contentReviewPath, "utf8"));
    assert.equal(contentReviewMarkdown.frontmatter.type, "复盘");
    assert.equal(contentReviewMarkdown.frontmatter.review_kind, "content-review");
    assert.equal(contentReviewMarkdown.frontmatter.related_content_id, candidate.id);
    assert.deepEqual(contentReviewMarkdown.frontmatter.derived_from, [`[[${contentStem}]]`]);
    assert.equal(contentReviewMarkdown.frontmatter.status, "已确认");
    assert.equal(contentReviewMarkdown.frontmatter.confirmation, "已确认");
    assert.ok(contentReviewMarkdown.body.includes("## 核心发现\n\n测试发现：真实投入和具体产物比抽象方法更容易建立可信度。"));
    assert.ok(contentReviewMarkdown.body.includes("## 下一步\n\n补齐关键截图后再安排正式发布。"));

    const accountMarkdown = markdownParts(await fs.readFile(accountBreakdownPath, "utf8"));
    assert.equal(accountMarkdown.frontmatter.type, "复盘");
    assert.equal(accountMarkdown.frontmatter.review_kind, "account-breakdown");
    assert.equal(accountMarkdown.frontmatter.source_url, ACCOUNT_SOURCE_URL);
    assert.equal(accountMarkdown.frontmatter.related_content_id, null);
    assert.equal(accountMarkdown.frontmatter.status, "待确认");
    assert.equal(accountMarkdown.frontmatter.confirmation, "待人工确认");
    assert.ok(accountMarkdown.body.includes("## 核心发现\n\n测试发现：标题同时包含投入量和具体产物。"));

    const contentList = await contentStore.list();
    const reviewList = await reviewStore.list();
    assert.equal(contentList.items.length, 1);
    assert.equal(reviewList.items.length, 2);
    for (const snapshot of [
      candidate,
      established,
      pendingPublication,
      archived,
      restored,
      pendingReview,
      confirmedReview,
      accountBreakdown,
      ...contentList.items,
      ...reviewList.items,
    ]) {
      assertNoAbsolutePathLeak(snapshot, value);
      if ("source" in snapshot) assert.equal(path.isAbsolute(snapshot.source), false);
    }

    const contentAudit = await fs.readFile(path.join(value.stateRoot, "audit", "content-assets.jsonl"), "utf8");
    const reviewAudit = await fs.readFile(path.join(value.stateRoot, "audit", "review-assets.jsonl"), "utf8");
    assert.equal(contentAudit.includes(value.base), false);
    assert.equal(reviewAudit.includes(value.base), false);
  });
});
