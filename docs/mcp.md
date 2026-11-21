# ZeroKey MCP

本机 MCP 使用 TypeScript + 官方 MCP SDK，通过 stdio 与 Agent 通信。Rust Broker 负责授权审核、状态与系统凭据库；不增加 Docker 容器或网络监听端口。

## 接入

安装版已内置 Node 和 MCP 脚本，不需要下载源代码。源码开发需要 Node.js 22.18+、已构建的 ZeroKey 和运行中的 LiteLLM。首次申请及权限变化时 ZeroKey 在托盘运行即可；关闭主窗口不会退出。日常复用不重复验证。

在「设置 → Agent 接入」选择 Codex、Claude Code 或 OpenCode，点击配置。安装器只合并 ZeroKey 条目，已有文件先备份；遇到冲突不会覆盖。保存后重载客户端 MCP。三个状态分别表示配置已保存、实际握手、客户端已读取工具列表，不能互相代替。也可使用下面的手动片段。

```powershell
npm install
npm run desktop:build -- --debug --no-bundle
node scripts/mcp-config.ts codex
```

最后一条命令输出使用当前 Node 与项目绝对路径的配置片段。将 `codex` 换成 `claude` 或 `opencode` 可生成对应格式，合并到客户端自己的配置文件；生成器不改写现有配置。不需要向客户端填写 Key。

源码 MCP 的启动命令是 `node <ZeroKey目录>/scripts/mcp.ts`。安装版可执行 `"<安装目录>/runtime/node.exe" "<安装目录>/agent/mcp-config.mjs" codex` 生成片段，或直接使用设置页。片段使用本机缓存中的版本化运行时，避免长期 MCP 连接占用安装文件阻碍更新。推荐使用生成器给出的绝对路径；不要使用向 stdout 打印启动提示的 npm 包装命令。更换安装目录后重新配置接入。

在客户端重载 MCP 后，尝试：“用 ZeroKey 查看当前项目授权；如果没有，就申请一个够用的文字模型，预算每天 0.1 美元，长期有效。”项目必须是已有文件夹。只有你在桌面审核并完成本机确认后，才会签发凭证。

## 工具

| 工具                     | 用途                                                    |
| ------------------------ | ------------------------------------------------------- |
| `zerokey_health`         | 检查网关、桌面审核可用性与 Broker 版本                  |
| `zerokey_list_models`    | 按来源或名称分页查询模型与协议，默认 20 条，最多 100 条 |
| `zerokey_project_status` | 查询项目实际授权及本机凭证是否存在                      |
| `zerokey_request_access` | 复用相同有效授权，或立即返回待审核申请编号              |
| `zerokey_request_status` | 查询原申请，返回最终获批的模型、预算与期限              |
| `zerokey_cancel_request` | 取消待审核申请，重复取消保持同一结果                    |
| `zerokey_wait_request` | 等待原申请变化（最多 30 秒），超时返回当前状态 |
| `zerokey_project_setup` | 为已授权项目返回无密钥的接入模板和首次调用命令 |

申请参数为 `projectPath`（单个绝对路径）、`appName`、`models`（带来源前缀）和可选 `reasons`（最多 8 项、每项 150 字符），`dailyBudget` 默认 1 美元/日，接受大于 0 的有限金额，不设固定金额上限，最终以用户在本机确认的预算为准；`duration` 省略或 null 代表长期有效，也可显式传 `7d` 等值。

新申请返回 `pending`、`requestId` 和 `expiresAt`（Unix 秒）。托盘进程弹出居中的独立审核窗口；用户可调整单个项目、来源、模型、理由和预算。点击指纹按钮后审核窗口隐藏，再由本人完成 Windows Hello；验证取消会恢复表单。十分钟是等待审批的窗口，与 Key 的有效期独立。

Agent 使用 `zerokey_wait_request` 等待同一个编号，`afterStatus` 为上次返回的 pending/authorizing，`timeoutSeconds` 为 1–30。超时返回原状态后可继续等待；相同申请复用编号，不同范围返回冲突。验证中取消不会伪报成功。取消、过期或失败后停止自动重提；终态保留 24 小时，重连后仍可查询。

成功结果的 `project` 是最终获批范围；`changes` 与 `changeSummary` 明示调整，例如「每日预算：$1.00 → $10.00」。若用户更换项目，应按最终路径判断任务适配性。

模型列表是目录，不保证每个模型实测可用。OpenCode Go 与余额付费来源分别授权，不自动付费回退。状态中的检查时间不等同于余额保证，实际请求仍由网关执行模型与预算限制。

## 程序运行

MCP 返回无凭证的 `launcher.command` 和 `launcher.args`。在参数末尾追加程序与参数，通过 Agent 自己的终端能力启动：

