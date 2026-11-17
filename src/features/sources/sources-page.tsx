import { useState } from "react";
import { ChevronDown, ExternalLink, Layers3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  EmptyState,
  ListPagination,
  PageHeading,
  SearchInput,
} from "@/components/shared";
import { desktop } from "@/api";
import type { Model } from "@/types";
import { modelCapability, modelLabel, sourceName } from "@/types";
import { filterModels } from "@/lib/format";

export function SourcesPage({
  models,
  connected,
  onDashboard,
}: {
  models: Model[];
  connected: boolean;
  onDashboard: () => void;
}) {
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const sources = [...new Set(models.map((model) => model.source))];
  const filtered = filterModels(models, source, query);
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / 20)));
  return (
    <>
      <PageHeading
        title="模型来源"
        description="查看各来源的模型目录。相同模型按来源分别授权、路由和统计。"
      >
        <Button
          variant="outline"
          onClick={onDashboard}
          disabled={!desktop || !connected}
        >
          <ExternalLink />
          管理来源
        </Button>
      </PageHeading>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          目录条目需实际调用确认可用性，接口标签仅表示目录类型。图片、音频和视频需单独适配。
        </p>
        {sources.length > 0 && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="group">
                来源接入说明
                <ChevronDown className="group-data-[state=open]:rotate-180" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <section
                className="overflow-hidden rounded-xl border"
                aria-label="来源概览"
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">来源</TableHead>
                      <TableHead>接入方式</TableHead>
                      <TableHead className="text-right">模型条目</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sources.map((id) => (
                      <TableRow key={id}>
                        <TableCell className="pl-4 font-medium">
                          {sourceName(id)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {id === "opencode-go"
                            ? "Go 订阅套餐 · 独立会话"
                            : id === "opencode-payg"
                              ? "OpenCode 余额付费"
                              : "OpenAI 兼容接口"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {models.filter((model) => model.source === id).length}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
              <p className="text-sm text-muted-foreground">
                Openlux 当前仅导入可识别的文本模型。来源地址和上游凭据在 LiteLLM
                管理界面编辑。
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
      <section
        className="overflow-hidden rounded-xl border"
        aria-label="模型目录"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <h2 className="text-sm font-medium">模型目录</h2>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Select
              value={source}
              onValueChange={(value) => {
                setSource(value);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="筛选模型来源" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部来源</SelectItem>
                {sources.map((id) => (
                  <SelectItem key={id} value={id}>
                    {sourceName(id)} ·{" "}
                    {models.filter((model) => model.source === id).length}{" "}
                    个模型
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <SearchInput
              label="搜索模型"
              value={query}
              onChange={(value) => {
                setQuery(value);
                setPage(1);
              }}
            />
          </div>
        </div>
        {filtered.length ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">模型名称</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>接口类型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered
                  .slice((current - 1) * 20, current * 20)
                  .map((model) => (
                    <TableRow key={model.id}>
                      <TableCell
                        className="max-w-96 truncate pl-4 font-mono text-xs"
                        title={model.id}
                      >
                        {modelLabel(model.id)}
                      </TableCell>
                      <TableCell>{sourceName(model.source)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" title={model.protocol}>
                          {modelCapability(model.protocol)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
            <ListPagination
              total={filtered.length}
              page={current}
              size={20}
              onChange={setPage}
            />
          </>
        ) : (
          <EmptyState
            icon={<Layers3 />}
            title="没有可显示的模型"
            description={
              connected
                ? "调整搜索条件，或在网关中添加来源。"
                : "连接网关后读取真实模型目录。"
            }
          />
        )}
      </section>
    </>
  );
}
