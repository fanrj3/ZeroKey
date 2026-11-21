import type { ComponentProps, ReactNode } from "react";
import {
  AlertCircle,
  Ban,
  CircleCheck,
  CircleHelp,
  Clock3,
  Search,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Project } from "@/types";
import { projectStatus } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";

const statusClasses = {
  success: "border-success/20 bg-success/10 text-success",
  warning: "border-warning/20 bg-warning/10 text-warning",
  danger: "border-destructive/20 bg-destructive/10 text-destructive",
  neutral: "border-border bg-secondary text-secondary-foreground",
};

export function StatusBadge({
  tone,
  icon: Icon,
  loading = false,
  className,
  children,
  ...props
}: ComponentProps<typeof Badge> & {
  tone: keyof typeof statusClasses;
  icon: LucideIcon;
  loading?: boolean;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(statusClasses[tone], className)}
      {...props}
    >
      <Icon
        aria-hidden="true"
        className={loading ? "animate-spin" : undefined}
      />
      {children}
    </Badge>
  );
}

export function ProjectStatusBadge({ project }: { project: Project }) {
  const tone =
    project.status === "active"
      ? "success"
      : ["blocked", "revoked", "unavailable"].includes(project.status)
        ? "danger"
        : "warning";
  const icon =
    project.status === "active"
      ? CircleCheck
      : project.status === "expired"
        ? Clock3
        : ["blocked", "revoked", "unavailable"].includes(project.status)
          ? Ban
          : CircleHelp;
  return (
    <StatusBadge tone={tone} icon={icon}>
      {projectStatus(project)}
    </StatusBadge>
  );
}

export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
export function ErrorAlert({
  message,
  title = "操作未完成",
  ...props
}: ComponentProps<typeof Alert> & { message: string; title?: string }) {
  return (
    <Alert
      variant="destructive"
      aria-labelledby={props.id ? `${props.id}-title` : undefined}
      aria-describedby={props.id ? `${props.id}-description` : undefined}
      {...props}
    >
      <AlertCircle />
      <AlertTitle id={props.id ? `${props.id}-title` : undefined}>
        {title}
      </AlertTitle>
      <AlertDescription
        id={props.id ? `${props.id}-description` : undefined}
        className="break-words"
      >
        {message}
      </AlertDescription>
    </Alert>
  );
}
export function SearchInput({
  value,
  onChange,
  label,
  placeholder = label,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
}) {
  return (
    <InputGroup className="w-full sm:w-64">
      <InputGroupInput
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
    </InputGroup>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Empty className="min-h-64">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
export function ListPagination({
  page,
  total,
  size,
  onChange,
}: {
  page: number;
  total: number;
  size: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <span className="text-muted-foreground">
        共 {total} 条
        {total > 0 &&
          ` · 第 ${(page - 1) * size + 1}–${Math.min(page * size, total)} 条`}
      </span>
      {pages > 1 && (
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => onChange(page - 1)}
              >
                上一页
              </Button>
            </PaginationItem>
            <PaginationItem>
              <span className="px-2 tabular-nums" aria-live="polite">
                {page} / {pages}
              </span>
            </PaginationItem>
            <PaginationItem>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pages}
                onClick={() => onChange(page + 1)}
              >
                下一页
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
    </div>
  );
}
