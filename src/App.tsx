import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  CircleCheck,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { api, desktop } from "@/api";
import type { AgentRequest, Page, Project, UpdateStatus } from "@/types";
import { errorText } from "@/lib/format";
import { useGateway } from "@/hooks/use-gateway";
import { AppSidebar, navigation } from "@/components/app-sidebar";
import { WindowControls } from "@/components/window-controls";
import { ErrorAlert, StatusBadge } from "@/components/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ProjectsPage } from "@/features/projects/projects-page";
import { GrantSheet } from "@/features/projects/grant-sheet";
import { ProjectSheet } from "@/features/projects/project-sheet";
import { SourcesPage } from "@/features/sources/sources-page";
import { UsagePage } from "@/features/usage/usage-page";
import { SettingsPage } from "@/features/settings/settings-page";

type PanelContent =
  | { kind: "grant"; project?: Project; request?: AgentRequest }
  | { kind: "detail"; project: Project };
type Panel = PanelContent & { open: boolean; session: number };

export default function App() {
  const [page, setPage] = useState<Page>("projects");
  const [panel, setPanel] = useState<Panel | null>(null);
  const panelSequence = useRef(0);
  function showPanel(content: PanelContent) {
    setPanel({ ...content, open: true, session: ++panelSequence.current });
  }
  const closePanel = useCallback((session?: number) => {
    setPanel((current) =>
      current && (session === undefined || current.session === session)
        ? { ...current, open: false }
        : current,
    );
  }, []);
  function finishClose(session: number) {
    // Radix calls this after its exit animation. An older panel cannot close a new one.
    setPanel((current) =>
      current?.session === session && !current.open ? null : current,
    );
  }
  const [authorizationTarget, setAuthorizationTarget] = useState(0);
  const { snapshot, loading, error, lastCheckedAt, refresh, rememberProject } =
    useGateway({ autoRefresh: !(panel?.open && panel.kind === "grant") });
  const connected = !!snapshot?.connected && !error;
  useEffect(() => {
    if (!desktop) return;
    let announced = "";
    const listener = listen<UpdateStatus>("update-status", ({ payload }) => {
      if (
        payload.status === "available" &&
        payload.version &&
        payload.version !== announced
      ) {
        announced = payload.version;
        toast.info(`ZeroKey v${payload.version} 可更新`, {
          action: { label: "查看更新", onClick: () => setPage("settings") },
        });
      }
    });
    return () => {
      void listener.then((fn) => fn()).catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!desktop || !panel?.open || panel.kind !== "grant" || !panel.request)
      return;
    let disposed = false;
    const requestId = panel.request.requestId;
    const timer = setInterval(() => {
      void api
        .requestStatus(requestId)
        .then(({ status }) => {
          if (disposed || !["canceled", "expired", "failed"].includes(status))
            return;
          closePanel(panel.session);
          toast.info(
            status === "canceled"
              ? "Agent 申请已取消"
              : status === "expired"
                ? "Agent 申请已过期"
                : "申请未完成，请检查项目状态",
          );
        })
        .catch(() => {});
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [panel, closePanel]);
  useEffect(() => {
    if (!desktop) return;
    const navigation = listen<string>("navigate", ({ payload }) => {
      if (["projects", "sources", "usage", "settings"].includes(payload)) {
        closePanel();
        setPage(payload as Page);
      }
    });
    const changed = listen("projects-changed", () => void refresh());
    return () => {
      void navigation.then((fn) => fn()).catch(() => {});
      void changed.then((fn) => fn()).catch(() => {});
    };
  }, [refresh, closePanel]);
  const projects = snapshot?.projects ?? [];
  const selected =
    panel?.kind === "detail"
      ? (projects.find((project) => project.id === panel.project.id) ??
        panel.project)
      : undefined;
  const title = navigation.find((item) => item.id === page)!.label;
  async function closeGrant() {
    if (panel?.kind === "grant" && panel.request)
      await api.cancel(panel.request.requestId);
    if (panel) closePanel(panel.session);
  }
  function dashboard() {
    void api.dashboard().catch((error) => toast.error(errorText(error)));
  }
  return (
    <TooltipProvider>
      <SidebarProvider
        defaultOpen={false}
        style={{ "--sidebar-width": "10rem" } as React.CSSProperties}
        className="h-svh min-h-0 overflow-hidden"
      >
        <AppSidebar
          page={page}
          onNavigate={(next) => {
            setAuthorizationTarget(0);
            setPage(next);
          }}
          onCredentials={() => {
            setPage("settings");
            setAuthorizationTarget((target) => target + 1);
          }}
          projectCount={projects.length}
        />
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
          <header
            className="relative z-30 flex h-14 shrink-0 select-none items-center gap-3 border-b bg-background pl-4"
            data-tauri-drag-region
            aria-label="ZeroKey 标题栏"
          >
            <div
              className="flex min-w-0 items-center gap-3"
              data-tauri-drag-region
            >
              <SidebarTrigger aria-label="切换侧栏" />
              <Separator
                orientation="vertical"
                className="pointer-events-none h-4"
              />
              <Breadcrumb className="pointer-events-none">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>{title}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </div>
            <div
              className="min-w-8 flex-1 self-stretch"
              data-tauri-drag-region
            />
            <div className="flex items-center gap-2 pr-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <StatusBadge
                    tone={
                      loading
                        ? "neutral"
                        : error
                          ? "warning"
                          : connected
                            ? "success"
                            : "warning"
                    }
                    icon={
                      loading
                        ? Loader2
                        : error
                          ? TriangleAlert
                          : connected
                            ? CircleCheck
                            : Unplug
                    }
                    loading={loading}
                    role="status"
                    tabIndex={0}
                    className="focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {loading
                      ? "正在刷新"
                      : error
                        ? "状态待检查"
                        : connected
                          ? "网关已连接"
                          : "网关未连接"}
                  </StatusBadge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{snapshot?.gateway ?? "正在读取网关"}</p>
                  <p>
                    {lastCheckedAt
                      ? `上次检查 ${lastCheckedAt.toLocaleString("zh-CN", { hour12: false })}`
                      : "尚未完成状态检查"}
                  </p>
                  {error && <p>当前保留上次数据，等待刷新。</p>}
                </TooltipContent>
              </Tooltip>
              {lastCheckedAt && (
                <time
                  dateTime={lastCheckedAt.toISOString()}
                  title={`上次检查 ${lastCheckedAt.toLocaleString("zh-CN", { hour12: false })}`}
                  className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
                >
                  上次检查{" "}
                  {lastCheckedAt.toLocaleTimeString("zh-CN", { hour12: false })}
                </time>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="刷新网关状态"
                    disabled={loading}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw className={loading ? "animate-spin" : ""} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>刷新网关状态</TooltipContent>
              </Tooltip>
            </div>
            {desktop && <Separator orientation="vertical" className="h-4" />}
            <WindowControls />
          </header>
          <ScrollArea
            key={page}
            type="hover"
            className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!"
          >
            <div
              className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-6 lg:p-8"
              aria-busy={loading}
            >
              {error && (
                <div className="space-y-3">
                  <ErrorAlert
                    title="网关状态未更新"
                    message={`${error}${snapshot ? " 当前保留上次读取的数据，请刷新后确认连接、项目状态与用量。" : " 请重试读取网关状态。"}`}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void refresh()}
                    disabled={loading}
                  >
                    重试刷新
                  </Button>
                </div>
              )}
              {!loading && !error && snapshot && !snapshot.connected && (
                <Alert
                  className={
                    desktop
                      ? "border-warning/30 bg-warning/10 text-warning *:data-[slot=alert-description]:text-warning"
                      : undefined
                  }
                >
                  <Unplug />
                  <AlertTitle>
                    {desktop ? "网关未连接" : "浏览器界面预览"}
                  </AlertTitle>
                  <AlertDescription>
                    <p>{snapshot.message ?? "请检查本地网关是否运行。"}</p>
                    {desktop && snapshot.projects.length > 0 && (
                      <p>项目状态与用量可能仍为上次记录，请连接后刷新确认。</p>
                    )}
                    {desktop && page !== "settings" && (
                      <Button
                        variant="link"
                        className="h-auto p-0 text-warning"
                        onClick={() => setPage("settings")}
                      >
                        配置网关连接
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              {loading && !snapshot ? (
                <div
                  className="space-y-6"
                  role="status"
                  aria-label="正在读取网关"
                >
                  <Skeleton className="h-8 w-48" />
                  <Skeleton className="h-4 w-96 max-w-full" />
                  <Skeleton className="h-72 w-full" />
                </div>
              ) : (
                snapshot && (
                  <>
                    {page === "projects" && (
                      <ProjectsPage
                        projects={projects}
                        connected={connected}
                        onAdd={() => showPanel({ kind: "grant" })}
                        onSelect={(project) =>
                          showPanel({ kind: "detail", project })
                        }
                      />
                    )}
                    {page === "sources" && (
                      <SourcesPage
                        models={snapshot.models}
                        connected={connected}
                        onDashboard={dashboard}
                      />
                    )}
                    {page === "usage" && (
                      <UsagePage
                        projects={projects}
                        connected={connected}
                        onDashboard={dashboard}
                      />
                    )}
                    {page === "settings" && (
                      <SettingsPage
                        snapshot={snapshot}
                        onSaved={refresh}
                        authorizationTarget={authorizationTarget}
                      />
                    )}
                  </>
                )
              )}
            </div>
          </ScrollArea>
        </SidebarInset>
        {panel?.kind === "grant" && snapshot && (
          <GrantSheet
            key={panel.session}
            open={panel.open}
            onExited={() => finishClose(panel.session)}
            snapshot={snapshot}
            project={panel.project}
            request={panel.request}
            onClose={closeGrant}
            onSaved={(project) => {
              rememberProject(project);
              showPanel({ kind: "detail", project });
              void refresh();
            }}
          />
        )}
        {selected && panel?.kind === "detail" && (
          <ProjectSheet
            key={panel.session}
            open={panel.open}
            onExited={() => finishClose(panel.session)}
            project={selected}
            connected={connected}
            onClose={() => closePanel(panel.session)}
            onEdit={() => showPanel({ kind: "grant", project: selected })}
            onRevoked={async () => {
              closePanel(panel.session);
              await refresh();
            }}
            onTested={refresh}
          />
        )}
      </SidebarProvider>
      <Toaster closeButton />
    </TooltipProvider>
  );
}
