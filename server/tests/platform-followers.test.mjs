import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createPlatformFollowersMiddleware } from "../platform-followers-api.mjs";
import {
  createPlatformFollowersStore,
  PLATFORM_REGISTRY_RELATIVE_PATH,
  PlatformFollowersConflictError,
  PlatformFollowersSecurityError,
  PlatformFollowersValidationError,
} from "../platform-followers-store.mjs";

const NOW = new Date("2026-07-12T13:20:00.000Z");
const temporaryDirectories = [];
const rows = [
  ["xhs-creator", "小红书", 1200],
  ["mp-creator", "公众号", 800],
  ["bili-creator", "B 站", 600],
  ["dy-creator", "抖音", 500],
  ["sph-creator", "视频号", 300],
  ["x-creator", "X", 100],
];

function registry(accountRows = rows) {
  const bodyRows = accountRows.map(([id, platform, followers]) => `| ${id} | ${platform} | 名称 | handle | https://example.com/${id} | ${followers} | 2026-07-10 | 证据 | true |`).join("\n");
  return `---\nid: registry\ntype: 定位与公司说明\nstatus: 已确认\nconfirmation: 已确认\nsensitivity: 内部\nupdated_at: 2026-07-11\n---\n\n# 平台账号注册表\n\n| account_id | platform | display_name | handle | profile_url | current_followers | as_of | source_evidence | active |\n|---|---|---|---|---|---:|---|---|---|\n${bodyRows}\n\n**当前粉丝合计：3,500**\n`;
}

async function project(accountRows = rows) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "creator-platform-followers-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "第二大脑-v2");
  const stateRoot = path.join(base, ".state");
  const filePath = path.join(root, PLATFORM_REGISTRY_RELATIVE_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, registry(accountRows), "utf8");
  return { base, root, stateRoot, filePath };
}

