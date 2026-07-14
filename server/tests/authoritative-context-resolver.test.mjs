import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AuthoritativeContextConflictError,
  AuthoritativeContextNotFoundError,
  AuthoritativeContextSecurityError,
  AuthoritativeContextTypeMismatchError,
  AuthoritativeContextValidationError,
  createAuthoritativeAiContextResolver,
} from "../ai-collaboration/authoritative-context-resolver.mjs";
import { createAiRunWorkspaceStore } from "../ai-collaboration/run-workspace-store.mjs";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function contentMarkdown({
  id,
  title,
  status = "候选选题",
  sensitivity = "内部",
  summary = "这是正文中的可信摘要。",
}) {
  return `---
id: ${id}
type: 内容资产
status: ${status}
created_at: 2026-07-14
updated_at: 2026-07-14
source: 测试
topics:
  - AI应用
sensitivity: ${sensitivity}
origin_owner: 测试用户
processed_by: 人机协作
confirmation: 已确认
derived_from: []
related_assets: []
family_id: ${id}
parent_id: null
format: 文章
channels:
  - 公众号
completed_at: null
published_records: []
metric_refs: []
next_action: 完成下一步验证
due_at: null
priority: P1
---

# ${title}

${summary}
`;
}

function reviewMarkdown({
  id,
  title,
  kind,
  relatedContentId = null,
  sensitivity = "内部",
  relatedWikilink = null,
}) {
  const topic = kind === "content-review" ? "内容复盘" : "账号拆解";
  const platform = kind === "content-review" ? "公众号" : "小红书";
  const related = relatedContentId === null ? "null" : relatedContentId;
  const derivedFrom = relatedWikilink === null
    ? "derived_from: []"
    : `derived_from:\n  - '${relatedWikilink}'`;
  return `---
id: ${id}
type: 复盘
review_kind: ${kind}
status: 待确认
created_at: 2026-07-14
updated_at: 2026-07-14
source: 驾驶舱新增
topics:
  - ${topic}
sensitivity: ${sensitivity}
origin_owner: 测试用户
processed_by: 人机协作
confirmation: 待人工确认
confirmed_at: null
source_url: https://example.com/${id}
platform: ${platform}
related_content_id: ${related}
${derivedFrom}
related_assets: []
---

# ${title}

## 摘要

这是复盘的权威摘要。

## 核心发现

封面承诺明确，标题给出了具体收益。

## 下一步

用同一变量做一次最小测试。
`;
}

function dailyReviewMarkdown(date = "2026-07-14") {
  return `---
id: daily-review-${date}
type: 经营看板
dashboard_kind: daily-review
status: 待确认
date: ${date}
created_at: 2026-07-14T10:00:00.000Z
updated_at: 2026-07-14T10:00:00.000Z
source: 驾驶舱新增
topics:
  - 每日复盘
  - 内容经营
sensitivity: 内部
origin_owner: 测试用户
processed_by: 人机协作
confirmation: 待人工确认
confirmed_at: null
---

# ${date} 每日复盘

## 今日完成

完成一篇文章。

## 数据与事实

发布 1 篇文章。

## 有效动作

先写标题再展开正文。

## 问题

视频没有按计划发布。

## 今日判断

先完成固定发布节奏，再增加新栏目。

## 明日最重要动作

上午完成一条短视频。
`;
}

function sourceManifest(relativePath, contents, classification, included = true) {
  return {
    path: relativePath,
    sha256: sha256(contents),
    bytes: Buffer.byteLength(contents),
    classification,
    included,
    reason: included ? "confirmation:已确认" : "confirmation:待人工确认",
  };
}

async function writeMarkdown(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
  return target;
}

