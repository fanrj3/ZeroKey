import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Ban,
  CircleCheck,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { api, desktop } from "@/api";
import type { Model, SourceStatus } from "@/types";
import { modelCapability, sourceName } from "@/types";
import { errorText } from "@/lib/format";
import { ErrorAlert, StatusBadge } from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function time(value: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚未同步";
}

export function SourceSync({
  models,
  connected,
  onSynced,
}: {
  models: Model[];
  connected: boolean;
  onSynced: () => Promise<void>;
}) {
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [loading, setLoading] = useState(desktop);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<SourceStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [failure, setFailure] = useState("");
  const failureRef = useRef<HTMLDivElement>(null);
  const reviewError = failure || review?.error;
  useLayoutEffect(() => {
    if (!open || !reviewError) return;
    failureRef.current?.focus({ preventScroll: true });
    failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, reviewError]);
  const load = useCallback(async () => {
    if (!desktop) return;
    try {
      setSources(await api.sources());
      setError("");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (connected) void load();
    else setLoading(false);
    if (!desktop) return;
    const listener = listen("sources-changed", () => void load());
    return () => {
      void listener.then((fn) => fn()).catch(() => {});
    };
  }, [load, connected]);
  function remember(source: SourceStatus) {
    setSources((current) =>
      [...current.filter((item) => item.id !== source.id), source].sort(
        (a, b) => a.id.localeCompare(b.id),
      ),
    );
  }
  async function check(id: string) {
    setBusy(id);
    setError("");
    try {
      const source = await api.checkSource(id);
      remember(source);
      setReview(source);
      setSelected(source.pending.map((model) => model.id));
      setFailure("");
      setOpen(true);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  async function apply() {
    if (!review) return;
    setBusy(review.id);
    setFailure("");
    try {
      const result = await api.applySource(review.id, selected);
      remember(result);
      setReview(result);
      setSelected((current) =>
        current.filter((id) => result.pending.some((model) => model.id === id)),
      );
      if (result.error) setFailure(result.error);
      else
        toast.success(
          result.lastAdded.length
            ? `已添加 ${result.lastAdded.length} 个模型，可在项目授权中选择`
            : "所选模型已在网关中，无需重复添加",
        );
      await onSynced();
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  async function automatic(source: SourceStatus, enabled: boolean) {
    setBusy(source.id);
    setError("");
    try {
      remember(await api.sourceAutoAdd(source.id, enabled));
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  const ids = [
    ...new Set([
      ...models.map((model) => model.source),
      ...sources.map((source) => source.id),
    ]),
  ].sort();
  return (
    <>
      <section
        className="overflow-hidden rounded-xl border"
        aria-label="来源同步"
      >
        <div className="space-y-1 border-b p-4">
          <h2 className="text-sm font-medium">来源同步</h2>
          <p className="text-xs text-muted-foreground">
            手动同步先预览再添加。自动添加默认关闭，开启后在启动时及每 6
            小时检查，托盘运行期间也有效。
          </p>
        </div>
        {error && (
          <div className="space-y-2 border-b p-4">
            <ErrorAlert title="来源同步需要检查" message={error} />
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试读取状态
            </Button>
          </div>
        )}
        {loading ? (
          <div
            className="space-y-3 p-4"
            role="status"
            aria-label="正在读取同步状态"
          >
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : ids.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">来源</TableHead>
                <TableHead>同步状态</TableHead>
                <TableHead>自动添加</TableHead>
                <TableHead className="pr-4 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ids.map((id) => {
                const source = sources.find((source) => source.id === id);
                const working = busy === id;
                return (
                  <TableRow key={id}>
                    <TableCell className="pl-4">
                      <p className="font-medium">{sourceName(id)}</p>
                      <p className="text-xs text-muted-foreground">
                        {source?.registered ??
                          models.filter((model) => model.source === id)
                            .length}{" "}
                        个已接入
                      </p>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        {source?.error ? (
                          <StatusBadge tone="warning" icon={TriangleAlert}>
                            同步失败
                          </StatusBadge>
                        ) : source?.pending.length ? (
                          <Badge variant="secondary">
                            发现 {source.pending.length} 个新模型
                          </Badge>
                        ) : source?.checkedAt ? (
                          <StatusBadge tone="success" icon={CircleCheck}>
                            目录已检查
                          </StatusBadge>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            尚未检查
                          </span>
                        )}
                        <p className="text-xs text-muted-foreground">
                          上次同步：
                          {time(source?.syncedAt ?? source?.checkedAt ?? null)}
                        </p>
                        {!!source?.missing.length && (
                          <StatusBadge tone="danger" icon={Ban}>
                            {source.missing.length} 个型号不可获取
                          </StatusBadge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <label className="inline-flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={source?.autoAdd ?? false}
                          disabled={
                            !!busy ||
                            !desktop ||
                            !connected ||
                            !source?.supported
                          }
                          aria-label={`自动添加 ${sourceName(id)} 新模型`}
                          onCheckedChange={(checked) =>
                            source && void automatic(source, checked === true)
                          }
                        />
                        开启
                      </label>
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          !!busy || !desktop || !connected || !source?.supported
                        }
                        onClick={() => void check(id)}
                        aria-label={`同步 ${sourceName(id)} 模型`}
                      >
                        {working ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <RefreshCw />
                        )}
                        同步模型
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            连接网关并添加来源后，可在这里同步模型。
          </p>
        )}
      </section>
      <Sheet
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <SheetContent
          className="gap-0 data-open:duration-200 data-closed:duration-150 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
          showCloseButton={!busy}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <SheetHeader className="border-b p-6 pr-12">
            <SheetTitle>同步预览 · {sourceName(review?.id ?? "")}</SheetTitle>
            <SheetDescription>
              选择要接入的型号。添加后可为项目申请授权；已有项目权限由各自授权决定。
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
            <div className="space-y-5 p-6">
              {(failure || review?.error) && (
                <div className="space-y-2">
                  <ErrorAlert
                    id="source-sync-error"
                    ref={failureRef}
                    tabIndex={-1}
                    title="同步需要处理"
                    message={failure || review!.error!}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!busy}
                    onClick={() => review && void check(review.id)}
                  >
                    重新检查目录
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                上次检查：{time(review?.checkedAt ?? null)}
              </p>
              {!!review?.lastAdded.length && (
                <div className="space-y-2">
                  <StatusBadge tone="success" icon={CircleCheck}>
                    已添加 {review.lastAdded.length} 个模型
                  </StatusBadge>
                  <p className="text-sm text-muted-foreground break-words">
                    {review.lastAdded.join("、")}
                  </p>
                </div>
              )}
              {review?.pending.length ? (
                <fieldset className="space-y-3">
                  <legend className="mb-3 font-medium">
                    发现 {review.pending.length} 个新模型
                  </legend>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      aria-label="选择全部新模型"
                      disabled={!!busy}
                      checked={
                        selected.length === review.pending.length
                          ? true
                          : selected.length
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked === true
                            ? review.pending.map((model) => model.id)
                            : [],
                        )
                      }
                    />
                    全选
                  </label>
                  <div className="divide-y rounded-lg border">
                    {review.pending.map((model) => (
                      <label
                        key={model.id}
                        className="flex cursor-pointer items-center gap-3 p-3"
                      >
                        <Checkbox
                          aria-label={`添加 ${model.id}`}
                          disabled={!!busy}
                          checked={selected.includes(model.id)}
                          onCheckedChange={(checked) =>
                            setSelected((current) =>
                              checked === true
                                ? [...current, model.id]
                                : current.filter((id) => id !== model.id),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 break-all font-mono text-xs">
                          {model.id}
                        </span>
                        <Badge variant="outline">
                          {modelCapability(model.protocol)}
                        </Badge>
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : (
                !review?.error && (
                  <p className="text-sm">当前没有待添加的型号。</p>
                )
              )}
              {!!review?.missing.length && (
                <section className="space-y-2">
                  <h3 className="font-medium text-destructive">
                    {review.missing.length} 个型号不可获取
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    上游最近一次成功同步未返回这些型号，已从可选目录中移除。后续同步重新返回时恢复可选。
                  </p>
                  <ul className="space-y-1 text-xs">
                    {review.missing.map((id) => (
                      <li className="break-all font-mono" key={id}>
                        {id}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {!!review?.history.length && (
                <section className="space-y-3">
                  <h3 className="font-medium">最近同步记录</h3>
                  <ol className="space-y-3 text-xs">
                    {review.history.map((event, index) => (
                      <li key={`${event.at}-${index}`} className="space-y-1">
                        <p>
                          {time(event.at)} ·{" "}
                          {event.action === "auto"
                            ? "自动同步"
                            : event.action === "add"
                              ? "手动添加"
                              : "检查目录"}
                        </p>
                        <p
                          className={
                            event.error
                              ? "text-warning"
                              : "text-muted-foreground"
                          }
                        >
                          {event.error ??
                            `新增 ${event.added} · 待添加 ${event.pending} · 不可获取 ${event.missing}`}
                        </p>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
            </div>
          </ScrollArea>
          <SheetFooter className="border-t p-6">
            <p className="text-xs text-muted-foreground">
              目录接入后仍需实际调用确认可用性。
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => setOpen(false)}
              >
                关闭
              </Button>
              <Button
                disabled={!!busy || !selected.length || !connected}
                onClick={() => void apply()}
              >
                {busy && <Loader2 className="animate-spin" />}确认添加
                {selected.length ? ` ${selected.length} 个模型` : ""}
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
