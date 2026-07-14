# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable product decisions

- The product shell is named `自媒体增长驾驶舱`; `AI 应用内容 · 两个月全平台净增 5 万粉` is the current user's campaign, not the permanent product category.
- Dogfood the single-user local workflow before adding multi-user, authentication, cloud hosting, or generic creator configuration. Productize only patterns proven in the current campaign.
- The cockpit is desktop-browser first; optimize information density and hierarchy for 1440px, 1280px, and 1024px desktop widths.
- Keep global navigation and page headers focused on business decisions. Do not surface implementation commentary such as source-file paths, index counts, read-only connection state, or demo-mode labels in the default workspace.
- Preserve contextual warnings next to actions whose result is only local or does not write back to Obsidian; these warnings prevent the interface from implying persistence that does not exist.
- Treat the dated Obsidian file under `07-每日任务/` as the single authority for “今日三件事”; dashboard edits must use the guarded local API, and external Obsidian edits must flow back without silent last-write-wins.
- Treat `01-目标与验收.md` as the single authority for action-target numbers and the campaign start timestamp. The dashboard may edit only the five fixed target values and may record the one-time official start; completion counts must remain zero before that start.
- Version 2.0 has five product-level destinations: `增长总览 / 内容工作台 / 复盘与对标 / 每日复盘 / 资产检索`. Tasks and Agents are execution attributes, not top-level product modules.
- Freeze the Growth Overview around four compact sections: outcome target, action targets, the configured platform-account band, and Today's Three. Do not add inventory summaries or technical status cards back to this page.
- The content workbench has exactly three phases: `选题 / 发布 / 复盘`. Do not reintroduce a `制作` phase or the statuses `调研中 / 创作中`.
- The north-star metric is net-new followers after campaign start, not total follower count. Baseline, growth target, and success total must come from the active Vault settings and account evidence; never hard-code the current user's numbers in product logic.
- Platform follower edits must write only the current follower values and data date in the account registry. The initialized baseline evidence stays immutable.
- “打开原文” must use the same-origin local API and server-side Obsidian URI launch; do not rely on a browser anchor with a custom URI scheme.
- A publication counts toward campaign actions only when it is after the official start and its record includes a full publication timestamp, `verification: 已核验`, and either an HTTPS URL or an explicit evidence reference. A manually selected `已发布` status is never sufficient.
- Browser-created topics and content edits must persist to the guarded V2 content API. Do not reintroduce localStorage as the authority for the content pipeline.
- Reviews use two user-facing tabs (`内容复盘 / 账号拆解`). Asset search spans content, knowledge, project, review, method, judgment, and raw-material assets without exposing local filesystem paths.
- Daily review is an independent page and asset type under `60-数据与看板/05-经营看板/每日复盘`; only an explicitly confirmed daily review counts toward the review action target. Single-content reviews never increment that target.
- Both review tabs need a visible create action. A content review creates a V2 review note linked to an existing content asset or a verified publication URL; an account breakdown creates a V2 breakdown note from an account profile URL. Browser-only records are not acceptable.
- Removing a topic from the active content workbench is a reversible archive action, never a hard delete. Archived topics leave the active board, remain recoverable through an archive filter, and must not require publication evidence.
- AI collaboration is a structured local ACP client for the user's real installed CLIs, not a browser terminal and not a one-shot prompt form. One conversation keeps one Provider and one Agent session across multiple turns; plans, tools, diffs, and terminal-level details stay folded unless needed.
- The AI workspace should feel like a durable Claudian-style collaborator: the empty state is already a conversation with a bottom composer, the first free-form message creates the session, and a Vault asset is an optional context chip rather than a mandatory task-start form. Borrow this interaction anatomy, not Claudian's visual styling.
- Browser refreshes must reattach to the authoritative conversation without killing a live CLI process. Cancelling stops only the active turn; a failed or cancelled turn must not destroy earlier conversation history.
- AI conversation results never write to Obsidian automatically. The user must explicitly accept one completed turn, and the server must verify that turn's authoritative output hash before the confirmed import. Accepting or importing one result does not automatically end the long-running conversation.
- CLI version messaging must distinguish the locally installed version, the cockpit's tested version, and the upstream latest version. Never hot-upgrade an active conversation or imply that an untested latest release is supported.
- The local AI environment center is macOS-first. Detect installed CLIs before offering actions; install, update, and login always require an explicit user click and confirmation.
- Environment actions use a server-side official allowlist only. The browser must never supply executable paths, shell commands, package names, script URLs, or arbitrary arguments.
- Keep environment management out of the main conversation flow. Open it from a compact `管理本机 AI` control near the provider selector, and refresh provider state automatically after a completed action.
- New product UI uses `Antigravity`; legacy `gemini` remains a history-only provider identifier so old conversations and run records stay readable. Never offer legacy Gemini CLI for a new conversation.
- Antigravity conversations use its official print/conversation CLI contract in plan+sandbox mode and are readonly until a documented per-operation permission channel exists.
- Never install or update a provider while it owns a live conversation process. Login opens a fixed local terminal flow and returns to explicit environment re-detection.
