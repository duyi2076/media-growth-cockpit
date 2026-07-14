import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { parse as parseYaml } from "yaml";
import { createContentAssetsMiddleware } from "../content-assets-api.mjs";
import {
  CONTENT_ASSETS_RELATIVE_DIR,
  CONTENT_INBOX_RELATIVE_DIR,
  ContentAssetsCommitError,
  ContentAssetsConflictError,
  ContentAssetsNotFoundError,
  ContentAssetsSecurityError,
  ContentAssetsValidationError,
  createContentAssetsStore,
} from "../content-assets-store.mjs";

const NOW = new Date("2026-07-12T04:05:06.789Z");
const temporaryDirectories = [];

function markdown(overrides = {}, body = "# 原始标题\n\n正文第一段。\n\n## 证据\n\n正文必须原样保留。\n") {
  const fields = {
    id: "content-existing",
    type: "短视频口播",
    status: "待发布",
    created_at: "2026-07-10",
    updated_at: "2026-07-10",
    source: "[[原始证据]]",
    topics: ["AI应用"],
    sensitivity: "公开",
    origin_owner: "使用者",
    processed_by: "使用者",
    confirmation: "已确认",
    derived_from: ["[[原始证据]]"],
    related_assets: [],
    family_id: "family-existing",
    parent_id: null,
    format: "短视频",
    channels: ["抖音"],
    published_records: [],
    metric_refs: [],
    next_action: "继续写稿",
    due_at: null,
    priority: "P1",
    custom_field: "必须保留",
    ...overrides,
  };
  const yaml = Object.entries(fields).map(([key, value]) => {
    if (value === null) return `${key}: null`;
    if (Array.isArray(value)) return `${key}: [${value.map((item) => JSON.stringify(item)).join(", ")}]`;
    return `${key}: ${JSON.stringify(value)}`;
  }).join("\n");
  return `---\n${yaml}\n---\n\n${body}`;
}

async function project({ withAsset = true } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-content-assets-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "第二大脑-v2");
  const stateRoot = path.join(base, ".media-growth-cockpit");
  const contentRoot = path.join(root, CONTENT_ASSETS_RELATIVE_DIR);
  const inboxRoot = path.join(root, CONTENT_INBOX_RELATIVE_DIR);
  const filePath = path.join(contentRoot, "02-短视频口播", "原始内容.md");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.mkdir(inboxRoot, { recursive: true });
  if (withAsset) await fs.writeFile(filePath, markdown(), "utf8");
  return { base, root, stateRoot, contentRoot, inboxRoot, filePath };
}

function storeFor(value, options = {}) {
  return createContentAssetsStore({
    root: value.root,
    stateRoot: value.stateRoot,
    now: () => NOW,
    afterWrite: async () => {},
    ...options,
  });
}

function createInput() {
  return {
    title: "驾驶舱新选题",
    summary: "这是一段新选题摘要。",
    status: "候选选题",
    format: "文章",
    channels: ["公众号", "小红书"],
    priority: null,
    dueAt: null,
    nextAction: "补充内容角度",
  };
}

function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(match, "expected YAML frontmatter");
  return parseYaml(match[1]);
}

function publicationInput(overrides = {}) {
  return {
    platform: "公众号",
    publishedAt: "2026-07-12T12:00:00+08:00",
    url: "https://example.com/posts/content-existing",
    confirmed: true,
    ...overrides,
  };
}

