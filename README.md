# 自媒体增长驾驶舱

面向自媒体创作者的本地增长决策与 AI 协作界面。创作定位、目标名称、涨粉目标、日期、账号和项目目录均来自使用者自己的 Obsidian V2；v0.6.1 包含增长总览、内容工作台、复盘与对标、每日复盘、AI 协作、资产检索六个入口。今日任务、行动目标、内容资产和复盘资产通过受控接口双向同步；AI 协作已从一次任务升级为可恢复的本机 CLI 多轮会话，接受结果不会写入 Obsidian，只有再次确认导入才进入项目工作过程。

## 当前阶段

- 当前运行方式仍是本机单用户，但产品名称、使用者、创作定位、增长计划和平台账号已经配置化，不再写死为「AI 博主 · 两个月 5 万粉」。
- 先用真实内容生产与增长周期跑通工作流，再决定哪些配置值得抽象给其他创作者。
- 当前不包含多用户、登录、云端托管或平台数据自动抓取；公开仓库只包含程序源码和示例配置，个人内容数据仍只保留在本机。
- AI 协作先检测本机 CLI。已安装并登录的工具直接可选；缺失、过期或需要登录时，用户可在“管理本机 AI”中点击并确认固定官方操作。驾驶舱不读取或保存 CLI 凭证。

## 环境要求

- Node.js 24.14.0（执行 `nvm use` 采用仓库固定版本；不要混用不同 Node 主版本编译原生依赖）
- npm 11.9.0（见 `packageManager`）
- AI 协作按需使用本机 `codex`、`claude`、`kimi`、`agy`（Antigravity）或 `grok`；缺失的 CLI 不影响其他驾驶舱模块。旧 `gemini` 只用于读取历史记录，不再作为新会话选项

## 安装

```bash
nvm use
npm ci
```

已有 `v0.1.0` 实例先阅读 [MIGRATION.md](./MIGRATION.md)，不要在旧 Vault 上运行新用户初始化脚本。

### 给另一位使用者初始化

初始化不会复制现有个人数据，也不会把 Obsidian Vault 放进 Git。先准备独立的空 V2，再复制并修改模板：

```bash
cp .env.example .env
cp setup.example.json setup.local.json
```

在 `.env` 填写新 Vault 和本地状态目录的绝对路径，在 `setup.local.json` 填写真实的使用者名称、创作定位、增长计划、账号、粉丝基线和证据说明，并替换 `2000-01-01` 示例日期。模板包含两个账号示例，可保留 1—6 个真实账号。`v0.2.0` 仅支持小红书、公众号、B 站、抖音、视频号和 X，且每个平台一个账号；初始化器和索引器都会拒绝产品尚未支持的平台，避免出现“初始化成功但内容无法登记”的半可用状态。

```bash
npm run setup:vault -- --config ./setup.local.json
npm run index
npm run validate:data
npm run dev
```

初始化使用“只创建、不覆盖”策略：任何权威文件已存在都会停止，避免覆盖另一位使用者的资产。`setup.local.json` 和 `.env` 含本机信息，不应提交到 Git。

## 启动

```bash
npm run dev
```

默认仅绑定本机 `http://127.0.0.1:5173`。`predev` 会自动重建 V2 索引。

固定使用本次验收端口：

```bash
npm run dev -- --host 127.0.0.1 --port 4173
```

### 可选：macOS 常驻运行

仓库本身不会修改系统启动项。需要常驻时，可自行建立 LaunchAgent，以 `RunAtLoad + KeepAlive` 启动 `npm run dev -- --host 127.0.0.1 --port 4173 --strictPort`。启动前应先重建并校验索引；移动项目目录或更换 Node.js 路径后，需要同步更新 LaunchAgent。当前开发实例的运行日志位于 `~/.media-growth-cockpit/logs/`。

## 构建

```bash
npm run typecheck
npm run test
npm run test:server
npm run test:indexer
npm run verify:v05:agent -- --provider=codex
npm run verify:v06:conversation -- --provider=codex
npm run verify:v061:antigravity
npm run index
npm run validate:data
npm run build
npm audit --audit-level=high
```