async function createFixture() {
  const realTemporaryRoot = await fs.realpath(os.tmpdir());
  const base = await fs.mkdtemp(path.join(realTemporaryRoot, "creator-context-resolver-"));
  const root = path.join(base, "vault");
  const stateRoot = path.join(base, "state");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });

  const topic = {
    id: "content-topic-one",
    title: "一个真实选题",
    summary: "索引生成的选题摘要。",
    status: "候选选题",
    relativePath: "30-内容资产/00-选题池/真实选题.md",
  };
  topic.contents = contentMarkdown(topic);
  topic.filePath = await writeMarkdown(root, topic.relativePath, topic.contents);

  const published = {
    id: "content-published-one",
    title: "一篇待发布内容",
    summary: "索引生成的内容摘要。",
    status: "待发布",
    relativePath: "30-内容资产/01-文章/待发布内容.md",
  };
  published.contents = contentMarkdown(published);
  published.filePath = await writeMarkdown(root, published.relativePath, published.contents);

  const contentReview = {
    id: "review-content-one",
    title: "一篇内容复盘",
    kind: "content-review",
    relativePath: "20-知识资产/03-复盘/内容复盘.md",
  };
  contentReview.contents = reviewMarkdown({
    ...contentReview,
    relatedContentId: topic.id,
    relatedWikilink: "[[30-内容资产/00-选题池/真实选题]]",
  });
  contentReview.filePath = await writeMarkdown(root, contentReview.relativePath, contentReview.contents);

  const accountBreakdown = {
    id: "review-account-one",
    title: "一个账号拆解",
    kind: "account-breakdown",
    relativePath: "20-知识资产/03-复盘/账号拆解.md",
  };
  accountBreakdown.contents = reviewMarkdown(accountBreakdown);
  accountBreakdown.filePath = await writeMarkdown(root, accountBreakdown.relativePath, accountBreakdown.contents);

  const daily = {
    id: "daily-review-2026-07-14",
    relativePath: "60-数据与看板/05-经营看板/每日复盘/2026-07-14-每日复盘.md",
  };
  daily.contents = dailyReviewMarkdown();
  daily.filePath = await writeMarkdown(root, daily.relativePath, daily.contents);

  const index = {
    schemaVersion: "1.0.0",
    generatedAt: "2026-07-14T10:00:00.000Z",
    contents: [topic, published].map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      status: item.status,
      source: item.relativePath,
    })),
    knowledge: [],
    reviewItems: [contentReview, accountBreakdown].map((item) => ({
      id: item.id,
      title: item.title,
      summary: "索引中的复盘摘要。",
      type: "复盘",
      reason: "待人工确认",
      source: item.relativePath,
    })),
    sourceFiles: [
      sourceManifest(topic.relativePath, topic.contents, "content-asset"),
      sourceManifest(published.relativePath, published.contents, "content-asset"),
      sourceManifest(contentReview.relativePath, contentReview.contents, "knowledge-asset", false),
      sourceManifest(accountBreakdown.relativePath, accountBreakdown.contents, "knowledge-asset", false),
      sourceManifest(daily.relativePath, daily.contents, "daily-review", false),
    ],
  };
  const indexPath = path.join(stateRoot, "index.json");
  await fs.writeFile(indexPath, JSON.stringify(index), "utf8");
  const resolver = createAuthoritativeAiContextResolver({ root, stateRoot, indexPath });
  return {
    base,
    root,
    stateRoot,
    indexPath,
    index,
    resolver,
    topic,
    published,
    contentReview,
    accountBreakdown,
    daily,
    async cleanup() { await fs.rm(base, { recursive: true, force: true }); },
  };
}

test("只接受浏览器提供的 type 与 opaque id", async () => {
  const value = await createFixture();
  try {
    await assert.rejects(
      () => value.resolver.resolve({
        type: "topic",
        id: value.topic.id,
        title: "浏览器伪造标题",
      }),
      AuthoritativeContextValidationError,
    );
    await assert.rejects(
      () => value.resolver.resolve({ type: "topic", id: "../../etc/passwd" }),
      AuthoritativeContextValidationError,
    );
  } finally {
    await value.cleanup();
  }
});

test("topic 与 content 均从权威索引恢复标题、摘要、哈希和真实 Markdown", async () => {
  const value = await createFixture();
  try {
    const topic = await value.resolver.resolve({ type: "topic", id: value.topic.id });
    assert.deepEqual(topic.context, {
      type: "topic",
      id: value.topic.id,
      title: value.topic.title,
      summary: value.topic.summary,
    });
    assert.equal(topic.currentHash, sha256(value.topic.contents));
    assert.deepEqual(topic.sourceRefs, [{
      ref: `canonical:topic:${value.topic.id}:${sha256(value.topic.contents)}`,
      sourcePath: value.topic.filePath,
      inputName: "topic-source.md",
      expectedSha256: sha256(value.topic.contents),
    }]);

    const content = await value.resolver.resolve({ type: "content", id: value.published.id });
    assert.equal(content.context.title, value.published.title);
    assert.equal(content.context.summary, value.published.summary);
    assert.equal(content.sourceRefs[0].sourcePath, value.published.filePath);
    assert.equal(content.sourceRefs[0].inputName, "content-source.md");
  } finally {
    await value.cleanup();
  }
});