async function withServer(value, run) {
  const middleware = createContentAssetsMiddleware({ store: storeFor(value) });
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

describe("内容资产安全双向写回", () => {
  test("list：GET 返回可编辑快照且不泄露本机路径", async () => {
    const value = await project();
    await withServer(value, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/content-assets`);
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.equal(snapshot.items.length, 1);
      assert.equal(snapshot.items[0].format, "短视频口播");
      assert.match(snapshot.items[0].hash, /^[a-f0-9]{64}$/);
      assert.equal("filePath" in snapshot.items[0], false);
    });
  });

  test("create：POST 仅写入选题池并执行 afterWrite", async () => {
    const value = await project({ withAsset: false });
    const calls = [];
    const store = storeFor(value, { afterWrite: async (context) => calls.push(context) });
    const saved = await store.create(createInput());
    assert.equal(saved.status, "候选选题");
    assert.equal(calls.length, 1);
    const names = await fs.readdir(value.inboxRoot);
    assert.equal(names.length, 1);
    assert.match(names[0], /^2026-07-12-驾驶舱新选题-[a-f0-9]{8}\.md$/);
    const contents = await fs.readFile(path.join(value.inboxRoot, names[0]), "utf8");
    assert.match(contents, /# 驾驶舱新选题/);
    assert.match(contents, /这是一段新选题摘要/);

    const second = await store.create(createInput());
    assert.notEqual(second.id, saved.id);
    assert.equal((await fs.readdir(value.inboxRoot)).length, 2);
  });

  test("create：同一客户端请求编号重试只认领一份，载荷变化会冲突", async () => {
    const value = await project({ withAsset: false });
    const store = storeFor(value);
    const clientRequestId = "33333333-3333-4333-8333-333333333333";
    const first = await store.create(createInput(), { clientRequestId });
    const replayed = await store.create(createInput(), { clientRequestId });
    assert.equal(replayed.id, first.id);
    assert.equal((await fs.readdir(value.inboxRoot)).length, 1);
    await assert.rejects(
      store.create({ ...createInput(), title: "同一编号不能换选题" }, { clientRequestId }),
      ContentAssetsConflictError,
    );
  });

  test("create：同 key 的审计状态缺失或未知时重新执行恢复校验", async () => {
    const value = await project({ withAsset: false });
    const clientRequestId = "66666666-6666-4666-8666-666666666666";
    const first = await storeFor(value).create(createInput(), { clientRequestId });
    await fs.writeFile(path.join(value.stateRoot, "audit", "content-assets.jsonl"), "", "utf8");
    const calls = [];
    const replayed = await storeFor(value, {
      afterWrite: async (context) => calls.push(context),
    }).create(createInput(), { clientRequestId });

    assert.equal(replayed.id, first.id);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].recovered, true);
    assert.equal((await fs.readdir(value.inboxRoot)).length, 1);

    await fs.appendFile(
      path.join(value.stateRoot, "audit", "content-assets.jsonl"),
      `${JSON.stringify({ action: "create-recovered", id: first.id, status: "unknown" })}\n`,
      "utf8",
    );
    const unknownCalls = [];
    const replayedUnknown = await storeFor(value, {
      afterWrite: async (context) => unknownCalls.push(context),
    }).create(createInput(), { clientRequestId });
    assert.equal(replayedUnknown.id, first.id);
    assert.equal(unknownCalls.length, 1);
    assert.equal(unknownCalls[0].recovered, true);
  });

  test("create：跨 key 恢复孤儿时保留旧 key，并让两个 key 都稳定认领同一资产", async () => {
    const value = await project({ withAsset: false });
    const firstRequestId = "77777777-7777-4777-8777-777777777777";
    const recoveryRequestId = "88888888-8888-4888-8888-888888888888";
    const failingStore = storeFor(value, {
      afterWrite: async () => { throw new Error("模拟索引失败"); },
    });
    await assert.rejects(
      failingStore.create(createInput(), { clientRequestId: firstRequestId }),
      ContentAssetsCommitError,
    );
    const stableStore = storeFor(value);
    const orphan = (await stableStore.list()).items[0];
    const recovered = await stableStore.create(createInput(), { clientRequestId: recoveryRequestId });
    const replayedFirst = await stableStore.create(createInput(), { clientRequestId: firstRequestId });
    const replayedRecovery = await stableStore.create(createInput(), { clientRequestId: recoveryRequestId });

    assert.equal(recovered.id, orphan.id);
    assert.equal(replayedFirst.id, orphan.id);
    assert.equal(replayedRecovery.id, orphan.id);
    assert.equal((await fs.readdir(value.inboxRoot)).length, 1);
    const [filename] = await fs.readdir(value.inboxRoot);
    const frontmatter = parseFrontmatter(await fs.readFile(path.join(value.inboxRoot, filename), "utf8"));
    assert.equal(frontmatter.client_request_id, firstRequestId);
    assert.deepEqual(frontmatter.client_request_aliases, [recoveryRequestId]);
  });

  test("create：legacy 孤儿被带 key 请求恢复后会建立持久主映射", async () => {
    const value = await project({ withAsset: false });
    const clientRequestId = "99999999-9999-4999-8999-999999999999";
    const failingStore = storeFor(value, {
      afterWrite: async () => { throw new Error("模拟索引失败"); },
    });
    await assert.rejects(failingStore.create(createInput()), ContentAssetsCommitError);
    const stableStore = storeFor(value);
    const orphan = (await stableStore.list()).items[0];
    const recovered = await stableStore.create(createInput(), { clientRequestId });
    const replayed = await stableStore.create(createInput(), { clientRequestId });

    assert.equal(recovered.id, orphan.id);
    assert.equal(replayed.id, orphan.id);
    assert.equal((await fs.readdir(value.inboxRoot)).length, 1);
    const [filename] = await fs.readdir(value.inboxRoot);
    const frontmatter = parseFrontmatter(await fs.readFile(path.join(value.inboxRoot, filename), "utf8"));
    assert.equal(frontmatter.client_request_id, clientRequestId);
    assert.deepEqual(frontmatter.client_request_aliases ?? [], []);
  });

  test("create：同进程并发提交同一 key 只创建一份资产", async () => {
    const value = await project({ withAsset: false });
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const [first, second] = await Promise.all([
      storeFor(value).create(createInput(), { clientRequestId }),
      storeFor(value).create(createInput(), { clientRequestId }),
    ]);
    assert.equal(second.id, first.id);
    assert.equal((await fs.readdir(value.inboxRoot)).length, 1);
  });

  test("create：空 V2 根目录可完成首次新建", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-content-assets-empty-"));
    temporaryDirectories.push(base);
    const root = path.join(base, "第二大脑-v2");
    const stateRoot = path.join(base, ".media-growth-cockpit");
    await fs.mkdir(root, { recursive: true });

    const store = createContentAssetsStore({
      root,
      stateRoot,
      now: () => NOW,
      afterWrite: async () => {},
    });
    const saved = await store.create(createInput());

    assert.equal(saved.status, "候选选题");
    const inboxRoot = path.join(root, CONTENT_INBOX_RELATIVE_DIR);
    const names = await fs.readdir(inboxRoot);
    assert.equal(names.length, 1);
    assert.match(names[0], /^2026-07-12-驾驶舱新选题-[a-f0-9]{8}\.md$/);
  });

  test("update：只更新白名单字段并保留未知 frontmatter、正文和备份", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = (await store.list()).items[0];
    const saved = await store.update(initial.id, {
      status: "待发布",
      format: "文章",
      channels: ["公众号"],
      priority: "P0",
      dueAt: "2026-07-20",
      nextAction: "发布公众号",
    }, initial.hash);
    assert.equal(saved.status, "待发布");
    const contents = await fs.readFile(value.filePath, "utf8");
    assert.match(contents, /custom_field: 必须保留/);
    assert.match(contents, /正文第一段。\n\n## 证据\n\n正文必须原样保留。/);
    assert.match(contents, /updated_at: 2026-07-12/);
    assert.equal((await fs.readdir(path.join(value.stateRoot, "backups", "content-assets"))).length, 1);
  });

  test("update：拒绝软链接备份目录，敏感原文不会写到状态目录外", async () => {
    const value = await project();
    const outsideBackup = path.join(value.base, "outside-content-backups");
    const backupsParent = path.join(value.stateRoot, "backups");
    await fs.mkdir(outsideBackup, { recursive: true });
    await fs.mkdir(backupsParent, { recursive: true });
    await fs.symlink(outsideBackup, path.join(backupsParent, "content-assets"));
    const store = storeFor(value);
    const initial = (await store.list()).items[0];
    const before = await fs.readFile(value.filePath, "utf8");

    await assert.rejects(
      store.update(initial.id, { nextAction: "不得落入链外" }, initial.hash),
      ContentAssetsSecurityError,
    );

    assert.equal(await fs.readFile(value.filePath, "utf8"), before);
    assert.deepEqual(await fs.readdir(outsideBackup), []);
  });

  test("complete：人工确认完成后写入 completed_at，推进待发布且重复操作不重复写", async () => {
    const value = await project();
    await fs.writeFile(value.filePath, markdown({ status: "候选选题" }), "utf8");
    const store = storeFor(value);
    const initial = (await store.list()).items[0];

    const completed = await store.complete(initial.id, initial.hash);
    assert.equal(completed.completedAt, NOW.toISOString());
    assert.equal(completed.status, "待发布");
    assert.deepEqual(completed.publicationRecords, []);
    const contents = await fs.readFile(value.filePath, "utf8");
    assert.match(contents, /completed_at: 2026-07-12T04:05:06\.789Z/);
    assert.match(contents, /正文第一段。\n\n## 证据\n\n正文必须原样保留。/);

    const repeated = await store.complete(completed.id, completed.hash);
    assert.equal(repeated.hash, completed.hash);
    assert.equal(repeated.completedAt, completed.completedAt);
    assert.equal((await fs.readdir(path.join(value.stateRoot, "backups", "content-assets"))).length, 1);
  });

  test("publish：登记核验发布会补完成时间、发布状态和平台，并安全下发记录", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = (await store.list()).items[0];
    const published = await store.registerPublication(initial.id, publicationInput({
      platform: "小红书",
      url: "https://Example.com/posts/content-existing#share",
    }), initial.hash);

    assert.equal(published.status, "已发布");
    assert.equal(published.completedAt, "2026-07-12T12:00:00+08:00");
    assert.deepEqual(published.channels, ["抖音", "小红书"]);
    assert.equal(published.publicationRecords.length, 1);
    assert.match(published.publicationRecords[0].id, /^publication-[a-f0-9]{32}$/);
    assert.deepEqual(published.publicationRecords[0], {
      id: published.publicationRecords[0].id,
      platform: "小红书",
      publishedAt: "2026-07-12T12:00:00+08:00",
      url: "https://example.com/posts/content-existing",
      evidenceRef: null,
      verification: "已核验",
    });
    assert.equal("verifiedAt" in published.publicationRecords[0], false);
    assert.equal("filePath" in published.publicationRecords[0], false);

    const contents = await fs.readFile(value.filePath, "utf8");
    assert.match(contents, /status: 已发布/);
    assert.match(contents, /completed_at: 2026-07-12T12:00:00\+08:00/);
    assert.match(contents, /verification: 已核验/);
    assert.match(contents, /verified_at: 2026-07-12T04:05:06\.789Z/);

    await assert.rejects(store.registerPublication(published.id, publicationInput({
      platform: "小红书",
      url: "https://example.com/posts/content-existing#another-fragment",
    }), published.hash), /已经登记/);
    assert.equal((await store.findById(published.id)).publicationRecords.length, 1);
  });

  test("publish：支持安全 Obsidian 证据引用，并拒绝未来时间、危险证据和证据混用", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = (await store.list()).items[0];

    await assert.rejects(
      store.registerPublication(initial.id, publicationInput({ publishedAt: "2026-07-12T04:10:06.790Z" }), initial.hash),
      /发布时间不能晚于当前时间/,
    );
    await assert.rejects(
      store.registerPublication(initial.id, publicationInput({ publishedAt: "2026-07-12", url: undefined }), initial.hash),
      ContentAssetsValidationError,
    );
    await assert.rejects(
      store.registerPublication(initial.id, publicationInput({ url: undefined, evidenceRef: "[[../secret]]" }), initial.hash),
      /安全的 Obsidian 双链/,
    );
    await assert.rejects(
      store.registerPublication(initial.id, publicationInput({ evidenceRef: "[[发布截图]]" }), initial.hash),
      /二选一/,
    );
    await assert.rejects(
      store.registerPublication(initial.id, publicationInput({ confirmed: false }), initial.hash),
      ContentAssetsValidationError,
    );

    const saved = await store.registerPublication(initial.id, publicationInput({
      url: undefined,
      evidenceRef: "[[2026-07-12-公众号发布截图]]",
    }), initial.hash);
    assert.equal(saved.publicationRecords[0].evidenceRef, "[[2026-07-12-公众号发布截图]]");
    assert.equal(saved.publicationRecords[0].url, null);
  });

  test("publish：同一发布链接不能跨内容资产重复登记", async () => {
    const value = await project();
    const secondPath = path.join(value.contentRoot, "01-文章", "第二份内容.md");
    await fs.mkdir(path.dirname(secondPath), { recursive: true });
    await fs.writeFile(secondPath, markdown({
      id: "content-second",
      family_id: "family-second",
      type: "内容资产",
      format: "文章",
      channels: ["公众号"],
    }, "# 第二份内容\n\n正文。\n"), "utf8");
    const store = storeFor(value);
    const items = (await store.list()).items;
    const first = items.find((item) => item.id === "content-existing");
    const second = items.find((item) => item.id === "content-second");
    assert.ok(first && second);
    await store.registerPublication(first.id, publicationInput(), first.hash);
    await assert.rejects(
      store.registerPublication(second.id, publicationInput(), second.hash),
      /已经登记/,
    );
    assert.equal((await store.findById(second.id)).publicationRecords.length, 0);
  });

  test("归档：候选选题可直接归档并恢复，Markdown 原文件不会被删除", async () => {
    const value = await project();
    await fs.writeFile(value.filePath, markdown({ status: "候选选题" }), "utf8");
    const store = storeFor(value);
    const initial = (await store.list()).items[0];

    const archived = await store.update(initial.id, { status: "已归档" }, initial.hash);
    assert.equal(archived.status, "已归档");
    const archivedContents = await fs.readFile(value.filePath, "utf8");
    assert.match(archivedContents, /status: 已归档/);
    assert.match(archivedContents, /正文第一段。\n\n## 证据\n\n正文必须原样保留。/);
    assert.equal((await fs.stat(value.filePath)).isFile(), true);
    assert.deepEqual(await fs.readdir(path.dirname(value.filePath)), [path.basename(value.filePath)]);

    const restored = await store.update(archived.id, { status: "候选选题" }, archived.hash);
    assert.equal(restored.status, "候选选题");
    assert.equal((await fs.stat(value.filePath)).isFile(), true);
  });

  test("hash conflict：拒绝旧哈希且返回当前快照", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = (await store.list()).items[0];
    await assert.rejects(
      store.update(initial.id, { status: "待发布" }, "0".repeat(64)),
      (error) => error instanceof ContentAssetsConflictError && error.current.hash === initial.hash,
    );
    assert.equal((await store.list()).items[0].status, "待发布");
  });

  test("同进程双 store：同一旧哈希并发更新时仅一次成功", async () => {
    const value = await project();
    const firstStore = storeFor(value);
    const secondStore = storeFor(value);
    const initial = (await firstStore.list()).items[0];

    const results = await Promise.allSettled([
      firstStore.update(initial.id, { nextAction: "第一个实例的修改" }, initial.hash),
      secondStore.update(initial.id, { nextAction: "第二个实例的修改" }, initial.hash),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof ContentAssetsConflictError);
    assert.equal((await firstStore.list()).items[0].nextAction, fulfilled[0].value.nextAction);
  });

  test("安全边界：拒绝软链内容与客户端路径穿越参数", async () => {
    const value = await project({ withAsset: false });
    const outside = path.join(value.base, "outside.md");
    const outsideContents = markdown({ id: "content-outside" });
    await fs.writeFile(outside, outsideContents, "utf8");
    await fs.symlink(outside, path.join(value.inboxRoot, "伪装内容.md"));
    const store = storeFor(value);
    assert.deepEqual((await store.list()).items, []);
    await assert.rejects(store.update("content-outside", { status: "已发布" }, "0".repeat(64)), ContentAssetsNotFoundError);
    assert.equal(await fs.readFile(outside, "utf8"), outsideContents);
    await withServer(value, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/api/content-assets?path=../../etc/passwd`)).status, 400);
    });
  });

  test("恢复：更新失败恢复旧文件；新增失败保留同一成果且重试不重复", async () => {
    const value = await project();
    const before = await fs.readFile(value.filePath, "utf8");
    const store = storeFor(value, {
      afterWrite: async ({ rollback }) => {
        if (!rollback) throw new Error("模拟索引失败");
      },
    });
    const initial = (await store.list()).items[0];
    await assert.rejects(store.update(initial.id, { nextAction: "等待索引完成" }, initial.hash), ContentAssetsCommitError);
    assert.equal(await fs.readFile(value.filePath, "utf8"), before);

    await assert.rejects(store.create(createInput()), ContentAssetsCommitError);
    assert.equal((await fs.readdir(value.inboxRoot)).length, 1);
    const recovered = await storeFor(value).create(createInput());
    assert.equal(recovered.title, createInput().title);
    assert.equal((await fs.readdir(value.inboxRoot)).length, 1);
  });

  test("回滚：完成与发布登记在索引失败后恢复原文件", async () => {
    const value = await project();
    const before = await fs.readFile(value.filePath, "utf8");
    const store = storeFor(value, {
      afterWrite: async ({ rollback }) => {
        if (!rollback) throw new Error("模拟索引失败");
      },
    });
    const initial = (await store.list()).items[0];
    await assert.rejects(store.complete(initial.id, initial.hash), ContentAssetsCommitError);
    assert.equal(await fs.readFile(value.filePath, "utf8"), before);

    const restored = (await store.list()).items[0];
    await assert.rejects(
      store.registerPublication(restored.id, publicationInput(), restored.hash),
      ContentAssetsCommitError,
    );
    assert.equal(await fs.readFile(value.filePath, "utf8"), before);
  });

  test("发布后状态必须有核验记录，归档不能绕过核验事实", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = (await store.list()).items[0];
    await assert.rejects(
      store.update(initial.id, { status: "已发布" }, initial.hash),
      ContentAssetsValidationError,
    );
    await assert.rejects(
      store.update(initial.id, { status: "待复盘" }, initial.hash),
      ContentAssetsValidationError,
    );

    await fs.writeFile(value.filePath, markdown({
      published_records: [{
        platform: "抖音",
        published_at: "2026-07-12",
        verification: "已核验",
        evidence_ref: "[[发布截图]]",
      }],
    }), "utf8");
    const malformed = (await store.list()).items[0];
    await assert.rejects(
      store.update(malformed.id, { status: "已发布" }, malformed.hash),
      ContentAssetsValidationError,
    );

    await fs.writeFile(value.filePath, markdown({
      published_records: [{
        platform: "抖音",
        published_at: "2026-02-31T12:00:00+08:00",
        verification: "已核验",
        evidence_ref: "[[发布截图]]",
      }],
    }), "utf8");
    const impossibleDate = (await store.list()).items[0];
    await assert.rejects(
      store.update(impossibleDate.id, { status: "已发布" }, impossibleDate.hash),
      ContentAssetsValidationError,
    );

    await fs.writeFile(value.filePath, markdown({
      status: "已发布",
      published_records: [{
        platform: "抖音",
        published_at: "2026-07-12T12:00:00+08:00",
        verification: "已核验",
        evidence_ref: "[[发布截图]]",
      }],
    }), "utf8");
    const verified = (await store.list()).items[0];
    const archived = await store.update(verified.id, { status: "已归档" }, verified.hash);
    assert.equal(archived.status, "已归档");
    await assert.rejects(
      store.update(archived.id, { status: "候选选题" }, archived.hash),
      ContentAssetsValidationError,
    );
    const reviewed = await store.update(archived.id, { status: "待复盘" }, archived.hash);
    assert.equal(reviewed.status, "待复盘");
  });

  test("疑似凭证不会进入可编辑列表或由网页创建", async () => {
    const value = await project();
    await fs.writeFile(value.filePath, markdown({}, "# api_token: sk-abc123xyz\n"), "utf8");
    const store = storeFor(value);
    assert.deepEqual((await store.list()).items, []);
    await assert.rejects(
      store.create({ ...createInput(), summary: "api_token: sk-abc123xyz" }),
      ContentAssetsValidationError,
    );
  });
});