## 脚本说明

- `npm run dev`：本地开发服务器（启动前自动 `npm run index`）
- `npm run build`：生产构建（构建前自动 `npm run index` 与 `npm run validate:data`）
- `npm run typecheck`：TypeScript 类型检查
- `npm run test`：前端单元测试（Vitest，范围 `src/`）
- `npm run test:server`：每日任务、行动目标、内容与复盘资产、AI 运行与导入 API、跨模块流程、并发冲突、回滚、目录监听和网络边界测试
- `npm run test:indexer`：索引器安全与数据测试（Node Test Runner，范围 `scripts/tests/`）
- `npm run probe:agents`：逐个启动五个本机 Agent 做最小真实连接验证；ACP Provider 走 ACP，Antigravity 走官方会话接口；不写入 Vault，也不自动升级或登录
- `npm run verify:v05:agent -- --provider=codex`：在隔离临时 Vault 中真实完成一次“今日任务 → 本机 Agent → 内容草稿 → 权威回读”；不写入个人 Vault
- `npm run verify:v06:conversation -- --provider=codex`：在隔离临时 Vault 中真实完成三轮 Codex 会话、服务重启恢复、接受不写入、确认导入、导入后继续和显式关闭进程回收；不写入个人 Vault
- `npm run verify:v061:antigravity`：在隔离临时工作区中真实完成两轮 Antigravity 会话，验证第二轮恢复首轮随机标记且工作区未被写入
- `npm run setup:vault -- --config ./setup.local.json`：为一个新的本地使用者创建最小 V2、账号注册表、粉丝基线、目标文件与设置文件
- `npm run index`：从 V2 生成 `index.json` 与 `build-report.json`
- `npm run validate:data`：校验 canonical 与 public 副本、数据断言与安全规则
- `npm run preview`：预览生产构建

## V2 路径与产物

- V2 默认根：`~/第二大脑-v2`；推荐通过 `.env` 的 `V2_VAULT_ROOT` 指定，也兼容通用变量 `OBSIDIAN_VAULT_ROOT`
- 权威索引：`~/.media-growth-cockpit/index.json`
- 构建报告：`~/.media-growth-cockpit/build-report.json`
- AI 运行查询库：`~/.media-growth-cockpit/ai-runs.sqlite`
- AI 任务证据目录：`~/.media-growth-cockpit/ai-runs/`
- AI 长期会话目录：`~/.media-growth-cockpit/ai-conversations/`（Agent 工作区与 manifest、session、turn、事件分离；权威原文副本位于 `workspace/inputs`）
- 前端副本：`public/data/index.json`
- 副本关系：`public/data/index.json` 是 `index.json` 的字节一致副本，唯一权威源是 `~/.media-growth-cockpit/index.json`

## 驾驶舱设置

- 页面右上角设置按钮可编辑：产品名称、使用者名称、创作定位、目标名称、净增粉目标、开始日期和截止日期。
- 保存后写入 `99-系统/自媒体驾驶舱/驾驶舱设置.md`；页面显示与索引计算共用这一份权威设置。
- API：`GET/PUT /api/cockpit-settings`，使用文件哈希防止网页与 Obsidian 同时修改时静默覆盖。
- 显示名称的修改不会自动重命名已有项目目录。另一位使用者首次接入时，应通过初始化配置确定 `projectRelativeDir` 和粉丝基线文件；这两个内部路径不在日常设置弹窗中暴露。
- 平台账号及当前粉丝在增长总览中维护，保存到 `40-业务资产/01-定位与公司说明/平台账号注册表.md`；账号基线仍保留为不可变证据。

## 数据口径