test("解析结果可以直接交给 workspace store，并复制经过哈希验证的真实 Markdown", async () => {
  const value = await createFixture();
  try {
    const resolved = await value.resolver.resolve({ type: "topic", id: value.topic.id });
    const workspaceStateRoot = path.join(value.base, "workspace-state");
    await fs.mkdir(workspaceStateRoot, { mode: 0o700 });
    const workspaceStore = createAiRunWorkspaceStore({
      stateRoot: workspaceStateRoot,
      idFactory: () => "run-11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-07-14T11:00:00.000Z"),
    });
    const run = await workspaceStore.create({
      provider: "codex",
      permissionMode: "readonly",
      templateId: "analyze-topic",
      context: resolved.context,
      instruction: "只判断证据边界。",
      sourceRefs: resolved.sourceRefs,
    });
    const copied = await fs.readFile(path.join(run.cwd, "inputs", "topic-source.md"), "utf8");
    assert.equal(copied, value.topic.contents);
    assert.equal(run.sourceRefs.find((item) => item.inputName === "topic-source.md")?.sha256, resolved.currentHash);
  } finally {
    await value.cleanup();
  }
});

test("内容复盘附带复盘原文和关联内容原文，账号拆解只附带自身原文", async () => {
  const value = await createFixture();
  try {
    const contentReview = await value.resolver.resolve({
      type: "content-review",
      id: value.contentReview.id,
    });
    assert.deepEqual(contentReview.context, {
      type: "content-review",
      id: value.contentReview.id,
      title: value.contentReview.title,
      summary: "这是复盘的权威摘要。",
    });
    assert.deepEqual(
      contentReview.sourceRefs.map((item) => [item.inputName, item.sourcePath]),
      [
        ["review-source.md", value.contentReview.filePath],
        ["related-content.md", value.topic.filePath],
      ],
    );

    const account = await value.resolver.resolve({
      type: "account-breakdown",
      id: value.accountBreakdown.id,
    });
    assert.equal(account.context.title, value.accountBreakdown.title);
    assert.equal(account.sourceRefs.length, 1);
    assert.equal(account.sourceRefs[0].sourcePath, value.accountBreakdown.filePath);
  } finally {
    await value.cleanup();
  }
});

test("每日复盘从 V2 固定目录恢复摘要与真实 Markdown", async () => {
  const value = await createFixture();
  try {
    const daily = await value.resolver.resolve({ type: "daily-review", id: value.daily.id });
    assert.deepEqual(daily.context, {
      type: "daily-review",
      id: value.daily.id,
      title: "2026-07-14 每日复盘",
      summary: "先完成固定发布节奏，再增加新栏目。",
    });
    assert.equal(daily.currentHash, sha256(value.daily.contents));
    assert.equal(daily.sourceRefs[0].sourcePath, value.daily.filePath);
    assert.equal(daily.sourceRefs[0].inputName, "daily-review-source.md");
  } finally {
    await value.cleanup();
  }
});

test("类型不符时拒绝选题阶段冒充与复盘 kind 冒充", async () => {
  const value = await createFixture();
  try {
    await assert.rejects(
      () => value.resolver.resolve({ type: "topic", id: value.published.id }),
      AuthoritativeContextTypeMismatchError,
    );
    await assert.rejects(
      () => value.resolver.resolve({ type: "account-breakdown", id: value.contentReview.id }),
      AuthoritativeContextTypeMismatchError,
    );
  } finally {
    await value.cleanup();
  }
});

test("缺失与重复 id 都不会降级为浏览器传入内容", async () => {
  const value = await createFixture();
  try {
    await assert.rejects(
      () => value.resolver.resolve({ type: "content", id: "content-missing" }),
      AuthoritativeContextNotFoundError,
    );
    value.index.contents.push({ ...value.index.contents[0] });
    await fs.writeFile(value.indexPath, JSON.stringify(value.index), "utf8");
    await assert.rejects(
      () => value.resolver.resolve({ type: "content", id: value.topic.id }),
      AuthoritativeContextValidationError,
    );
  } finally {
    await value.cleanup();
  }
});