```powershell
node scripts/zerokey.ts run --project D:/my-project -- node script.mjs
```

目标程序从注入的环境读取网关地址、模型和项目 Key。MCP 不改变 Agent 的父进程环境，不提供任意命令执行，也不输出 Key。仅支持 MCP、没有终端的客户端当前可管理授权，不能直接运行项目。

程序必须使用目录标明的接口。OpenCode Go 需把注入的 `LITELLM_SESSION_ID` 作为 `x-litellm-session-id`；同一对话内保持一致，可通过启动器 `--session-id` 跨进程复用。不要打印整个环境或把 Key 写入代码和配置。

新项目可调用 `zerokey_project_setup`，保存返回的 `.zerokey/client.mjs`、`.zerokey/verify.mjs`（不覆盖已有代码），再运行返回的验证命令。模板按注入的 `LLM_API_PROTOCOL` 选择 Chat Completions 或 Responses，自动携带会话头，错误不回显上游原文。验证会产生一次短文本用量。CLI 等效入口：

```powershell
node scripts/zerokey.ts models --source openlux --query gpt-4o-mini --limit 5
node scripts/zerokey.ts init --project D:/my-project
node scripts/zerokey.ts verify --project D:/my-project
```

可使用 `skills/provision-key` 获取 MCP 优先、CLI 后备的完整工作指引。运行 `scripts/install-skill.ps1` 更新本机 Skill 时，会按实际安装目录生成路径。

Windows 上，MCP 返回的启动器和验证命令包含 `--no-window`，防止后台 Node.js 进程弹出控制台，仍保留标准输入、输出、错误及退出码。交互式终端任务可将它替换为 `--interactive`；不指定时，`run` 按终端连接自动选择模式，`verify` 默认后台模式。选项位于程序分隔符 `--` 之前。

## 验证

```powershell
npm run check
npm run test:mcp
npm run test:ui
npm test
npm run test:mcp:live
```

协议测试以独立 stdio 进程运行，验证工具发现、旧版协议兼容、参数校验、输出白名单、分页、审批结果与取消行为。模拟服务仅存在于 `tests/mcp`，生产入口没有跳过验证或注入测试凭据的开关。

Rust 测试覆盖并发去重、冲突、审批过期、验证期间取消、终态保留、范围变更及审批进程中断。前端测试覆盖外部取消后隐藏审核窗口、选择框不会触发表单提交，以及验证取消后保留编辑。

`test:mcp:live` 使用真实网关和本机 Broker：查询目录，在独立的 `examples/mcp-smoke` 路径提交申请、查重、测试冲突、重连、取消，并确认仍未配置授权。测试不会批准申请、签发 Key 或调用收费模型；如果桌面未运行，则验证申请被明确拒绝。

受限执行环境可能无法打开应用数据目录或系统凭据库；这时在正常桌面会话运行同一条验证命令，不更改凭据保护。真实的签发与程序文字输出还需要用户本人完成桌面确认，不能由自动测试代替。

## 本次验证记录

2026-11-17 Windows：真实 MCP 读取 227 个目录条目；相同申请编号复用、不同范围冲突、重连查询、幂等取消均通过，确认测试没有产生项目授权。具体自动测试结果以运行输出为准。

2026-11-17 Windows：用户完成 `MCP 文字验证` 的 Windows Hello 确认后，使用 `examples/mcp-demo` 通过 ZeroKey 启动器调用 `openlux/gpt-4o-mini-2024-07-18`，返回 `ZeroKey MCP OK`；随后提交相同范围申请返回 `reused`，未再次弹出确认。测试过程未输出 Key。

2026-11-17 托盘流程：关闭主窗口后 Broker 仍在线，独立 560×660 审核窗口能显示申请；取消后窗口隐藏，真实等待接口约 1.1 秒返回 canceled，取消测试项目没有授权。复用现有 mcp-demo 授权运行新接入模板，返回 `ZeroKey OK`。

随后 `examples/tray-demo` 的独立申请经本人完成本机确认，等待接口记录 pending → authorizing → provisioned；新模板使用 openlux/gpt-4o-mini-2024-07-18 返回 `ZeroKey OK`，范围为每日 $0.10、长期有效。测试未输出凭证。13 项前端、12 项 MCP/模板、10 项 Rust 检查通过；其中新增检查覆盖终态错误保留至确认关闭，以及理由修改不能被旧记录静默覆盖。

验证完成后，按用户要求撤销测试项目授权并移除临时项目目录。上述输出是历史验证记录，不代表示例路径始终持有有效授权。仅在用户要求撤销时使用 CLI `revoke --project <目录>`；先撤销凭证，再清理文件夹。
