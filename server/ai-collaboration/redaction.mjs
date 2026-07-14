const SENSITIVE_KEY_RE = /^(?:(?:[a-z0-9]+[-_])*(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|x[-_]?api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|secret|password|passwd))$/i;

const INLINE_ASSIGNMENT_RE = /\b((?:[A-Za-z0-9]+[-_])*(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|api[-_]?key|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|passwd))\s*([:=])\s*(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const COMMON_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AIza[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g;
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi;

export const REDACTED_VALUE = "[REDACTED]";

export function redactSensitiveString(value) {
  return String(value)
    .replace(PRIVATE_KEY_BLOCK_RE, REDACTED_VALUE)
    .replace(INLINE_ASSIGNMENT_RE, (_match, key, separator) => `${key}${separator}${REDACTED_VALUE}`)
    .replace(BEARER_RE, `Bearer ${REDACTED_VALUE}`)
    .replace(COMMON_TOKEN_RE, REDACTED_VALUE);
}

/**
 * Produces a JSON-safe redacted copy for events and diagnostics. It never
 * mutates the caller's object and deliberately does not preserve prototypes.
 */
export function redactAiLogValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactSensitiveString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<Buffer ${value.byteLength} bytes>`;

  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => redactAiLogValue(entry, seen));
      const result = {};
      for (const [key, entry] of Object.entries(value)) {
        result[key] = SENSITIVE_KEY_RE.test(key)
          ? REDACTED_VALUE
          : redactAiLogValue(entry, seen);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }

  return redactSensitiveString(value);
}
