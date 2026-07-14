export function parseMarkdownTable(body) {
  const lines = body.split(/\r?\n/);
  const tables = [];
  let current = [];
  let inTable = false;
  let dividerPassed = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (!inTable) {
        inTable = true;
        current = [trimmed];
        dividerPassed = false;
      } else {
        if (!dividerPassed && /^\|[-:\s|]+\|$/.test(trimmed)) {
          dividerPassed = true;
        } else if (dividerPassed) {
          current.push(trimmed);
        } else {
          // 表头后没有分隔行，丢弃
          current = [];
          inTable = false;
        }
      }
    } else {
      if (inTable && current.length > 0) {
        tables.push(current);
      }
      inTable = false;
      current = [];
      dividerPassed = false;
    }
  }
  if (inTable && current.length > 0) tables.push(current);

  return tables.map((rows) => {
    const cells = rows.map((row) =>
      row
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim())
    );
    const headers = cells[0];
    const dataRows = cells.slice(1).filter((r) => r.some((c) => c !== ""));
    return { headers, rows: dataRows };
  });
}

export function parseNumberListSection(body, sectionTitle) {
  const lines = body.split(/\r?\n/);
  const results = [];
  let inSection = false;
  let headingDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const title = headingMatch[2].trim();
      if (title === sectionTitle) {
        inSection = true;
        headingDepth = depth;
        continue;
      }
      if (inSection && depth <= headingDepth) {
        break;
      }
      continue;
    }
    if (inSection) {
      const itemMatch = line.match(/^\s*\d+\.\s*(.+)$/);
      if (itemMatch) {
        results.push(itemMatch[1].trim());
      }
    }
  }
  return results;
}

export function extractFirstHeading(body) {
  const match = body.match(/^#{1,6}\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

export function normalizePlatformDisplay(platform) {
  if (typeof platform !== "string") return "";
  // B站 / B 站 统一显示为 B 站
  return platform.replace(/B\s*站/, "B 站");
}

export function toIdSlug(text) {
  return text
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
