import {
  Activity,
  KeyRound,
  Layers3,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import type { Page } from "@/types";

export const navigation = [
  { id: "projects" as const, label: "项目授权", icon: KeyRound },
  { id: "sources" as const, label: "模型来源", icon: Layers3 },
  { id: "usage" as const, label: "用量记录", icon: Activity },
  { id: "settings" as const, label: "设置", icon: Settings2 },
];

export function AppSidebar({
  page,
  onNavigate,
  onCredentials,
  projectCount,
}: {
  page: Page;
  onNavigate: (page: Page) => void;
  onCredentials: () => void;
  projectCount: number;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  function navigate(page: Page) {
    onNavigate(page);
    if (isMobile) setOpenMobile(false);
  }
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-14 justify-center" data-tauri-drag-region>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-10"
              onClick={() => navigate("projects")}
              tooltip="ZeroKey"
              aria-label="ZeroKey"
            >
              <KeyRound />
              <span className="font-semibold group-data-[collapsible=icon]:hidden">
                ZeroKey
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <Separator />
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map(({ id, label, icon: Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    tooltip={label}
                    isActive={page === id}
                    className="data-active:text-link"
                    aria-label={label}
                    aria-current={page === id ? "page" : undefined}
                    onClick={() => navigate(id)}
                  >
                    <Icon />
                    <span className="group-data-[collapsible=icon]:hidden">
                      {label}
                    </span>
                  </SidebarMenuButton>
                  {id === "projects" && (
                    <SidebarMenuBadge>{projectCount}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="凭证保存在系统凭据库"
              aria-label="系统凭据库"
              onClick={() => {
                onCredentials();
                if (isMobile) setOpenMobile(false);
              }}
            >
              <ShieldCheck />
              <span className="group-data-[collapsible=icon]:hidden">
                系统凭据库
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <p className="px-2 pb-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          ZeroKey Desktop · v0.1.0
        </p>
      </SidebarFooter>
    </Sidebar>
  );
}
