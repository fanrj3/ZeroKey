import { useLayoutEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Fingerprint, Folder, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { api, desktop } from "@/api";
import type { AgentRequest, GrantRequest, Project, Snapshot } from "@/types";
import {
  durationLabel,
  modelCapability,
  modelLabel,
  sourceName,
} from "@/types";
import { errorText, filterModels, money } from "@/lib/format";
import { ErrorAlert, SearchInput } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export function GrantSheet({
  snapshot,
  project,
  request,
  onClose,
  onSaved,
}: {
  snapshot: Snapshot;
  project?: Project;
  request?: AgentRequest;
  onClose: () => Promise<void>;
  onSaved: (project: Project) => void;
}) {
  const [name, setName] = useState(project?.name ?? request?.name ?? "");
  const [path, setPath] = useState(project?.path ?? request?.path ?? "");
  const [models, setModels] = useState<string[]>(
    project?.models ?? request?.models ?? [],
  );
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [modelPickerOpen, setModelPickerOpen] = useState(!request);
  const [budget, setBudget] = useState(
    String(project?.dailyBudget ?? request?.dailyBudget ?? 1),
  );
  const [duration, setDuration] = useState(
    project?.duration ?? request?.duration ?? "unlimited",
  );
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string } | null>(null);
  const failureRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!failure) return;
    failureRef.current?.focus({ preventScroll: true });
    failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);
  function reportError(error: unknown) {
    setFailure({ message: errorText(error) });
  }
  const sources = [...new Set(snapshot.models.map((model) => model.source))];
  const matches = filterModels(snapshot.models, source, query);
  const missing = models.filter(
    (id) => !snapshot.models.some((model) => model.id === id),
  );
  async function chooseFolder() {
    try {
      const result = await open({
        directory: true,
        multiple: false,
        title: "选择项目文件夹",
      });
      if (typeof result === "string") {
        setPath(result);
        if (!name) setName(result.split(/[\\/]/).filter(Boolean).pop() ?? "");
      }
    } catch (error) {
      reportError(error);
    }
  }
  async function close() {
    if (busy) return;
    setBusy(true);
    try {
      await onClose();
    } catch (error) {
      reportError(error);
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!models.length || missing.length) {
      reportError("请选择当前目录中的模型，移除已不可用的条目。");
      return;
    }
    setBusy(true);
    setFailure(null);
    const grant: GrantRequest = {
      name,
      path,
      models,
      dailyBudget: Number(budget),
      duration: duration === "unlimited" ? null : duration,
      pin: pin || null,
      requestId: request?.requestId,
    };
    let savedProject: Project;
    try {
      savedProject = await api.grant(grant);
    } catch (error) {
      reportError(error);
      setPin("");
      setBusy(false);
      return;
    }
    setPin("");
    toast.success("项目授权已保存，可在 Agent 中复用");
    onSaved(savedProject);
  }
  return (
    <Sheet
      open
      onOpenChange={(value) => {
        if (!value) void close();
      }}
    >
      <SheetContent
        className="overflow-hidden gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        showCloseButton={!busy}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <SheetHeader className="shrink-0 border-b p-6 pr-12">
          <SheetTitle>
            {request
              ? "Agent 申请项目授权"
              : project
                ? "调整项目授权"
                : "添加项目授权"}
          </SheetTitle>
          <SheetDescription>
            核对项目、模型与预算，再完成本机验证。
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
          <form
            id="grant-form"
            onSubmit={(event) => void submit(event)}
            className="p-6"
          >
            <FieldGroup>
              {failure && (
                <ErrorAlert
                  ref={failureRef}
                  id="grant-error"
                  tabIndex={-1}
                  message={failure.message}
                  title="请检查后重试"
                  className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              )}
              <Field>
                <FieldLabel htmlFor="project-path">项目文件夹</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="project-path"
                    value={path}
                    onChange={(event) => setPath(event.target.value)}
                    required
                    placeholder="选择本地项目文件夹"
                    disabled={busy || !!request}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    disabled={busy || !desktop || !!request}
                    onClick={() => void chooseFolder()}
                    aria-label="选择项目文件夹"
                  >
                    <Folder />
                  </Button>
                </div>
              </Field>
              <Field>
                <FieldLabel htmlFor="project-name">项目名称</FieldLabel>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={100}
                  required
                  disabled={busy}
                  placeholder="例如：图片标注工具"
                />
              </Field>
              <FieldSet aria-describedby="grant-model-help">
                <FieldLegend variant="label">允许的模型</FieldLegend>
                <FieldDescription id="grant-model-help">
                  按需授权，目录条目需实际调用确认可用性。标签仅表示接口类型；图片、音频和视频需单独适配。
                </FieldDescription>
                {models.length > 0 && (
                  <div
                    className="flex flex-wrap gap-2"
                    aria-label="已选择的模型"
                  >
                    {models.map((id) => (
                      <Badge
                        key={id}
                        variant={
                          missing.includes(id) ? "destructive" : "secondary"
                        }
                        className="max-w-full whitespace-normal break-all"
                      >
                        {id}
                      </Badge>
                    ))}
                  </div>
                )}
                <Collapsible
                  open={modelPickerOpen}
                  onOpenChange={setModelPickerOpen}
                  className="min-w-0 space-y-3"
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      className="group"
                    >
                      {models.length ? "调整模型" : "选择模型"}
                      <ChevronDown className="group-data-[state=open]:rotate-180" />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Select
                        value={source}
                        onValueChange={setSource}
                        disabled={busy}
                      >
                        <SelectTrigger
                          aria-label="按来源筛选授权模型"
                          className="w-40"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">全部来源</SelectItem>
                          {sources.map((source) => (
                            <SelectItem value={source} key={source}>
                              {sourceName(source)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <SearchInput
                        label="搜索授权模型"
                        value={query}
                        onChange={setQuery}
                      />
                    </div>
                    {models.length > 0 && (
                      <div
                        className="flex flex-wrap gap-2"
                        aria-label="已选择的模型"
                      >
                        {models.map((id) => (
                          <Button
                            type="button"
                            key={id}
                            variant={
                              missing.includes(id) ? "destructive" : "secondary"
                            }
                            size="xs"
                            className="h-auto max-w-full whitespace-normal break-all py-1"
                            disabled={busy}
                            onClick={() =>
                              setModels(models.filter((model) => model !== id))
                            }
                            aria-label={`移除 ${id}`}
                          >
                            {id} <X aria-hidden="true" />
                          </Button>
                        ))}
                      </div>
                    )}
                    <ScrollArea className="h-48 min-h-0 overflow-hidden rounded-lg border [&>[data-slot=scroll-area-viewport]>div]:block!">
                      <div className="divide-y">
                        {matches.map((model, index) => (
                          <Field
                            key={model.id}
                            orientation="horizontal"
                            className="gap-3 p-3"
                          >
                            <Checkbox
                              id={`grant-model-${index}`}
                              checked={models.includes(model.id)}
                              disabled={busy}
                              onCheckedChange={(checked) =>
                                setModels(
                                  checked === true
                                    ? [...new Set([...models, model.id])]
                                    : models.filter((id) => id !== model.id),
                                )
                              }
                            />
                            <div className="min-w-0 flex-1">
                              <FieldLabel
                                htmlFor={`grant-model-${index}`}
                                className="break-all text-sm font-normal"
                              >
                                {modelLabel(model.id)}
                              </FieldLabel>
                              <FieldDescription>
                                {sourceName(model.source)}
                              </FieldDescription>
                            </div>
                            <Badge variant="outline" className="shrink-0">
                              {modelCapability(model.protocol)}
                            </Badge>
                          </Field>
                        ))}
                        {!matches.length && (
                          <p className="p-6 text-center text-sm text-muted-foreground">
                            没有匹配的模型。
                          </p>
                        )}
                      </div>
                    </ScrollArea>
                  </CollapsibleContent>
                </Collapsible>
              </FieldSet>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="daily-budget">
                    每日预算（美元）
                  </FieldLabel>
                  <Input
                    id="daily-budget"
                    aria-describedby="grant-budget-help"
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="grant-duration">有效期</FieldLabel>
                  <Select
                    value={duration}
                    onValueChange={setDuration}
                    disabled={busy}
                  >
                    <SelectTrigger id="grant-duration" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unlimited">长期有效</SelectItem>
                      <SelectItem value="7d">七天</SelectItem>
                      <SelectItem value="30d">三十天</SelectItem>
                      <SelectItem value="90d">九十天</SelectItem>
                      {!["unlimited", "7d", "30d", "90d"].includes(
                        duration,
                      ) && <SelectItem value={duration}>{duration}</SelectItem>}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <FieldDescription id="grant-budget-help">
                按你设置的每日预算限制用量，随网关预算窗口重置。中转站实际扣费和
                OpenCode Go 套餐额度以来源后台为准。
              </FieldDescription>
              <p className="text-sm text-muted-foreground">
                {snapshot.nativeAuth
                  ? "通过 Windows Hello 确认授权"
                  : "通过 ZeroKey 授权 PIN 确认授权"}
                ，凭证保存到{snapshot.credentialStore}，日常直接复用。
              </p>
              {!snapshot.nativeAuth && (
                <Field>
                  <FieldLabel htmlFor="grant-pin">ZeroKey 授权 PIN</FieldLabel>
                  <Input
                    id="grant-pin"
                    type="password"
                    inputMode="numeric"
                    autoComplete="off"
                    required
                    value={pin}
                    onChange={(event) => setPin(event.target.value)}
                    disabled={busy || !snapshot.pinConfigured}
                  />
                  <FieldDescription>
                    {snapshot.pinConfigured
                      ? "这是本机应用的授权 PIN。"
                      : "请先在设置中创建授权 PIN。"}
                  </FieldDescription>
                </Field>
              )}
            </FieldGroup>
          </form>
        </ScrollArea>
        <SheetFooter className="shrink-0 border-t p-6">
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {models.length} 个模型 · 每天 {money(Number(budget) || 0)} ·{" "}
            {durationLabel(duration)}
          </p>
          {busy && (
            <p className="text-xs text-muted-foreground" role="status">
              {snapshot.nativeAuth
                ? "请完成 ZeroKey 窗口中的 Windows Hello 验证；等待超过 90 秒会结束，不会自动签发。"
                : "正在验证授权并保存凭证，请稍候。"}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void close()}
            >
              取消
            </Button>
            <Button
              type="submit"
              form="grant-form"
              disabled={
                busy ||
                !desktop ||
                !snapshot.connected ||
                !models.length ||
                !!missing.length ||
                (!snapshot.nativeAuth && !snapshot.pinConfigured)
              }
            >
              {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />}
              {busy ? "正在处理授权…" : "确认并授权"}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
