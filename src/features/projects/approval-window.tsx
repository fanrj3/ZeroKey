import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Fingerprint, Folder, KeyRound, Loader2, X } from "lucide-react";
import { api, getSnapshot } from "@/api";
import type { AgentRequest, Snapshot } from "@/types";
import { sourceName } from "@/types";
import { errorText, money } from "@/lib/format";
import { OptionPicker } from "@/components/model-picker";
import { ErrorAlert } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ApprovalWindow() {
  const [request, setRequest] = useState<AgentRequest | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failure, setFailure] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.pending();
      if (!next) {
        setRequest(null);
        setFailure("");
        return;
      }
      const data = await getSnapshot();
      setSnapshot(data);
      setRequest(next);
      setFailure("");
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const listener = listen("approval-request", () => void load());
    return () => {
      void listener.then((unlisten) => unlisten());
    };
  }, [load]);
  return (
    <main className="flex h-svh min-h-0 flex-col overflow-hidden bg-background">
      {request && snapshot ? (
        <ApprovalForm
          key={request.requestId}
          request={request}
          snapshot={snapshot}
          onRefresh={load}
        />
      ) : (
        <>
          <header
            className="flex h-14 shrink-0 items-center gap-2 border-b px-5"
            data-tauri-drag-region
          >
            <KeyRound className="size-4" />
            <span>ZeroKey</span>
          </header>
          <div className="flex flex-1 flex-col justify-center gap-4 p-6">
            {failure ? (
              <>
                <ErrorAlert message={failure} />
                <Button variant="outline" onClick={() => void load()}>
                  重试读取
                </Button>
              </>
            ) : loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                正在读取待审核申请…
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">暂无待审核申请。</p>
            )}
            <Button variant="ghost" onClick={() => void api.dismissApproval()}>
              关闭
            </Button>
          </div>
        </>
      )}
    </main>
  );
}