describe("内容完成与发布登记 HTTP API", () => {
  test("新建内容要求幂等编号，同一请求重试返回原资产", async () => {
    const value = await project({ withAsset: false });
    await withServer(value, async (baseUrl) => {
      const headers = { "Content-Type": "application/json", Origin: baseUrl };
      const withoutKey = await fetch(`${baseUrl}/api/content-assets`, {
        method: "POST",
        headers,
        body: JSON.stringify(createInput()),
      });
      assert.equal(withoutKey.status, 400);

      const requestHeaders = {
        ...headers,
        "X-Idempotency-Key": "44444444-4444-4444-8444-444444444444",
      };
      const first = await fetch(`${baseUrl}/api/content-assets`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(createInput()),
      });
      const replay = await fetch(`${baseUrl}/api/content-assets`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(createInput()),
      });
      assert.equal(first.status, 201);
      assert.equal(replay.status, 201);
      assert.equal((await first.json()).id, (await replay.json()).id);
      assert.equal((await (await fetch(`${baseUrl}/api/content-assets`)).json()).items.length, 1);
    });
  });

  test("同源 POST 完成并登记发布，响应包含可继续编辑的最新快照", async () => {
    const value = await project();
    await withServer(value, async (baseUrl) => {
      const initial = await (await fetch(`${baseUrl}/api/content-assets`)).json();
      const item = initial.items[0];
      assert.equal(item.completedAt, null);
      assert.deepEqual(item.publicationRecords, []);

      const completeResponse = await fetch(`${baseUrl}/api/content-assets/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ id: item.id, expectedHash: item.hash }),
      });
      assert.equal(completeResponse.status, 200);
      const completed = await completeResponse.json();
      assert.equal(completed.completedAt, NOW.toISOString());

      const publicationResponse = await fetch(`${baseUrl}/api/content-assets/publications`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({
          id: completed.id,
          expectedHash: completed.hash,
          ...publicationInput(),
        }),
      });
      assert.equal(publicationResponse.status, 201);
      const published = await publicationResponse.json();
      assert.equal(published.status, "已发布");
      assert.equal(published.publicationRecords.length, 1);
      assert.equal(published.publicationRecords[0].verification, "已核验");

      const duplicateResponse = await fetch(`${baseUrl}/api/content-assets/publications`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({
          id: published.id,
          expectedHash: published.hash,
          ...publicationInput(),
        }),
      });
      assert.equal(duplicateResponse.status, 400);
      assert.match((await duplicateResponse.json()).message, /已经登记/);
    });
  });

  test("新写接口拒绝缺失 Origin、查询参数、错误方法和旧哈希", async () => {
    const value = await project();
    await withServer(value, async (baseUrl) => {
      const initial = await (await fetch(`${baseUrl}/api/content-assets`)).json();
      const item = initial.items[0];
      const withoutOrigin = await fetch(`${baseUrl}/api/content-assets/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, expectedHash: item.hash }),
      });
      assert.equal(withoutOrigin.status, 403);
      assert.equal((await fetch(`${baseUrl}/api/content-assets/complete?path=bad`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/api/content-assets/publications`)).status, 405);

      const stale = await fetch(`${baseUrl}/api/content-assets/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ id: item.id, expectedHash: "0".repeat(64) }),
      });
      assert.equal(stale.status, 409);
      const conflict = await stale.json();
      assert.equal(conflict.current.id, item.id);
      assert.equal(conflict.current.completedAt, null);
    });
  });
});
