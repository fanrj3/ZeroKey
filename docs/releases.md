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
