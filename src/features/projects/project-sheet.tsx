import { useState } from "react";
import { Check, Copy, Loader2, Terminal } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api";
import type { Project, TestResult } from "@/types";
import { expiryLabel, sourceName } from "@/types";
import { errorText, money } from "@/lib/format";
import { ErrorAlert, ProjectStatusBadge } from "@/components/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export function ProjectSheet({
  open = true,
  onExited,
  project,
  connected,
  onClose,
  onEdit,
  onRevoked,
  onTested,
}: {
  open?: boolean;
  onExited?: () => void;
  project: Project;
  connected: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRevoked: () => Promise<void>;
  onTested: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<"test" | "revoke" | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const command = `$provision-key 使用 ${project.name} 的现有授权运行当前任务`;
  async function test() {
    setBusy("test");
    setError("");
    setResult(null);
    try {
      setResult(await api.test(project.id));
      await onTested();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  async function revoke() {
    setBusy("revoke");
    setError("");
    try {
      await api.revoke(project.id);
      setConfirm(false);
      toast.success("项目授权已撤销");
      await onRevoked();
    } catch (error) {
      setError(errorText(error));
      setConfirm(false);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <SheetContent
        className="gap-0 data-open:duration-200 data-closed:duration-150 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        onCloseAutoFocus={onExited}
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <SheetHeader className="border-b p-6 pr-12">
          <SheetTitle>{project.name}</SheetTitle>
          <SheetDescription className="break-all">
            {project.path}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
          <div className="flex flex-wrap gap-2">
            <ProjectStatusBadge project={project} />
            <Badge variant="outline">{expiryLabel(project.expires)}</Badge>
          </div>
          {error && <ErrorAlert message={error} />}
          {!connected && (
            <Alert>
              <Terminal />
              <AlertTitle>网关状态待检查</AlertTitle>
              <AlertDescription>
                当前保留已保存的授权，仍可复制使用说明。连接恢复后请刷新确认项目状态与用量。
              </AlertDescription>
            </Alert>
          )}
          <section className="space-y-3">
            <h3 className="font-medium">在 Agent 中使用</h3>
            <p className="text-sm text-muted-foreground">
              调用 Skill 复用已有授权，Key 无需进入对话。
            </p>
            <div className="flex items-start gap-2 rounded-lg border bg-muted p-3">
              <code className="min-w-0 flex-1 break-words text-xs leading-relaxed">
                {command}
              </code>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={copied ? "已复制" : "复制使用说明"}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(command)
                    .then(() => {
                      setCopied(true);
                      toast.success("使用说明已复制");
                    })
                    .catch(() => toast.error("复制失败，请手动选取文字。"));
                }}
              >
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          </section>
          <Separator />
          <section className="space-y-3">
            <h3 className="font-medium">允许的模型</h3>
            <div className="divide-y rounded-lg border">
              {project.models.map((model) => (
                <div key={model} className="space-y-1 p-3">
                  <p className="break-all font-mono text-xs">{model}</p>
                  <p className="text-xs text-muted-foreground">
                    {sourceName(model.split("/")[0])}
                  </p>
                </div>
              ))}
            </div>
          </section>
          <Separator />
          <section className="space-y-4">
            <h3 className="font-medium">预算与有效期</h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <dt className="text-muted-foreground">每日预算</dt>
              <dd className="text-right tabular-nums">
                {money(project.dailyBudget)}
              </dd>
              <dt className="text-muted-foreground">本周期已用</dt>
              <dd className="text-right tabular-nums">
                {money(project.spend, 6)}
              </dd>
              <dt className="text-muted-foreground">有效期</dt>
              <dd className="text-right">{expiryLabel(project.expires)}</dd>
            </dl>
            <p className="text-sm text-muted-foreground">
              金额按 LiteLLM 估算，预算按网关窗口重置。中转站实际扣费和 OpenCode
              Go 套餐额度以来源后台为准。
            </p>
          </section>
          <Separator />
          <section className="space-y-3">
            <h3 className="font-medium">验证文字输出</h3>
            <p className="text-sm text-muted-foreground">
              使用项目权限发起一次短文本请求，会计入项目用量。
            </p>
            <Button
              variant="outline"
              disabled={!!busy || !connected || project.status !== "active"}
              onClick={() => void test()}
            >
              {busy === "test" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Terminal />
              )}
              {busy === "test" ? "等待模型返回…" : "测试文字输出"}
            </Button>
            {result && (
              <Alert className="border-success/30 bg-success/10 text-success *:data-[slot=alert-description]:text-success">
                <Check />
                <AlertTitle>模型已返回文字</AlertTitle>
                <AlertDescription>
                  <p className="whitespace-pre-wrap break-words">
                    {result.text}
                  </p>
                  <p className="break-all text-xs">
                    {result.model} · {result.tokens ?? "—"} tokens
                  </p>
                </AlertDescription>
              </Alert>
            )}
          </section>
        </div>
        <SheetFooter className="border-t p-6">
          <div className="flex justify-between gap-2">
            <AlertDialog
              open={confirm}
              onOpenChange={(value) => {
                if (!busy) setConfirm(value);
              }}
            >
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={!!busy || !connected}>
                  撤销授权
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    撤销「{project.name}」的授权？
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    项目将无法继续使用此凭证调用模型。之后可重新申请授权。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={!!busy}>取消</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={!!busy}
                    onClick={(event) => {
                      event.preventDefault();
                      void revoke();
                    }}
                  >
                    {busy === "revoke" && <Loader2 className="animate-spin" />}
                    确认撤销
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Button
              variant="outline"
              onClick={onEdit}
              disabled={!!busy || !connected}
            >
              调整授权
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