function storeFor(value, options = {}) {
  return createPlatformFollowersStore({ root: value.root, stateRoot: value.stateRoot, now: () => NOW, afterWrite: async () => {}, ...options });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("平台粉丝安全写回", () => {
  test("读取六平台并只更新当前粉丝、日期和合计", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = await store.read();
    assert.equal(initial.accounts.length, 6);
    const next = initial.accounts.map((account) => ({ id: account.id, currentFollowers: account.id === "xhs-creator" ? 1300 : account.currentFollowers }));
    const saved = await store.write(next, initial.hash);
    assert.equal(saved.accounts.find((account) => account.id === "xhs-creator").currentFollowers, 1300);
    const contents = await fs.readFile(value.filePath, "utf8");
    assert.match(contents, /\| xhs-creator \| 小红书 \| 名称 \| handle \| https:\/\/example\.com\/xhs-creator \| 1300 \| 2026-07-12 \| 证据 \| true \|/);
    assert.match(contents, /\*\*当前粉丝合计：3,600\*\*/);
    assert.equal((await fs.readdir(path.join(value.stateRoot, "backups", "platform-followers"))).length, 1);
  });

  test("从注册表动态读取两个安全账号并允许按任意顺序更新", async () => {
    const dynamicRows = [
      ["food-video", "视频号", 120],
      ["newsletter_main", "公众号", 80],
    ];
    const value = await project(dynamicRows);
    const store = storeFor(value);
    const initial = await store.read();
    assert.deepEqual(initial.accounts.map((account) => account.id), ["food-video", "newsletter_main"]);

    const saved = await store.write([
      { id: "newsletter_main", currentFollowers: 95 },
      { id: "food-video", currentFollowers: 135 },
    ], initial.hash);
    assert.equal(saved.accounts.find((account) => account.id === "food-video").currentFollowers, 135);
    assert.equal(saved.accounts.find((account) => account.id === "newsletter_main").currentFollowers, 95);
    assert.match(await fs.readFile(value.filePath, "utf8"), /\*\*当前粉丝合计：230\*\*/);
  });

  test("拒绝通过粉丝写回接口增删账号，并拒绝注册表中的不安全或重复 ID", async () => {
    const dynamicRows = [
      ["food-video", "视频号", 120],
      ["newsletter_main", "公众号", 80],
    ];
    const value = await project(dynamicRows);
    const store = storeFor(value);
    const initial = await store.read();

    await assert.rejects(
      store.write([{ id: "food-video", currentFollowers: 121 }], initial.hash),
      (error) => error instanceof PlatformFollowersValidationError && /不能通过粉丝写回接口增删账号/.test(error.message),
    );
    await assert.rejects(
      store.write([
        ...initial.accounts.map(({ id, currentFollowers }) => ({ id, currentFollowers })),
        { id: "new-account", currentFollowers: 0 },
      ], initial.hash),
      (error) => error instanceof PlatformFollowersValidationError && /不能通过粉丝写回接口增删账号/.test(error.message),
    );

    await fs.writeFile(value.filePath, registry([
      ["unsafe account", "视频号", 120],
      ["safe-id", "公众号", 80],
    ]), "utf8");
    await assert.rejects(store.read(), PlatformFollowersValidationError);

    await fs.writeFile(value.filePath, registry([
      ["same-id", "视频号", 120],
      ["same-id", "公众号", 80],
    ]), "utf8");
    await assert.rejects(store.read(), PlatformFollowersValidationError);
  });

  test("拒绝旧哈希与软链接注册表", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = await store.read();
    await assert.rejects(store.write(initial.accounts.map(({ id, currentFollowers }) => ({ id, currentFollowers })), "0".repeat(64)), PlatformFollowersConflictError);
    const outside = path.join(value.base, "outside.md");
    await fs.rename(value.filePath, outside);
    await fs.symlink(outside, value.filePath);
    await assert.rejects(store.read(), PlatformFollowersSecurityError);
  });

  test("拒绝软链接备份目录，注册表原文不会写到链外", async () => {
    const value = await project();
    const outsideBackup = path.join(value.base, "outside-platform-backups");
    const backupsParent = path.join(value.stateRoot, "backups");
    await fs.mkdir(outsideBackup, { recursive: true });
    await fs.mkdir(backupsParent, { recursive: true });
    await fs.symlink(outsideBackup, path.join(backupsParent, "platform-followers"));
    const store = storeFor(value);
    const initial = await store.read();
    const next = initial.accounts.map(({ id, currentFollowers }) => ({ id, currentFollowers }));
    next[0].currentFollowers += 1;
    const before = await fs.readFile(value.filePath, "utf8");

    await assert.rejects(store.write(next, initial.hash), PlatformFollowersSecurityError);

    assert.equal(await fs.readFile(value.filePath, "utf8"), before);
    assert.deepEqual(await fs.readdir(outsideBackup), []);
  });

  test("两个粉丝 store 实例写同一注册表时共享乐观锁队列", async () => {
    const value = await project();
    const storeA = storeFor(value);
    const storeB = storeFor(value);
    const initial = await storeA.read();
    const inputA = initial.accounts.map(({ id, currentFollowers }) => ({
      id,
      currentFollowers: id === "xhs-creator" ? currentFollowers + 1 : currentFollowers,
    }));
    const inputB = initial.accounts.map(({ id, currentFollowers }) => ({
      id,
      currentFollowers: id === "xhs-creator" ? currentFollowers + 2 : currentFollowers,
    }));

    const outcomes = await Promise.allSettled([
      storeA.write(inputA, initial.hash),
      storeB.write(inputB, initial.hash),
    ]);

    const fulfilled = outcomes.filter((item) => item.status === "fulfilled");
    const rejected = outcomes.filter((item) => item.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof PlatformFollowersConflictError);
    assert.equal(rejected[0].reason.current.hash, fulfilled[0].value.hash);
  });

  test("HTTP GET/PUT 支持动态账号，但拒绝客户端改变账号集合", async () => {
    const value = await project([
      ["food-video", "视频号", 120],
      ["newsletter_main", "公众号", 80],
    ]);
    const middleware = createPlatformFollowersMiddleware({ store: storeFor(value) });
    const server = http.createServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end(); }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const initial = await (await fetch(`${baseUrl}/api/platform-followers`)).json();
      const accounts = initial.accounts.map(({ id, currentFollowers }) => ({ id, currentFollowers }));
      assert.equal(initial.accounts.length, 2);
      assert.equal((await fetch(`${baseUrl}/api/platform-followers`, {
        method: "PUT",
        headers: { Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: accounts.slice(0, 1), expectedHash: initial.hash }),
      })).status, 400);
      assert.equal((await fetch(`${baseUrl}/api/platform-followers`, {
        method: "PUT",
        headers: { Origin: baseUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ accounts, expectedHash: initial.hash }),
      })).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/platform-followers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts, expectedHash: initial.hash }),
      })).status, 403);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
