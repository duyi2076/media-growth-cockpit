import path from "node:path";

const writeQueues = new Map();

/**
 * Serialize writes to the same authoritative file within this Node process.
 * This intentionally does not claim to coordinate separate OS processes.
 */
export function runWithSharedWriteQueue(filePath, operation) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new TypeError("共享写入队列需要绝对文件路径");
  }
  if (typeof operation !== "function") {
    throw new TypeError("共享写入队列需要写入函数");
  }

  const key = path.normalize(filePath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writeQueues.set(key, current);
  void current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  }).catch(() => {});
  return current;
}
