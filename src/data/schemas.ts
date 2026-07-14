import { z } from "zod";

export const platformAccountSchema = z.object({
  id: z.string(),
  platform: z.string(),
  account: z.string(),
  displayName: z.string(),
  handle: z.string(),
  profileUrl: z.string().url(),
  baselineFollowers: z.number().int().min(0),
  currentFollowers: z.number().int().min(0),
  followerGrowth: z.number().int(),
  targetFollowers: z.null(),
  gap: z.null(),
  asOf: z.string(),
  sourceEvidence: z.string(),
  active: z.boolean(),
});

export const growthSummarySchema = z.object({
  baselineFollowers: z.number().int().min(0),
  currentFollowers: z.number().int().min(0),
  gainedFollowers: z.number().int(),
  growthTarget: z.number().int().positive(),
  growthGap: z.number().int().min(0),
  expectedFollowers: z.number().int().positive(),
  completionRate: z.number().min(0).max(1),
  asOf: z.string(),
  startDate: z.string().nullable(),
  deadline: z.string().nullable(),
  campaignStartedAt: z.string().datetime().nullable(),
});

export const actionTargetSchema = z.object({
  id: z.enum([
    "article-output",
    "video-output",
    "platform-publish",
    "content-review",
    "account-breakdown",
  ]),
  label: z.string(),
  current: z.number().int().min(0),
  target: z.number().int().min(1).max(1_000_000).nullable(),
  unit: z.string(),
  completionRate: z.number().min(0).nullable(),
});

export const contentStatusSchema = z.enum([
  "候选选题",
  "已立项",
  "待发布",
  "已发布",
  "待复盘",
  "已归档",
]);

export const contentFormatSchema = z.enum(["文章", "短视频口播", "图文卡片", "直播稿", "系列"]);

export const prioritySchema = z.enum(["P0", "P1", "P2", "P3"]);

export const contentItemSchema = z.object({
  id: z.string(),
  familyId: z.string(),
  title: z.string(),
  summary: z.string(),
  status: contentStatusSchema,
  format: contentFormatSchema,
  channels: z.array(z.string()),
  priority: prioritySchema.nullable(),
  dueAt: z.string().nullable(),
  source: z.string(),
  nextAction: z.string(),
  evidenceStatus: z.enum(["有证据", "部分证据", "待补充"]),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});

export const taskStatusSchema = z.enum(["待办", "进行中", "阻塞", "待验收", "已完成"]);
export const taskTypeSchema = z.enum(["人工任务", "Agent 任务", "人机协作任务"]);
export const taskSourceKindSchema = z.enum(["vault", "local-demo"]);
export const taskExecutionModeSchema = z.enum(["read-only", "simulated"]);

export const taskItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  status: taskStatusSchema,
  type: taskTypeSchema,
  priority: prioritySchema.nullable(),
  assignee: z.string(),
  assignedAgent: z.string().nullable(),
  skill: z.string().nullable(),
  inputs: z.array(z.string()),
  outputs: z.array(z.string()),
  verification: z.string().nullable(),
  blockedBy: z.array(z.string()),
  source: z.string(),
  dueAt: z.string().nullable(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
  demo: z.boolean(),
  sourceKind: taskSourceKindSchema,
  executionMode: taskExecutionModeSchema,
});

export const topicSourceSchema = z.enum(["外部案例", "自有选题", "自有案例"]);

export const topicItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  source: topicSourceSchema,
  platform: z.string(),
  theme: z.string(),
  format: contentFormatSchema,
  evidenceGap: z.string(),
  originalUrl: z.string().url().nullable(),
  tags: z.array(z.string()),
  updatedAt: z.string(),
});

export const assetTypeSchema = z.enum([
  "判断",
  "方法",
  "复盘",
  "故事",
  "概念",
  "原始材料",
  "内容资产",
]);
export const confirmationStatusSchema = z.enum(["待人工确认", "已确认"]);
export const sensitivityLevelSchema = z.enum(["公开", "内部", "敏感"]);

export const knowledgeAssetSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  type: assetTypeSchema,
  confirmation: confirmationStatusSchema,
  sensitivity: sensitivityLevelSchema,
  source: z.string(),
  topics: z.array(z.string()),
  updatedAt: z.string(),
});

export const experimentResultSchema = z.enum(["有效", "无效", "证据不足"]);

export const experimentItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  hypothesis: z.string(),
  variable: z.string(),
  baseline: z.string(),
  target: z.string(),
  result: experimentResultSchema,
  decision: z.string(),
  relatedContent: z.array(z.string()),
  nextAction: z.string(),
  updatedAt: z.string(),
});

export const projectDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  summary: z.string(),
  source: z.string(),
  updatedAt: z.string(),
});

export const reviewItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  reason: z.string(),
  summary: z.string(),
  source: z.string(),
  updatedAt: z.string(),
});

export const evidenceItemSchema = z.object({
  id: z.string(),
  platform: z.string(),
  accountId: z.string(),
  value: z.number().int().min(0),
  asOf: z.string(),
  sourceEvidence: z.string(),
  profileUrl: z.string().url(),
});

export const sourceFileRefSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bytes: z.number().int().min(0),
  classification: z.string(),
  included: z.boolean(),
  reason: z.string(),
});

export const workbenchIndexSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  generatedAt: z.string(),
  dataAsOf: z.string(),
  meta: z.object({
    maxFileBytes: z.number().int(),
    parsedFiles: z.number().int(),
    normalAssets: z.number().int(),
    reviewItems: z.number().int(),
    warnings: z.number().int(),
  }),
  growth: z.object({
    summary: growthSummarySchema,
    accounts: z.array(platformAccountSchema).min(1).max(20),
  }),
  actionTargets: z.array(actionTargetSchema).length(5),
  evidence: z.array(evidenceItemSchema),
  contents: z.array(contentItemSchema),
  knowledge: z.array(knowledgeAssetSchema),
  projectDocuments: z.array(projectDocumentSchema),
  tasks: z.array(taskItemSchema),
  todayTasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      done: z.boolean(),
      linkId: z.string().nullable(),
      linkType: z.enum(["topic", "content", "content-review", "account-breakdown", "daily-review", "task"]).nullable(),
    }).refine((task) => (task.linkId === null) === (task.linkType === null), {
      message: "linkId 与 linkType 必须同时为空或同时存在",
    })
  ),
  experiments: z.array(experimentItemSchema),
  reviewItems: z.array(reviewItemSchema),
  sourceFiles: z.array(sourceFileRefSchema),
});

export const viewModeSchema = z.enum(["board", "table", "card"]);

export const todayTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  linkId: z.string().nullable(),
  linkType: z.enum(["topic", "content", "content-review", "account-breakdown", "daily-review", "task"]).nullable(),
}).refine((task) => (task.linkId === null) === (task.linkType === null), {
  message: "linkId 与 linkType 必须同时为空或同时存在",
});
