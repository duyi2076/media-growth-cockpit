import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { createCockpitSettingsMiddleware } from "../cockpit-settings-api.mjs";
import {
  COCKPIT_SETTINGS_RELATIVE_PATH,
  CockpitSettingsCommitError,
  CockpitSettingsConflictError,
  CockpitSettingsSecurityError,
  CockpitSettingsValidationError,
  createCockpitSettingsStore,
  readCockpitSettingsSync,
} from "../cockpit-settings-store.mjs";

const NOW = new Date("2026-07-14T04:00:00.000Z");
const temporaryDirectories = [];

function settings(overrides = {}) {
  return {
    productName: "创作增长驾驶舱",
    ownerName: "新用户",
    creatorPositioning: "科普博主",
    campaignName: "90 天涨粉计划",
    growthTarget: 20_000,
    startDate: "2026-07-15",
    deadline: "2026-10-12",
    projectRelativeDir: "50-进行中项目/科普增长计划",
    baselineDate: "2026-07-14",
    baselineRelativePath: "60-数据与看板/01-内容数据/2026-07-14-平台粉丝基线.md",
    ...overrides,
  };
}

async function project() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-settings-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "vault");
  const stateRoot = path.join(base, "state");
  await fs.mkdir(root);
  return { base, root, stateRoot, filePath: path.join(root, COCKPIT_SETTINGS_RELATIVE_PATH) };
}

function storeFor(value, options = {}) {
  return createCockpitSettingsStore({
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

describe("驾驶舱设置存储", () => {
  test("未初始化时返回安全默认值，首次保存创建 Obsidian 文件", async () => {
    const value = await project();
    const store = storeFor(value);
    const initial = await store.read();
    assert.equal(initial.initialized, false);
    assert.equal(initial.hash, null);
    const saved = await store.write(settings(), null);
    assert.equal(saved.initialized, true);
    assert.equal(saved.settings.ownerName, "新用户");
    assert.equal(readCockpitSettingsSync(value.root).projectRelativeDir, "50-进行中项目/科普增长计划");
    const contents = await fs.readFile(value.filePath, "utf8");
    assert.match(contents, /product_name: 创作增长驾驶舱/);
    assert.match(contents, /growth_target: 20000/);
    assert.match(contents, /project_relative_dir: 50-进行中项目\/科普增长计划/);
  });

  test("保存时保留正文并拒绝过期哈希", async () => {
    const value = await project();
    const store = storeFor(value);
    const created = await store.write(settings(), null);
    await fs.appendFile(value.filePath, "\n自定义备注\n", "utf8");
    const current = await store.read();
    const updated = await store.write(settings({ growthTarget: 30_000 }), current.hash);
    assert.equal(updated.settings.growthTarget, 30_000);
    assert.match(await fs.readFile(value.filePath, "utf8"), /自定义备注/);
    await assert.rejects(store.write(settings(), created.hash), CockpitSettingsConflictError);
  });

  test("两个设置 store 实例首次保存时共享乐观锁队列", async () => {
    const value = await project();
    const storeA = storeFor(value);
    const storeB = storeFor(value);

    const outcomes = await Promise.allSettled([
      storeA.write(settings({ campaignName: "实例 A 计划" }), null),
      storeB.write(settings({ campaignName: "实例 B 计划" }), null),
    ]);

    const fulfilled = outcomes.filter((item) => item.status === "fulfilled");
    const rejected = outcomes.filter((item) => item.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof CockpitSettingsConflictError);
    assert.equal(rejected[0].reason.current.hash, fulfilled[0].value.hash);
  });

  test("拒绝非法日期、路径穿越与软链接", async () => {
    const value = await project();
    const store = storeFor(value);
    await assert.rejects(store.write(settings({ deadline: "2026-01-01" }), null), CockpitSettingsValidationError);
    await assert.rejects(store.write(settings({ projectRelativeDir: "../outside" }), null), CockpitSettingsValidationError);
    const outside = path.join(value.base, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(path.join(value.root, "99-系统"));
    await fs.symlink(outside, path.join(value.root, "99-系统", "自媒体驾驶舱"));
    await assert.rejects(store.read(), CockpitSettingsSecurityError);
  });

  test("首次保存拒绝状态根目录软链接，不创建设置或链外审计", async () => {
    const value = await project();
    const outsideState = path.join(value.base, "outside-settings-state");
    await fs.mkdir(outsideState, { recursive: true });
    await fs.symlink(outsideState, value.stateRoot);

    await assert.rejects(storeFor(value).write(settings(), null), CockpitSettingsSecurityError);

    assert.deepEqual(await fs.readdir(outsideState), []);
    await assert.rejects(fs.access(value.filePath), { code: "ENOENT" });
  });

  test("索引失败时恢复旧设置", async () => {
    const value = await project();
    const baseline = storeFor(value);
    const created = await baseline.write(settings(), null);
    const failing = storeFor(value, {
      afterWrite: async ({ rollback }) => {
        if (!rollback) throw new Error("模拟索引失败");
      },
    });
    await assert.rejects(
      failing.write(settings({ growthTarget: 99_000 }), created.hash),
      CockpitSettingsCommitError,
    );
    assert.equal((await baseline.read()).settings.growthTarget, 20_000);
  });
});

describe("驾驶舱设置 HTTP API", () => {
  async function withServer(value, run) {
    const middleware = createCockpitSettingsMiddleware({ store: storeFor(value) });
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
      const initial = await (await fetch(`${baseUrl}/api/cockpit-settings`)).json();
      assert.equal(initial.initialized, false);
      const response = await fetch(`${baseUrl}/api/cockpit-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: JSON.stringify({ settings: settings(), expectedHash: null }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).settings.campaignName, "90 天涨粉计划");
    });
  });

  test("拒绝跨源、查询参数和超大请求", async () => {
    const value = await project();
    await withServer(value, async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/api/cockpit-settings?path=x`)).status, 400);
      assert.equal((await fetch(`${baseUrl}/api/cockpit-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: "http://evil.test" },
        body: JSON.stringify({ settings: settings(), expectedHash: null }),
      })).status, 403);
      assert.equal((await fetch(`${baseUrl}/api/cockpit-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: baseUrl },
        body: "x".repeat(25 * 1024),
      })).status, 413);
    });
  });
});
