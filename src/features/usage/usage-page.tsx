import { Activity, ExternalLink, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  PageHeading,
  ProjectStatusBadge,
} from "@/components/shared";
import type { Project } from "@/types";
import { desktop } from "@/api";
import { money } from "@/lib/format";

export function UsagePage({
  projects,
  connected,
  onDashboard,
}: {
  projects: Project[];
  connected: boolean;
  onDashboard: () => void;
}) {
  return (
    <>
      <PageHeading
        title="用量记录"
        description="费用由 LiteLLM 估算，预算按网关窗口重置；OpenCode Go 套餐额度与中转站实际扣费以来源后台为准。"
      >
        <Button
          variant="outline"
          disabled={!desktop || !connected}
          onClick={onDashboard}
        >
          <ExternalLink />
          完整用量与账单
        </Button>
      </PageHeading>
      <section
        className={
          projects.length ? "overflow-hidden rounded-xl border" : undefined
        }
        aria-label="项目用量"
      >
        {projects.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">项目</TableHead>
                <TableHead>本周期已用</TableHead>
                <TableHead>每日预算</TableHead>
                <TableHead>预算使用率</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => {
                const percentage =
                  project.dailyBudget > 0
                    ? (project.spend / project.dailyBudget) * 100
                    : 0;
                return (
                  <TableRow key={project.id}>
                    <TableCell className="pl-4 font-medium">
                      {project.name}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {money(project.spend, 6)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {money(project.dailyBudget)}
                    </TableCell>
                    <TableCell className="min-w-40">
                      <div className="flex items-center gap-3">
                        <Progress
                          value={Math.min(100, Math.max(0, percentage))}
                          aria-label={`${project.name} 的预算使用率`}
                          className={
                            percentage >= 100
                              ? "*:data-[slot=progress-indicator]:bg-destructive"
                              : percentage >= 80
                                ? "*:data-[slot=progress-indicator]:bg-warning"
                                : undefined
                          }
                        />
                        <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          {percentage.toFixed(1)}%
                        </span>
                      </div>
                      {percentage >= 80 && (
                        <p
                          className={`mt-2 flex items-center gap-1 text-xs ${percentage >= 100 ? "text-destructive" : "text-warning"}`}
                        >
                          <TriangleAlert
                            className="size-3"
                            aria-hidden="true"
                          />
                          {percentage >= 100
                            ? "预算已用尽"
                            : "接近每日预算上限"}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <ProjectStatusBadge project={project} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <EmptyState
            icon={<Activity />}
            title="还没有项目用量"
            description="添加项目并调用模型后，这里会显示项目的实际用量。"
          />
        )}
      </section>
    </>
  );
}
