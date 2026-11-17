import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { toast } from "sonner";
import { desktop } from "@/api";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!desktop) return;
    const window = getCurrentWindow();
    let disposed = false;
    const update = () => {
      void window
        .isMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {});
    };
    update();
    const listener = window.onResized(update);
    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  if (!desktop) return null;

  const actions = [
    { label: "最小化", icon: Minus, run: () => getCurrentWindow().minimize() },
    {
      label: maximized ? "还原窗口" : "最大化",
      icon: maximized ? Copy : Square,
      run: () => getCurrentWindow().toggleMaximize(),
    },
    { label: "关闭窗口", icon: X, run: () => getCurrentWindow().close() },
  ];

  return (
    <div className="flex h-full shrink-0" role="group" aria-label="窗口操作">
      {actions.map(({ label, icon: Icon, run }) => (
        <Tooltip key={label}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={`h-full w-11 rounded-none ${label === "关闭窗口" ? "hover:bg-destructive hover:text-background dark:hover:bg-destructive" : ""}`}
              aria-label={label}
              onClick={() => {
                void run().catch(() => toast.error(`无法${label}，请重试。`));
              }}
            >
              <Icon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
