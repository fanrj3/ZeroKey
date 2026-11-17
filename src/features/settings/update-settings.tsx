import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowDownToLine, CircleCheck, Loader2, RefreshCw } from "lucide-react";
import { api, desktop } from "@/api";
import type { UpdateStatus } from "@/types";
import { errorText } from "@/lib/format";
import { ErrorAlert } from "@/components/shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export function UpdateSettings() {
  const [data, setData] = useState<UpdateStatus | null>(null);
  const [failure, setFailure] = useState("");
  const [acting, setActing] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let revision = 0;
    const listener = listen<UpdateStatus>("update-status", ({ payload }) => {
      revision++;
      if (!disposed) {
        setData(payload);
        setFailure("");
      }
    });
    void listener
      .then(async () => {
        const current = revision;
        const status = await api.updateStatus();
        if (!disposed && current === revision) setData(status);
      })
      .catch((error) => {
        if (!disposed) setFailure(errorText(error));
      });
    return () => {
      disposed = true;
      void listener.then((fn) => fn()).catch(() => {});
    };
  }, []);
  const downloading = data?.status === "downloading";
  const installing = data?.status === "installing";
  const busy =
    acting ||
    ["checking", "downloading", "installing"].includes(data?.status ?? "");
  async function perform(install = false) {
    setActing(true);
    setFailure("");
    try {
      if (install) await api.installUpdate();
      else setData(await api.checkUpdate());
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setActing(false);
    }
  }
  const percentage = data?.total
    ? Math.min(100, Math.round((data.downloaded / data.total) * 100))
    : undefined;
  return (
    <Card id="software-updates">
      <CardHeader>
        <CardTitle>软件更新</CardTitle>
        <CardDescription>
          启动后自动检查 GitHub Release，每 6 小时检查一次。安装更新会重启
          ZeroKey。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1 text-sm" role="status" aria-live="polite">
            <p>
              当前版本{" "}
              <span className="font-medium tabular-nums">
                {data
                  ? `v${data.currentVersion}`
                  : desktop
                    ? "正在读取…"
                    : "桌面应用中可用"}
              </span>
            </p>
            <p className="flex items-center gap-2 text-muted-foreground">
              {data?.status === "latest" && (
                <CircleCheck className="size-4 text-success" />
              )}
              {data?.status === "checking"
                ? "正在检查 GitHub…"
                : downloading
                  ? "正在下载并校验签名…"
                  : installing
                    ? "正在安装，即将重启…"
                    : data?.version
                      ? `发现新版本 v${data.version}`
                      : data?.status === "latest"
                        ? "已是最新版本"
                        : "从 GitHub 获取官方发布版本"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!desktop || busy}
              onClick={() => void perform()}
            >
              {data?.status === "checking" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              检查更新
            </Button>
            {data?.version && (
              <Button disabled={busy} onClick={() => void perform(true)}>
                {downloading || installing ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <ArrowDownToLine />
                )}
                {installing
                  ? "正在安装"
                  : downloading
                    ? "正在下载"
                    : "下载并重启更新"}
              </Button>
            )}
          </div>
        </div>
        {downloading && (
          <div className="space-y-2">
            <Progress
              value={percentage}
              aria-label="更新下载进度"
              aria-valuetext={
                percentage === undefined ? "正在下载" : `${percentage}%`
              }
            />
            <p className="text-xs tabular-nums text-muted-foreground">
              {(data.downloaded / 1048576).toFixed(1)} MB
              {data.total
                ? ` / ${(data.total / 1048576).toFixed(1)} MB · ${percentage}%`
                : ""}
            </p>
          </div>
        )}
        {(failure || data?.error) && (
          <ErrorAlert message={failure || data!.error!} />
        )}
        {data?.notes && (
          <div className="space-y-2 text-sm">
            <p className="font-medium">更新说明</p>
            <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
              {data.notes}
            </p>
          </div>
        )}
        {data?.checkedAt && (
          <p className="text-xs text-muted-foreground">
            上次检查：{new Date(data.checkedAt).toLocaleString("zh-CN")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