- 启动基线、净增粉目标与达标总粉丝全部从当前 Vault 的设置和账号证据派生；仓库不固定任何使用者的粉丝数字
- 当前粉丝与涨粉进度从平台账号注册表实时派生，不在产品逻辑或测试中固定当前值
- 内容行动从产品正式上线时开始统计，历史内容不计入当前内容流水线
- 五项行动的目标数字由用户设置；完成数只从项目期内满足证据条件的真实资产派生。文章、视频按制作完成事实统计，发布按平台发布事实统计
- 待人工确认的复盘与拆解可进入工作台，但不会提前计入行动完成数；复盘目标只统计已确认的每日整体复盘
- 平台目标粉丝与截止日期均显示「待分配 / 待确认」

## 当前限制

- 粉丝基线日期、计划周期和账号集合以每位使用者的初始化配置为准；日常设置不会改写既有基线证据。
- “今日三件事”以当天 Obsidian 文件为权威源；网页写入立即保存，Obsidian 外部修改通过单一事件通道即时回流。
- 行动目标以 `01-目标与验收.md` 为权威源，网页可编辑目标数字并写回 Obsidian。
- 用户点击“正式开始统计”并二次确认后，服务端才记录项目开始时间；开始前不存在初始完成数。
- 平台当前粉丝数可在目标进度标题行直接修改；保存后写回 `平台账号注册表.md`，基线文件保持不变，净增粉由当前总粉丝减基线自动计算。
- 内容工作台的新建选题、状态、形态、平台、下一步和截止日期已写入 V2；标题与正文仍需在 Obsidian 原文中编辑。
- 选题的“移入归档”是可恢复操作，不物理删除 Markdown；默认工作台不显示归档内容，可通过状态筛选恢复。
- 内容复盘与账号拆解可在网页新建并写入 V2；卡片可直接确认，确认时写入完整的 `confirmed_at`。已确认资产再次编辑会自动回到待人工确认，避免修改后的内容沿用旧确认。
- 每日整体复盘有独立页面和文件类型；单条内容复盘继续作为知识资产，但不增加“复盘”行动完成数。
- AI 协作支持一个 Conversation 内持续多轮沟通、刷新后回读、服务重启后按 Provider 能力恢复、接受本轮和再次确认导入。多 Agent 自动分工、自动发布、永久授权和网页终端仍不在当前范围。
- 本机 AI 环境管理首版只支持 macOS。安装和更新使用服务端固定的官方来源；浏览器不能提交命令、包名、脚本地址、参数或可执行路径。登录在本机 Terminal 中完成，驾驶舱只提示重新检测。
- V0.6 当前按本人本机单用户 Alpha 交付，默认使用只读协作。真实长期会话专项验收只覆盖 Codex；其他已检测 Provider 尚未完成同等三轮、恢复与交付认证，不对外承诺完整兼容。
- 当前只保留两个热会话连接；不支持 `session/resume` 的 Provider 被回收或服务重启后，历史仍可查看，但隐藏上下文无法无损续接。超长会话的分页、SSE 背压和宿主崩溃后的孤儿进程回收属于后续稳定化范围。

## 安全边界

