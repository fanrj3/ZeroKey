import type { Project } from "@/types";

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "操作未完成，请稍后重试。";
}
export const money = (amount: number, digits = 2) =>
  `$${amount.toFixed(digits)}`;
export function projectStatus(project: Project): string {
  if (project.status === "active") return "有效";
  return (
    (
      {
        expired: "已到期",
        blocked: "已停用",
        revoked: "已撤销",
        unknown: "状态未知",
        unavailable: "模型不可获取",
      } as Record<string, string>
    )[project.status] ?? "需要检查"
  );
}

export function filterModels<T extends { id: string; source: string }>(
  models: T[],
  source: string,
  query: string,
): T[] {
  const term = query.trim().toLowerCase();
  return models.filter(
    (model) =>
      (source === "all" || source === model.source) &&
      `${model.id} ${model.source}`.toLowerCase().includes(term),
  );
}
