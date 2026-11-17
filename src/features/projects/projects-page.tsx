import { useState } from "react";
import { Folder, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  PageHeading,
  SearchInput,
  EmptyState,
  ListPagination,
  ProjectStatusBadge,
} from "@/components/shared";
import type { Project } from "@/types";
import { expiryLabel, modelLabel, sourceName } from "@/types";
import { money } from "@/lib/format";

export function ProjectsPage({
  projects,
  connected,
  onAdd,
  onSelect,
}: {
  projects: Project[];
  connected: boolean;
  onAdd: () => void;
  onSelect: (project: Project) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filtered = projects.filter((project) =>
    `${project.name} ${project.path} ${project.models.join(" ")}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / 10)));
  return (
    <>
      <PageHeading
        title="项目授权"
        description="首次授权后持续复用，默认长期有效。"
      >
        {projects.length > 0 && (
          <Button onClick={onAdd} disabled={!connected}>
            <Plus />
            添加项目
          </Button>
        )}
      </PageHeading>
      {projects.length === 0 ? (
        <EmptyState
          icon={<Folder />}
          title="添加第一个项目"
          description="选择项目文件夹、模型和每日预算。"
        >
          <Button disabled={!connected} onClick={onAdd}>
            <Plus />
            添加项目
          </Button>
        </EmptyState>
      ) : (
        <section
          className="overflow-hidden rounded-xl border"
          aria-label="项目列表"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
            <SearchInput
              label="搜索项目或模型"
              value={query}
              onChange={(value) => {
                setQuery(value);
                setPage(1);
              }}
            />
          </div>
          {filtered.length ? (
            <>
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[30%] pl-4">项目</TableHead>
                    <TableHead className="w-[28%]">授权模型</TableHead>
                    <TableHead className="w-[14%]">每日预算</TableHead>
                    <TableHead className="w-[14%]">有效期</TableHead>
                    <TableHead className="w-[14%]">状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered
                    .slice((current - 1) * 10, current * 10)
                    .map((project) => (
                      <TableRow key={project.id}>
                        <TableCell className="max-w-64 pl-4">
                          <Button
                            variant="link"
                            className="h-auto max-w-full justify-start truncate p-0 text-link"
                            onClick={() => onSelect(project)}
                          >
                            {project.name}
                          </Button>
                          <p
                            className="mt-1 truncate text-xs text-muted-foreground"
                            title={project.path}
                          >
                            {project.path}
                          </p>
                        </TableCell>
                        <TableCell className="max-w-56">
                          <p
                            className="truncate"
                            title={project.models.join(", ")}
                          >
                            {modelLabel(project.models[0] ?? "")}
                            {project.models.length > 1 &&
                              ` +${project.models.length - 1}`}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {sourceName(project.models[0]?.split("/")[0] ?? "")}
                          </p>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {money(project.dailyBudget)}
                        </TableCell>
                        <TableCell>{expiryLabel(project.expires)}</TableCell>
                        <TableCell>
                          <ProjectStatusBadge project={project} />
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
              <ListPagination
                total={filtered.length}
                size={10}
                page={current}
                onChange={setPage}
              />
            </>
          ) : (
            <EmptyState
              icon={<Folder />}
              title="没有匹配的项目"
              description="尝试其他项目名称、路径或模型。"
            />
          )}
        </section>
      )}
    </>
  );
}