- 索引器使用固定 V2 根，拒绝绝对路径、NUL、`..`、软链接与目录软链接。
- 单文件上限 1 MiB；Frontmatter 拒绝重复键、自定义 tag 与 alias bomb。
- 敏感内容、Token/Cookie/Bearer/GitHub token 不进入索引。
- 只接受 `https:` URL，拒绝 `javascript:` / `data:` / `file:`。
- 普通索引摘要保持纯文本；AI 回复使用 Markdown 语法树渲染，禁用原始 HTML、远程图片和非 HTTP(S) 链接，全站不使用 `dangerouslySetInnerHTML`。
- canonical、public 副本和 build-report 先分别写入同目录临时文件，再整体提交；任一步失败都会恢复三份上一版。
- canonical/build-report 权限为 `0600`，public 副本为 `0644`。
- 写接口只监听回环地址，拒绝非同源 Origin、恶意 Host、非 JSON、超大请求和任意日期/路径参数。
- 每日任务只允许写入项目下的 `07-每日任务`，拒绝路径穿越、目录软链接和文件软链接。
- 行动目标只允许修改项目下固定的 `01-目标与验收.md`，客户端不能提交文件路径或改变动作定义。
- 内容资产只允许新建到 `30-内容资产/00-选题池`，更新时只能按服务端解析出的资产 ID 修改白名单字段；客户端不能提交文件路径、标题或正文。
- 复盘资产只允许写入 `20-知识资产/03-复盘`；关联内容必须解析成 V2 内真实 Markdown，待确认与已确认状态必须一致。
- 每日复盘只允许写入 `60-数据与看板/05-经营看板/每日复盘`，每个日期最多一份，确认前六个复盘字段必须完整。
- 写入使用 SHA-256 乐观锁、单文件串行队列、同目录原子替换、外部备份和无正文审计日志。
- 写后必须重建并校验索引；失败时恢复修改前文件并重建旧索引。
- 状态根、备份父目录和审计父目录会拒绝软链并在写前、写后复验 realpath；最终状态文件使用 `O_NOFOLLOW`。威胁模型覆盖静态路径篡改与意外配置，不支持本机同一用户的恶意进程持续竞态抢占文件路径。
- 同一 Node.js 进程内，所有写入按权威文件或资产目录共享串行队列；同一旧哈希的并发保存只允许一个成功，另一方返回 409。当前版本不支持两个驾驶舱服务同时连接同一个 Vault，启动时必须使用 `--strictPort` 保证单服务实例。
- AI 协作服务只允许五个固定 Provider 和服务端解析的绝对可执行路径，使用 `shell:false`，Prompt 不经 shell 插值，子进程仅继承最小环境变量。
- 浏览器只提交资料类型和资产 ID；服务端从权威索引解析真实 Markdown 与哈希，复验常见云端密钥与私钥后，再复制白名单内原文到会话 `workspace/inputs`。每轮开始前重新核验输入副本的文件集合、大小和哈希；Agent 的工作目录与 manifest、session、turn、事件等控制文件分离。Codex 与 Claude Code 使用 ACP 只读/计划模式；Antigravity 使用官方 `plan + sandbox + conversation` 会话；Kimi、Grok 仅开放分析并拒绝写入权限请求，其只读约束仍不是系统级文件隔离。
- 环境操作 API 只接受回环、同源、带 CSRF 标记的固定 Provider 与动作。安装或更新结束后会重新探测真实 CLI；未检测到新版本不会报告成功。拥有未关闭会话的 Provider 不能热更新。
- AI 子进程仍以本机登录用户身份运行，独立任务目录不能阻止恶意进程访问其他本机文件。当前版本只适合本人在本机、可见操作下使用，不开放公网，也不把未知脚本交给 Agent 执行。
- V0.4/V0.5 Run 的事件、SQLite 查询索引和导入审计会脱敏；V0.6 Conversation 以独立目录中的 manifest、session、turn JSON 和有界 JSONL 事件为权威记录，不依赖 SQLite。全局最多两个长期 Agent 连接；服务重启时活动 Turn 明确失败，已完成历史和可恢复 Session 保留。
- AI 结果只有在页面二次确认后才原子新建到项目工作过程；疑似凭证、可执行 HTML、越界路径、软链接和超过 2 MiB 的结果全部拒绝，索引失败会删除新文件并复验回滚。
- 任务业务交付只允许新建到内容、复盘或下一日任务白名单；正文固定来自服务端保存的 Agent 最终结果。来源漂移、目标内容哈希变化、路径或软链接异常都会阻断交付，不会自动完成任务或修改行动计数。
- 业务成果落盘后若运行清单暂时未记录或不可读，驾驶舱会保留带交付哈希的成果并提示重试；相同请求只会认领原成果，不会重复创建，也不会用路径删除不确定文件。

## AI 协作工作台

