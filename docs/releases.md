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