test("V2 文件在索引后变化时拒绝陈旧哈希", async () => {
  const value = await createFixture();
  try {
    await fs.appendFile(value.topic.filePath, "\n索引后新增内容。\n", "utf8");
    await assert.rejects(
      () => value.resolver.resolve({ type: "content", id: value.topic.id }),
      AuthoritativeContextConflictError,
    );
  } finally {
    await value.cleanup();
  }
});

test("路径越界、白名单外路径和软链接都会被拒绝", async () => {
  const value = await createFixture();
  try {
    value.index.contents[0].source = "../outside.md";
    await fs.writeFile(value.indexPath, JSON.stringify(value.index), "utf8");
    await assert.rejects(
      () => value.resolver.resolve({ type: "content", id: value.topic.id }),
      AuthoritativeContextSecurityError,
    );

    value.index.contents[0].source = value.topic.relativePath;
    const outside = path.join(value.base, "outside.md");
    await fs.writeFile(outside, value.topic.contents, "utf8");
    await fs.rm(value.topic.filePath);
    await fs.symlink(outside, value.topic.filePath);
    await fs.writeFile(value.indexPath, JSON.stringify(value.index), "utf8");
    await assert.rejects(
      () => value.resolver.resolve({ type: "content", id: value.topic.id }),
      AuthoritativeContextSecurityError,
    );
  } finally {
    await value.cleanup();
  }
});

test("敏感资产即使被伪造进索引也不会进入 AI 工作区", async () => {
  const value = await createFixture();
  try {
    const sensitive = contentMarkdown({
      id: "content-sensitive-one",
      title: "敏感内容",
      sensitivity: "敏感",
    });
    const relativePath = "30-内容资产/00-选题池/敏感内容.md";
    await writeMarkdown(value.root, relativePath, sensitive);
    value.index.contents.push({
      id: "content-sensitive-one",
      title: "敏感内容",
      summary: "不能使用",
      status: "候选选题",
      source: relativePath,
    });
    value.index.sourceFiles.push(sourceManifest(relativePath, sensitive, "content-asset"));
    await fs.writeFile(value.indexPath, JSON.stringify(value.index), "utf8");
    await assert.rejects(
      () => value.resolver.resolve({ type: "content", id: "content-sensitive-one" }),
      AuthoritativeContextNotFoundError,
    );
  } finally {
    await value.cleanup();
  }
});

test("权威原文含常见云端密钥时不会复制或发送给 AI", async () => {
  const value = await createFixture();
  try {
    const compromised = `${value.topic.contents}\nAPI key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456\n`;
    await fs.writeFile(value.topic.filePath, compromised, "utf8");
    const manifest = value.index.sourceFiles.find((item) => item.path === value.topic.relativePath);
    manifest.sha256 = sha256(compromised);
    manifest.bytes = Buffer.byteLength(compromised);
    await fs.writeFile(value.indexPath, JSON.stringify(value.index), "utf8");
    await assert.rejects(
      () => value.resolver.resolve({ type: "topic", id: value.topic.id }),
      (error) => {
        assert.ok(error instanceof AuthoritativeContextSecurityError);
        assert.match(error.message, /疑似凭证/);
        return true;
      },
    );
  } finally {
    await value.cleanup();
  }
});

test("权威索引本身不能位于状态目录外或通过软链接读取", async () => {
  const value = await createFixture();
  try {
    assert.throws(
      () => createAuthoritativeAiContextResolver({
        root: value.root,
        stateRoot: value.stateRoot,
        indexPath: path.join(value.base, "outside-index.json"),
      }),
      AuthoritativeContextSecurityError,
    );
    const realIndex = path.join(value.stateRoot, "real-index.json");
    const linkedIndex = path.join(value.stateRoot, "linked-index.json");
    await fs.rename(value.indexPath, realIndex);
    await fs.symlink(realIndex, linkedIndex);
    const resolver = createAuthoritativeAiContextResolver({
      root: value.root,
      stateRoot: value.stateRoot,
      indexPath: linkedIndex,
    });
    await assert.rejects(
      () => resolver.resolve({ type: "topic", id: value.topic.id }),
      AuthoritativeContextSecurityError,
    );
  } finally {
    await value.cleanup();
  }
});