- 页面：`/ai`
- Agent 状态：`GET /api/ai-agents`
- 环境操作：`POST /api/ai-environment/actions`（只接受固定 Provider 与 `install/update/login`）
- 环境任务状态：`GET /api/ai-environment/actions/:jobId`
- 长期会话：`GET/POST /api/ai-conversations`、`GET /api/ai-conversations/:conversationId`
- 后续消息：`POST /api/ai-conversations/:conversationId/turns`
- 会话快照：`GET /api/ai-conversations/:conversationId/events`（SSE，只发送完整权威快照）
- 接受本轮：`POST /api/ai-conversations/:conversationId/accept`（不写入 Vault）
- 确认导入：`POST /api/ai-conversations/:conversationId/import`（只写项目 `03-工作过程/AI协作`）
- 关闭会话：`POST /api/ai-conversations/:conversationId/close`
- 运行：`GET/POST /api/ai-runs`、`GET /api/ai-runs/:runId`
- 实时事件：`GET /api/ai-runs/:runId/events`（SSE，不做秒级轮询）
- 一次性授权：`POST /api/ai-runs/:runId/permissions/:permissionId`
- 取消：`POST /api/ai-runs/:runId/cancel`
- 人工导入：`POST /api/ai-runs/:runId/import`
- 业务交付：`POST /api/ai-runs/:runId/deliveries`
- 固定任务：选题判断、内容拆解、文章草稿提案、视频草稿提案、内容复盘、账号拆解、每日总结、明日计划。
- Codex 与 Claude Code 通过仓库内固定版本的 ACP 适配器接入；Kimi 和 Grok 使用各自原生 ACP/stdio 入口；Antigravity 使用官方打印与会话恢复接口。页面区分本机版本、驾驶舱已验证版本与当前上游版本，只有用户点击确认后才安装或更新。
- 2026-07-14 的 V0.6.1 本机验证中，五个 Provider 均通过安装、版本与登录状态探测；Antigravity 1.1.2 完成两轮真实会话并在第二轮恢复首轮上下文。V0.6 全量三轮、恢复、导入与回收专项仍只对 Codex 做发布保证。
- AI 调用边界见 [docs/V0.4-AI-COLLABORATION.md](./docs/V0.4-AI-COLLABORATION.md)；今日任务成果闭环见 [docs/V0.5-AI-TASK-LOOP.md](./docs/V0.5-AI-TASK-LOOP.md)；长期会话合同见 [docs/V0.6-INTERACTIVE-AI-WORKBENCH.md](./docs/V0.6-INTERACTIVE-AI-WORKBENCH.md)；本机环境管理见 [docs/V0.6.1-AI-ENVIRONMENT-CENTER.md](./docs/V0.6.1-AI-ENVIRONMENT-CENTER.md)。

## 今日任务双向同步

- API：`GET/PUT /api/daily-tasks`
- 日期由服务端按 `Asia/Shanghai` 计算，客户端不能提交日期或文件路径。
- 权威文件：`{projectRelativeDir}/07-每日任务/YYYY-MM-DD-今日三件事.md`
- 最多三条；任务 ID 写在隐藏 Markdown 注释中，Obsidian 正常阅读不受影响。
- 页面不做周期轮询；服务端监听权威目录，外部修改经短暂合并后重建索引并通过 SSE（服务器发送事件）通知页面。页面重新获得焦点时会补拉一次，版本冲突返回 409，不静默覆盖。

## 行动目标双向同步

- API：`GET/PUT /api/action-targets`
- 权威文件：`{projectRelativeDir}/01-目标与验收.md`
- 固定动作：文章、视频、发布、复盘、账号拆解；用户只能修改正整数目标或留空。
- 完成数从正式开始时间之后计算；开始前固定为 0，不接受初始值或手工校准。
- 文章和视频以完整的 `completed_at` 为制作完成事实，同一 `family_id` 在项目期内只计一次；旧内容若已有有效发布记录，可由最早发布时刻兜底推导完成时刻。
- 发布记录只有同时具备完整发布时间、`verification: 已核验`，以及 HTTPS URL 或 `evidence_ref` 时才计数；相同 URL 或相同证据组合不会重复计数。
- 手动修改自由文本或普通状态不会增加文章、视频或发布完成数；缺证据的卡片显示「待核验」。
- “复盘”完成数使用 `confirmed_daily_reviews`：只按项目开始后的每日整体复盘 `confirmed_at` 计数；旧 `confirmed_content_reviews` 会在索引读取时兼容转换，下一次目标保存会写回新口径。
- 使用文件哈希冲突检测、同目录原子替换、外部备份与无正文审计日志；更新失败恢复旧文件，新建失败保留可认领成果。

