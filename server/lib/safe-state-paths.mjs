import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Restricts mutable runtime state (backups and audit logs) to one real directory.
 * Every managed directory component is checked with lstat so a symlink cannot
 * redirect sensitive Obsidian contents outside the configured state root.
 */
export function createSafeStatePaths(options = {}) {
  const stateRoot = path.resolve(options.stateRoot);
  const label = options.label ?? "运行状态";
  const createSecurityError = options.createSecurityError ?? ((message) => new Error(message));
  let canonicalStateRootReal = null;

  function securityError(message) {
    return createSecurityError(`${label}${message}`);
  }

  function assertInsideStateRoot(target) {
    const resolvedTarget = path.resolve(target);
    const relative = path.relative(stateRoot, resolvedTarget);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return resolvedTarget;
    }
    throw securityError("路径超出状态目录");
  }

  async function inspectOrCreateStateRoot({ create }) {
    const directParent = path.dirname(stateRoot);
    const directParentStat = await lstatOrNull(directParent);
    if (directParentStat?.isSymbolicLink() || (directParentStat && !directParentStat.isDirectory())) {
      throw securityError("根目录的父目录不能是软链接或非目录节点");
    }

    let stateStat = await lstatOrNull(stateRoot);
    if (!stateStat && create) {
      const missingSegments = [];
      let existingParent = stateRoot;
      let existingParentStat = null;
      while (!existingParentStat) {
        const parent = path.dirname(existingParent);
        if (parent === existingParent) {
          throw securityError("找不到可用的状态根目录父目录");
        }
        missingSegments.unshift(path.basename(existingParent));
        existingParent = parent;
        existingParentStat = await lstatOrNull(existingParent);
      }
      if (!existingParentStat.isDirectory() || existingParentStat.isSymbolicLink()) {
        throw securityError("根目录的最近现有父目录不能是软链接或非目录节点");
      }
      let current = existingParent;
      for (const segment of missingSegments) {
        current = path.join(current, segment);
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        const stat = await lstatOrNull(current);
        if (!stat?.isDirectory() || stat.isSymbolicLink()) {
          throw securityError("根目录创建路径不能包含软链接或非目录节点");
        }
      }
      stateStat = await lstatOrNull(stateRoot);
    }
    if (!stateStat?.isDirectory() || stateStat.isSymbolicLink()) {
      throw securityError("根目录不存在、不是目录或为软链接");
    }
    return stateStat;
  }

  async function inspectDirectory(directory, { create = false, expectedReal = null } = {}) {
    const resolvedDirectory = assertInsideStateRoot(directory);
    await inspectOrCreateStateRoot({ create });

    const currentStateRootReal = await fs.realpath(stateRoot);
    if (canonicalStateRootReal === null) canonicalStateRootReal = currentStateRootReal;
    if (currentStateRootReal !== canonicalStateRootReal) {
      throw securityError("根目录 realpath 已改变");
    }

    let current = stateRoot;
    for (const segment of path.relative(stateRoot, resolvedDirectory).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      let stat = await lstatOrNull(current);
      if (!stat && create) {
        try {
          await fs.mkdir(current, { mode: 0o700 });
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        stat = await lstatOrNull(current);
      }
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        throw securityError("目录不能包含软链接或非目录节点");
      }
    }

    const directoryReal = await fs.realpath(resolvedDirectory);
    const expectedDirectoryReal = path.resolve(
      canonicalStateRootReal,
      path.relative(stateRoot, resolvedDirectory),
    );
    const relativeReal = path.relative(canonicalStateRootReal, directoryReal);
    if (
      (relativeReal !== "" && (relativeReal.startsWith("..") || path.isAbsolute(relativeReal)))
      || directoryReal !== expectedDirectoryReal
      || (expectedReal !== null && directoryReal !== expectedReal)
    ) {
      throw securityError("目录 realpath 已改变或超出状态目录");
    }
    return directoryReal;
  }

  async function ensureRoot() {
    return inspectDirectory(stateRoot, { create: true });
  }

  async function ensureDirectory(directory) {
    return inspectDirectory(directory, { create: true });
  }

  async function verifyFile(filePath, expectedDirectoryReal, openedStat) {
    const resolvedFilePath = assertInsideStateRoot(filePath);
    const directory = path.dirname(resolvedFilePath);
    await inspectDirectory(directory, { expectedReal: expectedDirectoryReal });
    const stat = await lstatOrNull(resolvedFilePath);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw securityError("文件不能是软链接或非普通文件");
    }
    if (openedStat && (stat.dev !== openedStat.dev || stat.ino !== openedStat.ino)) {
      throw securityError("文件在写入期间被替换");
    }
    const fileReal = await fs.realpath(resolvedFilePath);
    if (fileReal !== path.join(expectedDirectoryReal, path.basename(resolvedFilePath))) {
      throw securityError("文件 realpath 超出固定目录");
    }
  }

  async function writeNewFile(filePath, contents) {
    const resolvedFilePath = assertInsideStateRoot(filePath);
    const directory = path.dirname(resolvedFilePath);
    const directoryReal = await ensureDirectory(directory);
    await inspectDirectory(directory, { expectedReal: directoryReal });
    const flags = fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(resolvedFilePath, flags, 0o600);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) throw securityError("文件必须是普通文件");
      await verifyFile(resolvedFilePath, directoryReal, openedStat);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await verifyFile(resolvedFilePath, directoryReal, openedStat);
    } finally {
      await handle.close();
    }
  }

  async function prepareAppendFile(filePath) {
    const resolvedFilePath = assertInsideStateRoot(filePath);
    const directory = path.dirname(resolvedFilePath);
    const directoryReal = await ensureDirectory(directory);
    const existing = await lstatOrNull(resolvedFilePath);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw securityError("追加目标不能是软链接或非普通文件");
    }
    if (existing) await verifyFile(resolvedFilePath, directoryReal, existing);
    return directoryReal;
  }

  async function appendFile(filePath, contents) {
    const resolvedFilePath = assertInsideStateRoot(filePath);
    const directoryReal = await prepareAppendFile(resolvedFilePath);
    const flags = fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_APPEND
      | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(resolvedFilePath, flags, 0o600);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) throw securityError("追加目标必须是普通文件");
      await verifyFile(resolvedFilePath, directoryReal, openedStat);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await verifyFile(resolvedFilePath, directoryReal, openedStat);
    } finally {
      await handle.close();
    }
  }

  async function readFile(filePath, { maxBytes = 4 * 1024 * 1024, missing = null } = {}) {
    const resolvedFilePath = assertInsideStateRoot(filePath);
    const existing = await lstatOrNull(resolvedFilePath);
    if (!existing) return missing;
    const directory = path.dirname(resolvedFilePath);
    const directoryReal = await inspectDirectory(directory);
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fs.open(resolvedFilePath, flags);
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) throw securityError("读取目标必须是普通文件");
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || openedStat.size > maxBytes) {
        throw securityError("读取目标超过安全上限");
      }
      await verifyFile(resolvedFilePath, directoryReal, openedStat);
      const contents = await handle.readFile("utf8");
      await verifyFile(resolvedFilePath, directoryReal, openedStat);
      return contents;
    } finally {
      await handle.close();
    }
  }

  return {
    stateRoot,
    ensureRoot,
    ensureDirectory,
    writeNewFile,
    prepareAppendFile,
    appendFile,
    readFile,
  };
}
