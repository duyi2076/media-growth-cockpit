export interface PlatformAccount {
  id: string;
  platform: string;
  account: string;
  displayName: string;
  handle: string;
  profileUrl: string;
  baselineFollowers: number;
  currentFollowers: number;
  followerGrowth: number;
  targetFollowers: number | null;
  gap: number | null;
  asOf: string;
  sourceEvidence: string;
  active: boolean;
}

export interface GrowthSummary {
  baselineFollowers: number;
  currentFollowers: number;
  gainedFollowers: number;
  growthTarget: number;
  growthGap: number;
  expectedFollowers: number;
  completionRate: number;
  asOf: string;
  startDate: string | null;
  deadline: string | null;
  campaignStartedAt: string | null;
}

export type ActionTargetId =
  | "article-output"
  | "video-output"
  | "platform-publish"
  | "content-review"
  | "account-breakdown";

export interface ActionTarget {
  id: ActionTargetId;
  label: string;
  current: number;
  target: number | null;
  unit: string;
  completionRate: number | null;
}

export type ContentStatus =
  | "候选选题"
  | "已立项"
  | "待发布"
  | "已发布"
  | "待复盘"
  | "已归档";

export type ContentFormat = "文章" | "短视频口播" | "图文卡片" | "直播稿" | "系列";

export type Priority = "P0" | "P1" | "P2" | "P3";

export interface ContentItem {
  id: string;
  familyId: string;
  title: string;
  summary: string;
  status: ContentStatus;
  format: ContentFormat;
  channels: string[];
  priority: Priority | null;
  dueAt: string | null;
  source: string;
  nextAction: string;
  evidenceStatus: "有证据" | "部分证据" | "待补充";
  tags: string[];
  updatedAt: string;
}

export type TaskStatus = "待办" | "进行中" | "阻塞" | "待验收" | "已完成";
export type TaskType = "人工任务" | "Agent 任务" | "人机协作任务";
export type TaskSourceKind = "vault" | "local-demo";
export type TaskExecutionMode = "read-only" | "simulated";

export interface TaskItem {
  id: string;
  title: string;
  summary: string;
  status: TaskStatus;
  type: TaskType;
  priority: Priority | null;
  assignee: string;
  assignedAgent: string | null;
  skill: string | null;
  inputs: string[];
  outputs: string[];
  verification: string | null;
  blockedBy: string[];
  source: string;
  dueAt: string | null;
  tags: string[];
  updatedAt: string;
  demo: boolean;
  sourceKind: TaskSourceKind;
  executionMode: TaskExecutionMode;
}

export type TopicSource = "外部案例" | "自有选题" | "自有案例";

export interface TopicItem {
  id: string;
  title: string;
  summary: string;
  source: TopicSource;
  platform: string;
  theme: string;
  format: ContentFormat;
  evidenceGap: string;
  originalUrl: string | null;
  tags: string[];
  updatedAt: string;
}

export type AssetType = "判断" | "方法" | "复盘" | "故事" | "概念" | "原始材料" | "内容资产";
export type ConfirmationStatus = "待人工确认" | "已确认";
export type SensitivityLevel = "公开" | "内部" | "敏感";

export interface KnowledgeAsset {
  id: string;
  title: string;
  summary: string;
  type: AssetType;
  confirmation: ConfirmationStatus;
  sensitivity: SensitivityLevel;
  source: string;
  topics: string[];
  updatedAt: string;
}

export type ExperimentResult = "有效" | "无效" | "证据不足";

export interface ExperimentItem {
  id: string;
  title: string;
  hypothesis: string;
  variable: string;
  baseline: string;
  target: string;
  result: ExperimentResult;
  decision: string;
  relatedContent: string[];
  nextAction: string;
  updatedAt: string;
}

export interface ProjectDocument {
  id: string;
  title: string;
  type: string;
  summary: string;
  source: string;
  updatedAt: string;
}

export interface ReviewItem {
  id: string;
  title: string;
  type: string;
  reason: string;
  summary: string;
  source: string;
  updatedAt: string;
}

export interface EvidenceItem {
  id: string;
  platform: string;
  accountId: string;
  value: number;
  asOf: string;
  sourceEvidence: string;
  profileUrl: string;
}

export interface SourceFileRef {
  path: string;
  sha256: string;
  bytes: number;
  classification: string;
  included: boolean;
  reason: string;
}

export interface WorkbenchIndex {
  schemaVersion: "1.0.0";
  generatedAt: string;
  dataAsOf: string;
  meta: {
    maxFileBytes: number;
    parsedFiles: number;
    normalAssets: number;
    reviewItems: number;
    warnings: number;
  };
  growth: {
    summary: GrowthSummary;
    accounts: PlatformAccount[];
  };
  actionTargets: ActionTarget[];
  evidence: EvidenceItem[];
  contents: ContentItem[];
  knowledge: KnowledgeAsset[];
  projectDocuments: ProjectDocument[];
  tasks: TaskItem[];
  todayTasks: TodayTask[];
  experiments: ExperimentItem[];
  reviewItems: ReviewItem[];
  sourceFiles: SourceFileRef[];
}

export type ViewMode = "board" | "table" | "card";

export interface TodayTask {
  id: string;
  title: string;
  done: boolean;
  linkId: string | null;
  linkType: "topic" | "content" | "content-review" | "account-breakdown" | "daily-review" | "task" | null;
}
