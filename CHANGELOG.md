# Changelog

## 0.2.0

首个公开 Windows x64 安装版。

- 新增 GitHub Release 自动更新：启动后及每 6 小时检查，设置页和托盘支持手动检查；下载校验签名后安装并重启。
- 安装包内置 Node 24 LTS 和 MCP/CLI 运行脚本，安装后无需克隆代码或另装 Node。
- 提供 Codex、Claude Code、OpenCode 的 MCP 接入配置与 8 个工具，支持模型发现、异步审批等待和项目首次调用模板。
- 原生托盘常驻，主窗口关闭后仍可接收授权；独立置顶审核窗口与 Windows Hello 确认。
- 项目虚拟凭证限模型、限每日预算，默认长期有效，保存在系统凭据库；前端及 MCP 不返回明文 Key。
- 中文 shadcn/ui 界面，支持深色、浅色和跟随系统。

Windows x64 已验证；macOS/Linux 暂仅提供源代码。LiteLLM 与数据库需单独部署或连接现有网关。
