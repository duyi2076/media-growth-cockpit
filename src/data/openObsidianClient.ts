export class OpenObsidianApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function openInObsidian(source: string) {
  const response = await fetch("/api/open-obsidian", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });
  const payload = await response.json().catch(() => null) as { opened?: boolean; message?: string } | null;
  if (!response.ok || payload?.opened !== true) {
    throw new OpenObsidianApiError(payload?.message ?? "无法打开 Obsidian 原文", response.status);
  }
}