export function ApprovalForm({
  request,
  snapshot,
  onRefresh,
}: {
  request: AgentRequest;
  snapshot: Snapshot;
  onRefresh?: () => Promise<void>;
}) {
  const [path, setPath] = useState(request.path);
  const [models, setModels] = useState(request.models);
  const [providers, setProviders] = useState([
    ...new Set(
      request.models.map(
        (id) =>
          snapshot.models.find((m) => m.id === id)?.source ?? id.split("/")[0],
      ),
    ),
  ]);
  const [budget, setBudget] = useState(String(request.dailyBudget));
  const [duration, setDuration] = useState(request.duration ?? "unlimited");
  const [reasons, setReasons] = useState(
    request.reasons?.length ? request.reasons : ["开发与调试"],
  );
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [failure, setFailure] = useState("");
  const failureRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!failure) return;
    failureRef.current?.focus({ preventScroll: true });
    failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);
  const [extraPaths, setExtraPaths] = useState<string[]>([]);
  useEffect(() => {
    if (busy || terminal) return;
    let disposed = false;
    const timer = setInterval(
      () =>
        void api
          .requestStatus(request.requestId)
          .then(async (result) => {
            if (disposed) return;
            if (result.status === "failed" || result.message) {
              setTerminal(true);
              setFailure(
                result.message ||
                  "授权未完成，请打开设置检查网关与项目状态。关闭后可重新申请。",
              );
            } else if (
              ["canceled", "expired", "provisioned", "reused"].includes(
                result.status,
              )
            )
              await api.dismissApproval();
          })
          .catch(() => {}),
      1800,
    );
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [request.requestId, busy, terminal]);
  async function cancel() {
    setBusy(true);
    try {
      if (!terminal) await api.cancel(request.requestId);
      await api.dismissApproval();
    } catch (error) {
      setFailure(errorText(error));
      setBusy(false);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || terminal) return;
    setBusy(true);
    setFailure("");
    try {
      await api.grant({
        requestId: request.requestId,
        name:
          snapshot.projects.find((p) => p.path === path)?.name ?? request.name,
        path,
        models,
        dailyBudget: Number(budget),
        duration: duration === "unlimited" ? null : duration,
        pin: pin || null,
        reasons,
      });
      setPin("");
      await api.dismissApproval();
    } catch (error) {
      setPin("");
      setFailure(errorText(error));
      try {
        const result = await api.requestStatus(request.requestId);
        if (["failed", "provisioned", "reused"].includes(result.status))
          setTerminal(true);
      } catch {
        /* Preserve the original actionable error. */
      }
      setBusy(false);
    }
  }
  const paths = [
    ...new Set([
      request.path,
      ...snapshot.projects.map((p) => p.path),
      ...extraPaths,
    ]),
  ];
  const available = snapshot.models.filter((model) =>
    providers.includes(model.source),
  );
  const missing = models.some(
    (id) => !available.some((model) => model.id === id),
  );
  const options = [
    ...new Set([
      ...(request.reasons ?? []),
      "开发与调试",
      "文字生成",
      "代码辅助",
      "自动化测试",
      "数据处理",
      ...reasons,
    ]),
  ];
  return (
    <>
      <header
        className="flex shrink-0 items-start gap-3 border-b p-5"
        data-tauri-drag-region
      >
        <KeyRound className="mt-1 size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1" data-tauri-drag-region>
          <h1 className="text-lg font-semibold">授权模型访问</h1>
          <p
            className="mt-1 truncate text-sm text-muted-foreground"
            title={request.name}
          >
            {request.name} 申请使用 API
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={terminal ? "关闭授权结果" : "取消授权并关闭"}
          disabled={busy}
          onClick={() => void cancel()}
        >
          <X />
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
        <form
          id="approval-form"
          onSubmit={(event) => void submit(event)}
          className="space-y-4 p-5"
        >
          {failure && (
            <ErrorAlert
              ref={failureRef}
              id="approval-error"
              tabIndex={-1}
              title="授权需要处理"
              message={failure}
            />
          )}
          {!snapshot.connected && (
            <div className="space-y-2">
              <ErrorAlert
                title="网关未连接"
                message={
                  snapshot.message || "请从托盘打开设置，检查网关后重试。"
                }
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void onRefresh?.()}
              >
                重新检查连接
              </Button>
            </div>
          )}
          <Field>
            <FieldLabel>授权项目</FieldLabel>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <OptionPicker
                  label="授权项目"
                  single
                  disabled={busy || terminal}
                  values={[path]}
                  onChange={(values) => setPath(values[0])}
                  options={paths.map((value) => ({
                    value,
                    label:
                      snapshot.projects.find((p) => p.path === value)?.name ??
                      (value === request.path
                        ? request.name
                        : (value.split(/[\\/]/).pop() ?? value)),
                    detail: value,
                  }))}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={busy || terminal}
                aria-label="选择其他项目文件夹"
                onClick={() =>
                  void open({
                    directory: true,
                    multiple: false,
                    title: "选择授权项目",
                  })
                    .then((value) => {
                      if (typeof value === "string") {
                        setExtraPaths([...extraPaths, value]);
                        setPath(value);
                      }
                    })
                    .catch((error) => setFailure(errorText(error)))
                }
              >
                <Folder />
              </Button>
            </div>
            <FieldDescription className="truncate" title={path}>
              {path}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>来源 Provider</FieldLabel>
            <OptionPicker
              label="来源 Provider"
              disabled={busy || terminal}
              values={providers}
              options={[...new Set(snapshot.models.map((m) => m.source))].map(
                (source) => ({ value: source, label: sourceName(source) }),
              )}
              onChange={(next) => {
                setProviders(next);
                setModels(
                  models.filter((id) =>
                    snapshot.models.some(
                      (m) => m.id === id && next.includes(m.source),
                    ),
                  ),
                );
              }}
            />
          </Field>
          <Field>
            <FieldLabel>模型 ID</FieldLabel>
            <OptionPicker
              label="模型 ID"
              disabled={busy || terminal}
              values={models}
              options={available.map((m) => ({
                value: m.id,
                label: m.id,
                detail: `${sourceName(m.source)} · ${m.protocol}`,
              }))}
              onChange={setModels}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="approval-budget">
                每日预算（美元）
              </FieldLabel>
              <Input
                id="approval-budget"
                type="number"
                min="0.01"
                max="10"
                step="0.01"
                required
                value={budget}
                disabled={busy || terminal}
                onChange={(event) => setBudget(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="approval-duration">有效期</FieldLabel>
              <Select
                value={duration}
                disabled={busy || terminal}
                onValueChange={setDuration}
              >
                <SelectTrigger id="approval-duration" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    "unlimited",
                    "7d",
                    "30d",
                    "90d",
                    ...(!["unlimited", "7d", "30d", "90d"].includes(duration)
                      ? [duration]
                      : []),
                  ].map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === "unlimited"
                        ? "长期有效"
                        : `${value.slice(0, -1)} ${value.endsWith("h") ? "小时" : "天"}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel>授权理由</FieldLabel>
            <OptionPicker
              label="授权理由"
              allowCustom
              maxCustomLength={150}
              disabled={busy || terminal}
              values={reasons}
              options={options.map((value) => ({ value, label: value }))}
              onChange={(next) => {
                if (next.length <= 8) setReasons(next);
                else setFailure("授权理由最多选择 8 项。");
              }}
            />
          </Field>
          {!snapshot.nativeAuth && (
            <Field>
              <FieldLabel htmlFor="approval-pin">ZeroKey 授权 PIN</FieldLabel>
              <Input
                id="approval-pin"
                type="password"
                autoComplete="off"
                inputMode="numeric"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                required
                disabled={busy || terminal || !snapshot.pinConfigured}
              />
              <FieldDescription>
                {snapshot.pinConfigured
                  ? "与系统登录 PIN 独立。"
                  : "请先打开设置，创建本机授权 PIN。"}
              </FieldDescription>
            </Field>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            预算按网关估算，来源实际扣费以其后台为准。目录模型需实际调用验证。
          </p>
        </form>
      </ScrollArea>
      <footer className="shrink-0 space-y-3 border-t p-5">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            {models.length} 个模型 · 每天 {money(Number(budget) || 0)}
          </span>
          <Badge variant="outline">
            {snapshot.nativeAuth ? "Windows Hello 确认" : "本机 PIN 确认"}
          </Badge>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void cancel()}
          >
            {terminal ? "关闭" : "取消"}
          </Button>
          <Button
            type="submit"
            form="approval-form"
            disabled={
              busy ||
              terminal ||
              !snapshot.connected ||
              !models.length ||
              missing ||
              !reasons.length ||
              (!snapshot.nativeAuth && !snapshot.pinConfigured)
            }
          >
            {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />}
            {busy ? "正在完成本机验证…" : "确认并授权"}
          </Button>
        </div>
      </footer>
    </>
  );
}
