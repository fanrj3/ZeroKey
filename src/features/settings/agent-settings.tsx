import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { api, desktop } from "@/api";
import type { AgentIntegration } from "@/types";
import { errorText } from "@/lib/format";
import { ErrorAlert, StatusBadge } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const messages: Record<string, string> = {
  CONFIG_ACCESS_DENIED: "客户端配置访问被拒绝，请在正常桌面会话中运行。",
  CONFIG_INVALID:
    "客户端配置格式有误，未修改文件。请修复后重试，或手动合并下面的配置片段。",
  CONFIG_READ_FAILED:
    "无法读取或保存客户端配置，未确认接入成功。请检查文件权限。",
  ENTRY_CONFLICT:
    "已有不同的 ZeroKey 接入配置，为保留现有设置未自动覆盖。请核对后手动合并配置片段。",
};
export function AgentSettings() {
  const [client, setClient] = useState("codex");
  const [data, setData] = useState<AgentIntegration | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!desktop) return;
    const current = generation.current;
    try {
      const next = await api.integration(client);
      if (current !== generation.current) return;
      setData(next);
      setFailure("");
    } catch (error) {
      if (current === generation.current) setFailure(errorText(error));
    }
  }, [client]);
  useEffect(() => {
    setData(null);
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  async function install() {
    setBusy(true);
    setFailure("");
    try {
      const next = await api.integration(client, true);
      setData(next);
      if (next.error)
        setFailure(messages[next.error] ?? "接入未完成，请检查配置。");
      else toast.success("接入配置已保存，请重载客户端的 MCP 或重启客户端");
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card id="agent-integration">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" />
          Agent 接入
        </CardTitle>
        <CardDescription>
          配置本机 MCP 后，Agent 可以发现模型、提交申请和复用授权。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field>
          <FieldLabel htmlFor="agent-client">客户端</FieldLabel>
          <Select value={client} onValueChange={setClient} disabled={busy}>
            <SelectTrigger id="agent-client" className="w-full sm:w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="codex">Codex</SelectItem>
              <SelectItem value="claude">Claude Code</SelectItem>
              <SelectItem value="opencode">OpenCode</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {data && (
          <>
            <div className="flex flex-wrap gap-2" role="status">
              {[
                [data.configured, "已配置", "未配置"],
                [data.connected, "已连接", "等待连接"],
                [data.toolsAvailable, "工具可用", "等待工具发现"],
              ].map(([ok, yes, no]) => (
                <StatusBadge
                  key={String(yes)}
                  tone={ok ? "success" : "neutral"}
                  icon={ok ? Check : TriangleAlert}
                >
                  {ok ? yes : no}
                </StatusBadge>
              ))}
            </div>
            <Field>
              <FieldLabel htmlFor="agent-config-path">配置文件</FieldLabel>
              <Input
                id="agent-config-path"
                readOnly
                value={data.path}
                className="text-xs"
              />
              <FieldDescription>
                仅新增 ZeroKey
                接入，已有文件会先备份；不会改动其他服务。保存后需在客户端重载
                MCP。
              </FieldDescription>
            </Field>
            {(failure || data.error || data.conflict) && (
              <ErrorAlert
                message={
                  failure ||
                  messages[data.error ?? "ENTRY_CONFLICT"] ||
                  "请检查客户端配置。"
                }
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || data.configured || data.conflict || !desktop}
                onClick={() => void install()}
              >
                {busy && <Loader2 className="animate-spin" />}
                {data.configured ? "接入已配置" : "配置此客户端"}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void refresh()}
              >
                <RefreshCw />
                刷新状态
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              “已连接”来自客户端实际握手；“工具可用”表示客户端已读取工具列表。配置保存成功不代表当前聊天已经加载工具。
            </p>
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm">
                  手动接入配置
                  <ChevronDown />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2">
                <pre className="max-h-48 overflow-auto rounded-lg border bg-muted/40 p-3 text-xs">
                  <code>{data.snippet}</code>
                </pre>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(data.snippet)
                      .then(() => toast.success("已复制无密钥配置片段"))
                      .catch(() => setFailure("复制失败，请手动选中配置。"))
                  }
                >
                  <Copy />
                  复制配置片段
                </Button>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}
        {!data &&
          (failure ? (
            <ErrorAlert message={failure} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {desktop
                ? "正在检查客户端接入…"
                : "请在桌面应用中配置 Agent 接入。"}
            </p>
          ))}
      </CardContent>
    </Card>
  );
}
