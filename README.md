# ZeroKey

本地模型访问管理工具。让 Agent 申请受限的项目凭证，由你在桌面审核并完成 Windows Hello/PIN，应用随后通过启动器调用模型。上游 Key 留在 LiteLLM，明文项目 Key 不返回聊天、前端或 MCP。

Tauri 2 · React · TypeScript · Vite · shadcn/ui · LiteLLM

## 安装

从 [GitHub Releases](https://github.com/fanrj3/ZeroKey/releases/latest) 下载 `ZeroKey_*_x64-setup.exe`。当前发布 Windows x64 安装版，内置 Node 24 LTS 与 Agent 运行脚本。macOS/Linux 暂仅提供源码，未完成平台构建验证。

1. 准备一个启用数据库的 LiteLLM 网关，在其管理后台添加来源和模型。
2. 打开 ZeroKey，在「设置 → LiteLLM 网关」保存网关地址与管理 Key。管理 Key 存入系统凭据库。
3. 在「设置 → Agent 接入」选择 Codex、Claude Code 或 OpenCode，合并 MCP 配置，再重载客户端。
4. 让 Agent 查询模型、申请项目访问。托盘驻留即可收到独立审核窗口；你确认后再完成系统验证。
5. Agent 使用 MCP 返回的模板和启动器完成首次文字调用，后续复用已有授权。

配置已保存、实际已连接、工具已发现会分别显示。已有冲突配置不会被自动覆盖，原配置修改前备份。完整说明见 [MCP 接入](docs/mcp.md)。

## 桌面与授权

- 每项目限制模型、每日预算和期限，默认长期有效；更改权限需本机确认。
- Windows 使用 Windows Hello；其他平台目前使用独立的应用 PIN。
- 关闭窗口只隐藏，ZeroKey 继续驻留托盘。菜单显示网关、项目和当前预算周期估算用量，可打开窗口、审核、设置、检查更新或退出。
- 默认紧凑窗口与折叠侧栏，支持深色、浅色及跟随系统。
- 「模型来源」支持按来源同步并预览新增型号，可选择自动添加；上游移除的型号标记待检查，保留已有项目授权。详见[来源同步](docs/source-sync.md)。
- 启动后及每 6 小时自动从本仓库 GitHub Release 检查更新。设置页可手动检查、下载并重启安装；安装前验证更新签名。

同账号程序仍可能访问该账号凭据。本工具减少上游密钥分发及对话中的密钥处理，不提供针对恶意同账号进程的隔离。预算由 LiteLLM 估算及执行，其周期和来源实际扣费可能不同。

## 本地 LiteLLM

已提供可选的本机 Docker Compose 配置，需要 Docker Desktop。首次生成本地秘密后启动：

```powershell
./scripts/new-env.ps1
docker compose up -d
```

默认网关 `http://127.0.0.1:4000`，管理后台 `http://127.0.0.1:4000/ui`。新网关模型列表为空，需要在后台添加模型，凭据按来源官方协议填写。ZeroKey 安装包不包含 Docker、数据库或任何来源凭据。

`.env` 已忽略提交，保存网关管理 Key、salt、数据库密码和可选来源凭据。保留 `LITELLM_SALT_KEY`，避免数据库里的来源凭据无法解密。PostgreSQL 数据保存在 Docker 卷。日常停止使用 `docker compose down`，不要添加删除数据卷的 `-v`。

仓库另提供管理员目录同步工具 `scripts/sync-sources.ts`，可选适配 BBAI、OpenCode Go、Openlux；默认仅新增模型。它不是通用来源发现器，其他来源可在 LiteLLM 后台配置。OpenCode Go 与余额付费接口分别管理，不自动回退付费；目录存在不代表每个模型都实测可用。

## 源码开发

需要 Node 22.18+、Rust 1.90+ 和平台 Tauri 构建工具。Windows 还需 MSVC/WebView2。

```powershell
npm ci
npm run desktop
```

开发环境可从本机 `.env` 导入管理 Key；发布版只通过设置连接。构建、签名及标签发布见 [发布说明](docs/releases.md)。

```powershell
npm run check
npm run test:ui
npm run test:mcp
npm test
npm run prepare:runtime
npm run desktop:build -- --no-bundle
```

源码 CLI 示例：

```powershell
node scripts/zerokey.ts doctor
node scripts/zerokey.ts models --source openlux --query gpt-4o-mini --limit 5
node scripts/zerokey.ts status --project <项目绝对路径>
node scripts/zerokey.ts init --project <项目绝对路径>
node scripts/zerokey.ts verify --project <项目绝对路径>
node scripts/zerokey.ts run --project <项目绝对路径> -- node script.mjs
```

Windows 后台调用没有终端连接时，`run` 自动避免创建控制台窗口，标准输入、输出、错误及退出码照常传递。可显式使用 `run --no-window --project <目录> -- node script.mjs`；交互式命令使用 `--interactive` 保留原终端行为。这两个选项互斥，放在程序参数分隔符 `--` 之前。`verify` 和 MCP 生成的后台启动命令默认无窗口运行。

安装版将上述 `node scripts/zerokey.ts` 替换为 `"<安装目录>/runtime/node.exe" "<安装目录>/agent/zerokey.mjs"`；优先使用 MCP 返回的绝对启动命令。启动器将 Key、网关地址、模型、协议及会话 ID 注入子进程，不打印环境。Go 请求需要 `x-litellm-session-id`，模板会自动携带；同一对话复用会话 ID。

可通过 `scripts/install-skill.ps1` 安装源码附带的 `provision-key` Skill，安装时写入实际源码路径。旧 Python 原型归档于 `prototypes/python`，当前流程不依赖 Python。

## 许可证

[MIT](LICENSE)。第三方组件保留各自许可证，安装包附带第三方声明与 Node 许可证。
