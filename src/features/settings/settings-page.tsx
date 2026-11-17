import { useEffect, useRef, useState } from "react";
import {
  Fingerprint,
  Loader2,
  Monitor,
  Moon,
  Palette,
  Server,
  ShieldCheck,
  Sun,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { api, desktop } from "@/api";
import type { Snapshot } from "@/types";
import { errorText } from "@/lib/format";
import { ErrorAlert, PageHeading, StatusBadge } from "@/components/shared";
import { useTheme } from "@/components/theme-provider";
import type { Theme } from "@/components/theme-provider";
import { AgentSettings } from "./agent-settings";
import { UpdateSettings } from "./update-settings";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function SettingsPage({
  snapshot,
  onSaved,
  authorizationTarget,
}: {
  snapshot: Snapshot;
  onSaved: () => Promise<void>;
  authorizationTarget: number;
}) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [gateway, setGateway] = useState(snapshot.gateway);
  const [master, setMaster] = useState("");
  const [pin, setPin] = useState("");
  const [previous, setPrevious] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState<"gateway" | "pin" | null>(null);
  const [error, setError] = useState("");
  const authorizationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!authorizationTarget) return;
    authorizationRef.current?.focus({ preventScroll: true });
    authorizationRef.current?.scrollIntoView({ block: "start" });
  }, [authorizationTarget]);
  async function connect() {
    setBusy("gateway");
    setError("");
    try {
      await api.connect(gateway, master);
      setMaster("");
      toast.success("网关连接已保存");
      await onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  async function savePin() {
    if (pin !== confirmation) {
      setError("两次输入的 PIN 不一致，请重新确认。");
      return;
    }
    setBusy("pin");
    setError("");
    try {
      await api.setPin(pin, previous || null);
      setPin("");
      setPrevious("");
      setConfirmation("");
      toast.success("本机授权 PIN 已保存");
      await onSaved();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <PageHeading
        title="设置"
        description="管理界面外观、网关连接与本机授权方式。"
      />
      <div className="grid max-w-3xl gap-6">
        {error && <ErrorAlert message={error} />}
        <UpdateSettings />
        <AgentSettings />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Palette className="size-4" />
              外观
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Field>
              <FieldLabel htmlFor="appearance-theme">主题模式</FieldLabel>
              <Select
                value={theme}
                onValueChange={(value) => setTheme(value as Theme)}
              >
                <SelectTrigger
                  id="appearance-theme"
                  aria-describedby="appearance-description"
                  className="w-full sm:w-60"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">
                    <Moon />
                    深色
                  </SelectItem>
                  <SelectItem value="light">
                    <Sun />
                    浅色
                  </SelectItem>
                  <SelectItem value="system">
                    <Monitor />
                    跟随系统
                  </SelectItem>
                </SelectContent>
              </Select>
              <FieldDescription id="appearance-description">
                {theme === "system"
                  ? `当前跟随系统使用${resolvedTheme === "dark" ? "深色" : "浅色"}。`
                  : "在本机保存，立即生效。"}
              </FieldDescription>
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="size-4" />
              LiteLLM 网关
            </CardTitle>
            <CardDescription>
              管理 Key 由系统凭据库保存，用于签发项目虚拟凭证。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void connect();
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="gateway">网关地址</FieldLabel>
                  <Input
                    id="gateway"
                    type="url"
                    value={gateway}
                    onChange={(event) => setGateway(event.target.value)}
                    required
                    disabled={!!busy || !desktop}
                    placeholder="http://127.0.0.1:4000"
                  />
                  <FieldDescription>
                    远程网关使用 HTTPS，本机地址允许 HTTP。
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="master">网关管理 Key</FieldLabel>
                  <Input
                    id="master"
                    type="password"
                    autoComplete="off"
                    value={master}
                    onChange={(event) => setMaster(event.target.value)}
                    required
                    disabled={!!busy || !desktop}
                    placeholder={
                      snapshot.connected
                        ? "已保存；更新连接时填写管理 Key"
                        : "在此本地界面填写"
                    }
                  />
                </Field>
                <div>
                  <Button type="submit" disabled={!!busy || !desktop}>
                    {busy === "gateway" && <Loader2 className="animate-spin" />}
                    验证并保存连接
                  </Button>
                </div>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
        <Card
          id="local-authorization"
          ref={authorizationRef}
          tabIndex={-1}
          aria-labelledby="local-authorization-title"
          className="scroll-mt-20 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <CardHeader>
            <CardTitle
              id="local-authorization-title"
              className="flex items-center gap-2"
            >
              <Fingerprint className="size-4" />
              本机授权
            </CardTitle>
            <CardDescription>
              {snapshot.nativeAuth
                ? "首次或变更授权时调用 Windows Hello，日常运行复用已有凭证。"
                : "此环境使用独立的 ZeroKey 授权 PIN，尚未启用系统生物识别。"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-8 gap-y-4 text-sm">
              <dt className="text-muted-foreground">凭据存储</dt>
              <dd>{snapshot.credentialStore}</dd>
              <dt className="text-muted-foreground">Windows Hello</dt>
              <dd>
                <StatusBadge
                  tone={snapshot.nativeAuth ? "success" : "warning"}
                  icon={snapshot.nativeAuth ? ShieldCheck : TriangleAlert}
                >
                  {snapshot.nativeAuth ? "可用" : "此环境不可用"}
                </StatusBadge>
              </dd>
            </dl>
            {!snapshot.nativeAuth && (
              <>
                <Separator />
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void savePin();
                  }}
                >
                  <FieldGroup>
                    {snapshot.pinConfigured && (
                      <Field>
                        <FieldLabel htmlFor="previous-pin">
                          当前授权 PIN
                        </FieldLabel>
                        <Input
                          id="previous-pin"
                          type="password"
                          autoComplete="off"
                          inputMode="numeric"
                          required
                          value={previous}
                          onChange={(event) => setPrevious(event.target.value)}
                          disabled={!!busy || !desktop}
                        />
                      </Field>
                    )}
                    <Field>
                      <FieldLabel htmlFor="new-pin">
                        {snapshot.pinConfigured
                          ? "新的授权 PIN"
                          : "设置授权 PIN"}
                      </FieldLabel>
                      <Input
                        id="new-pin"
                        type="password"
                        inputMode="numeric"
                        autoComplete="new-password"
                        pattern="[0-9]{6,32}"
                        minLength={6}
                        maxLength={32}
                        required
                        value={pin}
                        onChange={(event) => setPin(event.target.value)}
                        disabled={!!busy || !desktop}
                      />
                      <FieldDescription>
                        6–32 位数字，与系统登录 PIN 独立。
                      </FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="confirm-pin">
                        再次输入 PIN
                      </FieldLabel>
                      <Input
                        id="confirm-pin"
                        type="password"
                        inputMode="numeric"
                        autoComplete="new-password"
                        required
                        value={confirmation}
                        onChange={(event) =>
                          setConfirmation(event.target.value)
                        }
                        disabled={!!busy || !desktop}
                      />
                    </Field>
                    <div>
                      <Button disabled={!!busy || !desktop}>
                        {busy === "pin" && <Loader2 className="animate-spin" />}
                        保存授权 PIN
                      </Button>
                    </div>
                  </FieldGroup>
                </form>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
