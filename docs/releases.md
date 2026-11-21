# 构建与发布

公开仓库：https://github.com/fanrj3/ZeroKey 。目前发布 Windows x64 NSIS 安装包，按当前用户安装，不包含 LiteLLM/Docker。

## 本机构建

需要 Windows、Rust/MSVC 构建工具、Node 22.18+。

```powershell
npm ci
npm run prepare:runtime
npm run check
npm run test:ui
npm run test:mcp
npm test
# 设置 TAURI_SIGNING_PRIVATE_KEY（私钥文件路径或内容），密码通过环境变量提供
npm run desktop:build -- --bundles nsis --ci
node scripts/verify-package.mjs
node scripts/release-manifest.mjs
```

`prepare:runtime` 从 Node 官方下载固定版本 v24.22.3 的 Windows x64 运行时并校验 SHA-256。Agent 脚本由 esbuild 打包，随运行时及第三方许可证安装，不依赖开发机目录。源码开发入口仍使用 `node scripts/*.ts`；安装版入口为 `<安装目录>/runtime/node.exe <安装目录>/agent/*.mjs`。

## 更新签名

通过 `npx tauri signer generate --ci -w <仓库外的私钥路径>` 生成密钥对。只将公钥写入 `src-tauri/tauri.conf.json`，私钥存于安全位置并备份。不要把私钥、口令、来源 Key 或本机配置提交仓库。

GitHub 仓库 Secrets 保存 `TAURI_SIGNING_PRIVATE_KEY`，有口令时另设 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。公钥更换需考虑已安装客户端仍信任原公钥；不能直接丢弃旧私钥再发布。

## 发新版

同步修改 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 与 `src-tauri/tauri.conf.json` 的版本，在 `CHANGELOG.md` 添加对应条目，提交后推送同名 `vX.Y.Z` 标签。GitHub Actions 完成检查、签名构建和发布。流程校验标签与应用版本一致。

发布包含安装包、`.sig`、`latest.json` 和 `SHA256SUMS.txt`。应用固定读取 `https://github.com/fanrj3/ZeroKey/releases/latest/download/latest.json`，仅接受较新版本，安装前由 Tauri 校验内置公钥对应的签名。下载由用户触发；安装会重启应用，并与本机授权/撤销使用同一个跨进程操作锁。更新不操作系统凭据和网关数据库。

Tauri 更新签名用于应用内验证，和 Windows Authenticode 代码签名不同；当前安装包没有商业代码签名证书。首次安装可能显示 Windows 发布者提示。

## v0.2.0 发布验证