## 内容资产双向同步

- API：`GET/POST/PUT /api/content-assets`、`POST /api/content-assets/complete`、`POST /api/content-assets/publications`
- 新建选题只进入 `30-内容资产/00-选题池`，由服务端生成安全文件名和资产 ID。
- 网页只可修改状态、形态、发布平台、优先级、截止日期和下一步；正文与未知 Frontmatter 原样保留。
- “标记制作完成”由服务端写入 `completed_at`；“登记发布”必须提交平台、完整发布时间和 HTTPS URL 或 V2 证据引用，并经过人工确认。登记发布会在缺少完成事实时自动补记完成，随后重建索引回算行动进度。
- 归档不要求发布证据；进入“已发布”或“待复盘”仍必须有已核验发布记录。
- Vite 服务统一监听内容、复盘、每日任务、行动目标与平台粉丝五个权威区域；Obsidian 外部修改会重建索引，并通过同一个 SSE 通道按资源通知页面。
- 使用文件哈希冲突检测、串行写入、原子替换、外部备份与审计日志；更新失败恢复旧文件，新建失败保留可认领成果。

## 复盘资产双向同步

- API：`GET/POST/PUT /api/review-assets`
- 内容复盘必须关联一个真实内容资产并保持 `related_content_id` 与 `derived_from` 完全一致，或提供 HTTPS 发布链接；账号拆解必须提供 HTTPS 账号或代表作品链接。URL 只作为人工确认的证据入口，不推测网络可达性。
- 新建资产固定为 `status: 待确认`、`confirmation: 待人工确认`、`confirmed_at: null`；填写核心发现和下一步后才可确认，确认时写入完整 ISO 时间。
- 待确认卡片可直接确认；已确认内容再次编辑时，服务端会清空旧 `confirmed_at` 并重新进入待人工确认。
- 读取、更新、确认和索引都会重新校验状态三字段与关联证据；损坏资产会显式报错且不计入行动完成数。
- 关联内容会写成可解析的 Obsidian `derived_from` 链接；URL 场景不伪造内部 wikilink。
- 摘要、核心发现和下一步不接受以 `##` 开头的 Markdown 标题，避免破坏复盘文件的固定章节结构。
- 网页与 Obsidian 通过 `review-assets` SSE scope 即时回流，并使用哈希冲突保护、备份和审计；更新失败恢复旧文件，新建失败保留可认领成果。

## 每日复盘双向同步

- API：`GET/POST/PUT /api/daily-reviews`
- 权威目录：`60-数据与看板/05-经营看板/每日复盘`
- 表单固定记录日期、今日完成、数据与事实、有效动作、问题、今日判断、明日最重要动作；同一天只能有一份。
- 新建记录先保存为待人工确认；六项填写完整后才能确认并写入 `confirmed_at`。编辑已确认记录会自动重开待确认。
- 只有项目期内已确认的每日复盘增加“复盘”行动完成数，内容复盘不重复计数。

## Obsidian 原文打开

- 内容工作台、复盘与对标、资产检索统一使用 `POST /api/open-obsidian`。
- 服务端只接受 V2 内存在的 Markdown 相对路径，拒绝绝对路径、路径穿越、软链接、缺失文件和非同源请求。
- 服务端通过 Obsidian 官方 `obsidian://open?path=` 协议唤起桌面应用，避免浏览器拦截自定义协议导致按钮无响应。

## 项目结构

