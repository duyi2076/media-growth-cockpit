import YAML from "yaml";

const MAX_ALIAS_COUNT = 100;
const MAX_FRONTMATTER_BYTES = 65536;
const ALLOWED_TAG_PREFIX = "tag:yaml.org,2002:";

export class FrontmatterError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "FrontmatterError";
    this.cause = cause;
  }
}

function rejectCustomTags(node) {
  if (!node) return;
  if (node.tag && !node.tag.startsWith(ALLOWED_TAG_PREFIX)) {
    throw new FrontmatterError(`自定义 YAML tag 被拒绝: ${node.tag}`);
  }
  if (node.items) {
    for (const item of node.items) {
      if (node.constructor.name === "YAMLMap" || node.constructor.name === "YAMLSeq") {
        rejectCustomTags(item);
      }
    }
  }
  if (node.key) rejectCustomTags(node.key);
  if (node.value) rejectCustomTags(node.value);
}

export function parseFrontmatter(raw, { maxBytes = MAX_FRONTMATTER_BYTES } = {}) {
  if (raw.includes("\0")) {
    throw new FrontmatterError("文件包含 NUL 字节");
  }
  if (raw.length > maxBytes * 10) {
    // 仅对 frontmatter 区域做限制，整个文件限制由调用方控制
  }

  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---\n") && !trimmed.startsWith("---\r\n")) {
    throw new FrontmatterError("缺少 Frontmatter 起始标记 ---");
  }

  const endMatch = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!endMatch) {
    throw new FrontmatterError("Frontmatter 结束标记缺失或格式错误");
  }

  const yamlText = endMatch[1];
  if (yamlText.length > maxBytes) {
    throw new FrontmatterError(`Frontmatter 超过 ${maxBytes} 字节`);
  }

  let doc;
  try {
    doc = YAML.parseDocument(yamlText, {
      maxAliasCount: MAX_ALIAS_COUNT,
      strict: true,
    });
  } catch (err) {
    throw new FrontmatterError(`YAML 解析失败: ${err.message}`, { cause: err });
  }

  rejectCustomTags(doc.contents);

  if (doc.errors.length > 0 || doc.warnings.length > 0) {
    const messages = [...doc.errors, ...doc.warnings].map((e) => e.message || e).join("; ");
    throw new FrontmatterError(`YAML 解析错误: ${messages}`);
  }

  let data;
  try {
    data = doc.toJSON();
  } catch (err) {
    throw new FrontmatterError(`Frontmatter 序列化失败: ${err.message}`, { cause: err });
  }

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new FrontmatterError("Frontmatter 必须是对象");
  }

  return { data, rawFrontmatter: endMatch[0] };
}

export function extractBody(raw, frontmatterBlock) {
  return raw.slice(frontmatterBlock.length).trim();
}
