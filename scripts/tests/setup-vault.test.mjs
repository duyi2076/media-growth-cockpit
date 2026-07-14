import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { setupVault } from "../setup-vault.mjs";

const temporaryDirectories = [];

function config() {
  return {
    productName: "创作者驾驶舱",
    ownerName: "测试用户",
    creatorPositioning: "科普博主",
    campaignName: "90 天增长计划",
    growthTarget: 20_000,
    startDate: "2026-07-15",
    deadline: "2026-10-12",
    projectRelativeDir: "50-进行中项目/科普增长计划",
    baselineDate: "2026-07-14",
    accounts: [{
      id: "test-account",
      platform: "公众号",
      displayName: "测试账号",
      handle: "test-handle",
      profileUrl: "https://example.org/account",
      baselineFollowers: 100,
      currentFollowers: 100,
      asOf: "2026-07-14",
      sourceEvidence: "测试后台快照",
      active: true,
    }],
    actionTargets: {
      articles: 30,
      videos: 20,
      publications: 30,
      dailyReviews: 30,
      accountBreakdowns: 10,
    },
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test("拒绝通过 Vault 内父目录软链接把初始化文件写到外部", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-setup-symlink-escape-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "vault");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, "10-原始材料"));
  await fs.symlink(outside, path.join(root, "10-原始材料", "04-原始数据"));

  await assert.rejects(setupVault({ root, config: config() }), /软链接/);

  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(
    fs.access(path.join(root, "40-业务资产/01-定位与公司说明/平台账号注册表.md")),
    { code: "ENOENT" },
  );
});

test("拒绝非目录父节点和越出 Vault 的配置路径", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-setup-unsafe-path-"));
  temporaryDirectories.push(base);
  const rootWithFileParent = path.join(base, "vault-file-parent");
  await fs.mkdir(rootWithFileParent);
  await fs.writeFile(path.join(rootWithFileParent, "10-原始材料"), "not-a-directory", "utf8");

  await assert.rejects(
    setupVault({ root: rootWithFileParent, config: config() }),
    /非目录父节点/,
  );

  const rootWithTraversal = path.join(base, "vault-traversal");
  const traversalConfig = { ...config(), baselineRelativePath: "../outside.md" };
  await assert.rejects(
    setupVault({ root: rootWithTraversal, config: traversalConfig }),
    /基线文件必须是 60-数据与看板 下的 Markdown 相对路径/,
  );
  await assert.rejects(fs.access(path.join(base, "outside.md")), { code: "ENOENT" });
});

test("拒绝 UI 和索引尚未支持的平台且不创建 Vault", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-setup-platform-contract-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "vault");
  const unsupported = config();
  unsupported.accounts[0] = { ...unsupported.accounts[0], platform: "YouTube" };

  await assert.rejects(
    setupVault({ root, config: unsupported }),
    /平台仅支持: 小红书、公众号、B 站、抖音、视频号、X/,
  );
  await assert.rejects(fs.access(root), { code: "ENOENT" });
});

test("初始化时把 B站 规范化为产品统一的平台名 B 站", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-setup-platform-normalize-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "vault");
  const value = config();
  value.accounts[0] = { ...value.accounts[0], platform: "B站" };

  await setupVault({ root, config: value });

  const registry = await fs.readFile(
    path.join(root, "40-业务资产/01-定位与公司说明/平台账号注册表.md"),
    "utf8",
  );
  assert.match(registry, /\| test-account \| B 站 \|/);
});

test("初始化末段失败时移除本轮已经创建的权威文件", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cockpit-setup-rollback-"));
  temporaryDirectories.push(base);
  const root = path.join(base, "vault");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);

  const value = config();
  const targets = value.actionTargets;
  Object.defineProperty(value, "actionTargets", {
    configurable: true,
    get() {
      fsSync.symlinkSync(outside, path.join(root, "99-系统"));
      return targets;
    },
  });

  await assert.rejects(setupVault({ root, config: value }), /软链接/);

  const expectedMissing = [
    "10-原始材料/04-原始数据/2026-07-14-test-account-账号证据.md",
    "40-业务资产/01-定位与公司说明/平台账号注册表.md",
    "60-数据与看板/01-内容数据/2026-07-14-平台粉丝基线.md",
    "50-进行中项目/科普增长计划/01-目标与验收.md",
  ];
  for (const relativePath of expectedMissing) {
    await assert.rejects(fs.access(path.join(root, relativePath)), { code: "ENOENT" });
  }
  assert.deepEqual(await fs.readdir(outside), []);
});
