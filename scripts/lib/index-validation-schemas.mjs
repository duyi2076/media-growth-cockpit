import { z } from "zod";

const SAFE_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_LINK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;

export const todayTaskIndexSchema = z.object({
  id: z.string().regex(SAFE_TASK_ID_RE),
  title: z.string().trim().min(1).max(120)
    .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value))
    .refine((value) => !/[<>]/.test(value))
    .refine((value) => !value.includes("[[") && !value.includes("]]"))
    .refine((value) => !value.includes("---")),
  done: z.boolean(),
  linkId: z.string().regex(SAFE_LINK_ID_RE).nullable(),
  linkType: z.enum(["topic", "content", "content-review", "account-breakdown", "daily-review", "task"]).nullable(),
}).refine((task) => (task.linkId === null) === (task.linkType === null), {
  message: "linkId 与 linkType 必须同时为空或同时存在",
});

export const todayTasksIndexSchema = z
  .array(todayTaskIndexSchema)
  .max(3, "今日任务最多 3 条");
