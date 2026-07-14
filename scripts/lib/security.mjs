import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MAX_FILE_BYTES = 1_048_576;

const SECRET_PATTERNS = [
  /\b(api[_\s-]?token|access[_\s-]?token|auth[_\s-]?token|token|cookie|api[_\s-]?key|bearer|secret[_\s-]?key|private[_\s-]?key)\s*[:=]\s*['"`]?[\w\-./+=]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bghp_[a-zA-Z0-9]{36}\b/,
  /\bgho_[a-zA-Z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgithub[_\s-]?token\b/i,
  /\bBearer\s+[a-zA-Z0-9_\-./+=]{8,}/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
  /\b[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/, // JWT-like
];

export class SecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecurityError";
  }
}

export function hasSecret(text) {
  if (typeof text !== "string") return false;
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function isSafeRelativePath(input) {
  if (typeof input !== "string") return false;
  if (input.includes("\0")) return false;
  if (input.startsWith("/")) return false;
  const normalized = path.normalize(input);
  if (normalized.startsWith("..")) return false;
  if (path.isAbsolute(normalized)) return false;
  return true;
}

export function resolveUnderRoot(rootReal, candidateRelative) {
  const candidateAbsolute = path.resolve(rootReal, candidateRelative);
  let candidateReal;
  try {
    candidateReal = fs.realpathSync(candidateAbsolute);
  } catch (err) {
    throw new SecurityError(`无法解析路径: ${candidateRelative} (${err.message})`);
  }
  const rel = path.relative(rootReal, candidateReal);
  if (rel === "" || rel.startsWith("..")) {
    throw new SecurityError(`路径跳出根目录: ${candidateRelative}`);
  }
  return candidateReal;
}

export function readSafeMarkdown(rootReal, relativePath) {
  if (!isSafeRelativePath(relativePath)) {
    throw new SecurityError(`非法相对路径: ${relativePath}`);
  }
  const candidateAbsolute = path.resolve(rootReal, relativePath);
  const relToRoot = path.relative(rootReal, candidateAbsolute);
  if (relToRoot.startsWith("..") || relToRoot === "") {
    throw new SecurityError(`路径跳出根目录: ${relativePath}`);
  }

  // 检查路径中任何组件是否为软链接
  let current = rootReal;
  for (const part of relativePath.split(path.sep)) {
    if (part === "" || part === ".") continue;
    current = path.join(current, part);
    let componentStats;
    try {
      componentStats = fs.lstatSync(current);
    } catch (err) {
      throw new SecurityError(`无法读取路径组件状态: ${relativePath} (${err.message})`);
    }
    if (componentStats.isSymbolicLink()) {
      throw new SecurityError(`拒绝路径中的软链接: ${relativePath}`);
    }
  }

  let realPath;
  try {
    realPath = fs.realpathSync(candidateAbsolute);
  } catch (err) {
    throw new SecurityError(`无法解析路径: ${relativePath} (${err.message})`);
  }
  const realRel = path.relative(rootReal, realPath);
  if (realRel.startsWith("..") || realRel === "") {
    throw new SecurityError(`解析后路径跳出根目录: ${relativePath}`);
  }

  let stats;
  try {
    stats = fs.lstatSync(realPath);
  } catch (err) {
    throw new SecurityError(`无法读取真实文件状态: ${relativePath} (${err.message})`);
  }
  if (stats.isSymbolicLink()) {
    throw new SecurityError(`拒绝指向软链接的真实路径: ${relativePath}`);
  }
  if (!stats.isFile()) {
    throw new SecurityError(`不是普通文件: ${relativePath}`);
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new SecurityError(`文件超过 ${MAX_FILE_BYTES} 字节: ${relativePath}`);
  }

  const content = fs.readFileSync(realPath, "utf8");
  if (content.includes("\0")) {
    throw new SecurityError(`文件包含 NUL 字节: ${relativePath}`);
  }
  return { content, bytes: stats.size, realPath };
}

export function sha256(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function isFullIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth;
}

export function sanitizeUrl(value) {
  if (isHttpsUrl(value)) return value;
  return null;
}

const BLOCKED_URL_SCHEMES = /\b(?:javascript|data|file|vbscript):/i;

export function containsDangerousUrl(text) {
  if (typeof text !== "string") return false;
  return BLOCKED_URL_SCHEMES.test(text);
}

export function toPlainText(markdown, { maxLength = 240 } = {}) {
  if (!markdown) return "";
  let text = markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/(`{1,3})([^`]*?)\1/g, "$2")
    .replace(/(\*{1,2}|_{1,2})([^*_]+)\1/g, "$2")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s*(\[[xX\s]\]\s*)?/gm, "")
    .replace(/^\s*\d+\.\s*/gm, "")
    .replace(/^\s*>\s*/gm, "")
    .replace(/\n+/g, "\n")
    .trim();

  const paragraphs = text.split(/\n{2,}/).map((p) => p.replace(/\n/g, " ").trim()).filter(Boolean);
  const first = paragraphs[0] || "";
  if (first.length <= maxLength) return first;
  return first.slice(0, maxLength).trim() + "…";
}