```text
scripts/
├── build-vault-index.mjs   # 只读索引器
├── validate-data.mjs       # 数据校验器
├── lib/                    # 解析、安全工具
└── tests/                  # 索引器测试
server/
├── agent-catalog.mjs       # 五个本机 CLI 的安装、版本与 ACP 能力检测
├── ai-agents-api.mjs       # Agent 状态本机 HTTP API
├── ai-runs-api.mjs         # AI 任务、SSE、授权、取消与导入 API
├── ai-conversations-api.mjs # 长期会话、Turn、接受、导入与关闭 API
├── ai-collaboration/       # ACP runner、单次运行与长期会话编排、工作区与安全导入
├── action-targets-store.mjs # 行动目标白名单写入、备份与回滚
├── action-targets-api.mjs   # 行动目标本机 HTTP API
├── content-assets-store.mjs # 内容资产扫描、白名单写入、备份与回滚
├── content-assets-api.mjs   # 内容资产本机 HTTP API
├── review-assets-store.mjs  # 内容复盘与账号拆解写入、确认与回滚
├── review-assets-api.mjs    # 复盘资产本机 HTTP API
├── daily-reviews-store.mjs # 每日整体复盘写入、确认与回滚
├── daily-reviews-api.mjs   # 每日整体复盘本机 HTTP API
├── daily-tasks-store.mjs   # 白名单文件读写、备份、冲突与回滚
├── daily-tasks-api.mjs     # 本机 HTTP API
├── vite-plugin.mjs         # Vite dev / preview 接入
└── tests/                  # 服务端安全测试
src/
├── app/                    # 路由与页面
├── components/ui/          # 通用 UI 组件
├── data/                   # 前端适配器与 Schema
├── styles/                 # 设计 Token 与全局样式
├── tests/                  # 单元测试
└── types/                  # TypeScript 类型
public/data/index.json      # 前端构建副本
qa/screenshots/             # 浏览器验收截图与对照图
design-qa.md                # 设计验收记录
```

## 最终完成状态

- V2 索引器：完成（白名单、受控动态扫描、每日任务优先读取、Frontmatter/YAML 校验、过滤、原子产物、build-report）
- 前端 V2 适配器：完成（`useWorkbenchIndex` + `WorkbenchIndexProvider`）
- 六个产品模块全部从索引或受控 API 读取：完成
- 移除 `src/data/demo.ts` 中无证据业务内容：完成
- 桌面工作台构图：完成（1280×720、1440×900、1728×900）
- 右栏与详情抽屉替换、焦点返回、Esc 关闭：完成
- 今日三件事双向同步：完成（网页写入、Obsidian 回流、冲突、备份、回滚）
- 行动目标双向同步：完成（目标可编辑，完成数自动统计，Obsidian 回流、冲突、备份、回滚）
- 内容工作台 2.0：完成（三阶段同屏；彻底移除制作环节；新建、可恢复归档、字段写回、Obsidian 回流与冲突保护）
- 复盘与对标：完成（内容复盘与账号拆解均可新建、编辑、确认并写回 Obsidian）
- 每日复盘：完成（独立页面、按日期新建、编辑、确认、Obsidian 回流与行动目标计数）
- AI 协作：完成 V0.6.1 本机长期会话与环境管理闭环；Codex 有独立真实三轮验收脚本，Antigravity 有真实两轮上下文恢复验证，其余 Provider 不宣称已经通过 V0.6 全套认证
- 资产检索：完成（内容、知识、项目与待确认资产统一检索）
- 索引器安全与数据测试：完成（以当前测试命令结果为准）
- 服务端安全与跨模块流程测试：完成（以当前测试命令结果为准）
- 前端测试：完成（以当前测试命令结果为准）
- 浏览器六个业务路由与关键交互验收：完成（控制台错误与警告 0）
- 本机常驻服务与异常恢复：完成（登录自动启动、进程退出自动拉起、SSE 重连）
- 依赖安全扫描：完成（0 个已知漏洞）
- `design-qa.md`：`final result: passed`
- `typecheck` / `test` / `test:server` / `test:indexer` / `index` / `validate:data` / `build`：全部通过