首个版本已发布至 [GitHub Release](https://github.com/fanrj3/ZeroKey/releases/tag/v0.2.0)，Windows x64 安装包为 26.30 MiB。16 项 UI、12 项 MCP/配置/模板、11 项 Rust 测试及类型检查通过。

已使用仅覆盖应用版本号的本地 v0.1.0 测试构建，实际完成发现 GitHub v0.2.0、下载安装包、签名校验、安装及重启。重启后显示 v0.2.0 和“已是最新版本”；项目数据文件 SHA-256 未变。安装版在源码目录之外完成 CLI 检查、隔离客户端配置和 MCP 握手，8 个工具均可发现。

本次 GitHub Actions 因账号计费锁定而未启动任务，因此 v0.2.0 使用本地签名构建发布。自动发布工作流和签名 Secret 已配置；账号计费问题解决后，后续标签可使用自动构建发布。无需修改已发布的 v0.2.0 标签。

## v0.2.1 修复验证

修复 Windows 从外部恢复隐藏审核窗口时，原生可见状态与 Tao 缓存不一致导致的关闭失效。隐藏前同步实际可见的窗口；空窗口关闭失败会保留可重试的错误信息。

17 项 UI、12 项 MCP/配置/模板、11 项 Rust 测试及类型检查通过。已安装签名修复包，在桌面取消临时申请后确认审核窗口隐藏、申请状态为 `canceled`，项目数据文件 SHA-256 未变。安装版隔离 CLI、客户端配置和 8 个 MCP 工具握手检查通过。临时申请未批准、未签发凭据，验证后删除测试记录。

## v0.2.2 预算设置

移除桌面表单、MCP、Broker 及随附 LiteLLM `upperbound_key_generate_params.max_budget` 中的 $10 固定上限。每日预算仍为大于 0 的有限金额，默认申请 $1/天；设置更高金额后仍须本人完成本机确认。现有项目预算不随软件升级改变。

17 项 UI、13 项 MCP/配置/模板、11 项 Rust 测试及类型检查通过，覆盖 $100/天表单提交、MCP 传递与 Broker 校验。随附 Docker 部署需同步 `config.yaml` 并运行 `docker compose restart litellm`；桌面安装包不会修改独立部署的网关配置。本机网关已应用新配置并恢复连接。

已安装签名 v0.2.2，项目数据文件 SHA-256 未变；安装版 CLI、客户端配置和 8 个 MCP 工具握手检查通过，实际工具 schema 不再包含预算 `maximum`。已有 MCP 进程需由客户端重新连接以载入新 schema。

## v0.2.3 授权修改与抽屉动画

LiteLLM 要求虚拟凭证别名全局唯一，旧版修改项目授权时复用别名导致 HTTP 400。每次签发现采用带独立 UUID 的可读项目别名；继续在新凭证保存成功后撤销旧凭证。错误响应只映射已知字段为固定提示，原始网关错误不会进入界面或 Agent 输出。

抽屉采用受控关闭状态，等待 Radix Presence 退出后卸载，处理关闭按钮、取消、Escape、项目撤销后的列表刷新及面板替换。22 项 UI、13 项 MCP、13 项 Rust 测试及类型检查通过。隔离的合成数据浏览器验证观察到项目详情与授权抽屉实际运行 150ms 退出动画，动画中仍在 DOM，结束后卸载；进入为 200ms，系统减少动态效果时采用无位移淡入淡出。

Windows x64 签名安装包为 26.31 MiB，已本地安装 v0.2.3，安装前后项目数据文件 SHA-256 一致。安装版在源码目录之外完成 CLI、客户端配置与 8 个 MCP 工具握手检查。本版本继续采用本地签名构建发布。

## v0.3.0 来源同步

模型来源页按来源提供目录同步、选择添加、自动添加开关与最近记录。固定鉴权 GET 目录透传复用网关环境凭据，安装版不依赖源码目录或本机 `.env`。目录预览和确认添加共用 Rust 后台，确认使用 10 分钟内的快照；重复添加跳过，部分失败保留结果，上游删除仅标记待检查。

27 项 UI、18 项 Rust、13 项 MCP 测试及类型检查通过，覆盖选择后才添加、失败与空选择、同步后授权列表刷新、重复同步、Go/付费协议差异、目录过滤和缓存过期。BBAI、OpenCode Go、Openlux 的真实目录预览通过，固定透传匿名请求返回 401。

安装版实际新增 `bbai/gpt-6.2-sol` 与 `bbai/gpt-6.2-astra`，重复执行新增数为 0；MCP 实际发现这两个模型。其余候选保持待添加，自动添加保持关闭。未签发新项目 Key，未执行这些新型号的推理验证。Windows x64 签名安装包 26.37 MiB，安装前后项目记录 SHA-256 一致；安装版隔离 CLI、客户端配置与 8 个 MCP 工具检查通过。

实机检查了安装版浅色来源页与真实模型目录；实际路由变更通过同一安装版原生操作员接口完成。浏览器以非敏感本机目录快照验证深色 SourcesPage 与预览 Sheet，覆盖 860×580 紧凑尺寸、选择状态、固定底部操作及无横向溢出。后台六小时调度已实现，未等待完整六小时周期做实时时间验证。

## v0.3.1 Windows 后台启动

外层 Node 启动 Broker 时的 `windowsHide` 不会自动应用到 Rust 启动的目标程序。新增 `run --no-window`，由原生启动器设置 `CREATE_NO_WINDOW`；保留继承的 stdin、stdout、stderr 和目标退出码。没有终端连接时自动采用后台模式，有终端时保留原行为，`--interactive` 可显式覆盖。直接原生 Broker 调用支持布尔字段 `noWindow`，省略时保留兼容行为。MCP 启动器、验证命令和 `verify` 默认后台运行。

17 项 MCP/CLI、20 项 Rust、27 项 UI 测试及类型检查通过。Rust Windows 回归并行启动 3 个真实子进程，通过 `GetConsoleWindow() == 0` 验证没有控制台，同时确认 stdin、stdout、stderr 与退出码 23；被忽略的 probe 测试仅作为该回归的子进程入口，已由回归实际执行。源码完整链路再并行启动 3 个 Node.js 进程，自动与显式后台模式均保留流及退出码，凭证注入仅检查存在性，不输出其值，不执行模型推理。

已安装签名 v0.3.1，安装前后项目记录 SHA-256 一致；安装版也通过 3 个并行 Node.js 进程的同等完整链路验证，以及隔离 CLI、客户端配置和 8 个 MCP 工具检查。Windows x64 安装包约 26.37 MiB。
