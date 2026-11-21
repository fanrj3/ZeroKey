---
name: provision-key
description: Configure or reuse project model access through the local ZeroKey Tauri desktop broker, with local approval and a long-lived budget-limited virtual key. Use when a project needs model credentials or the user invokes provision-key.
---

# Configure project model access

Prefer the launcher returned by MCP. For a source checkout use `node "<ZEROKEY_SOURCE>/scripts/zerokey.ts"` (Node 22.18+); the Skill installer fills the source path. For the Windows installed app use `"<install>/runtime/node.exe" "<install>/agent/zerokey.mjs"` instead. Do not assume a development directory exists. The TypeScript CLI delegates credential operations to the Tauri native broker. ZeroKey must be running for new grants; tray residence is enough, the main window can be closed. Keys remain in the system credential store; command output contains only non-secret status.

## MCP available

If the connected tools expose `zerokey_project_status`, prefer ZeroKey MCP for discovery and approval:

1. Resolve the absolute project folder and call `zerokey_project_status`. Reuse an active grant with `credentialPresent: true` if its existing models meet the task; do not reset budget or duration during ordinary reuse.
2. If new access is needed, call `zerokey_list_models` with source/query filters and pagination. Select an explicit suitable model, then call `zerokey_request_access` with one `projectPath`, `appName`, `models`, `dailyBudget`, and concise `reasons`. Omit duration for long-lived access. Do not automatically switch from Go to a paid source.
3. A pending result contains `requestId`. ZeroKey opens a separate review window even when the main window is hidden. The user can adjust the single project, model/provider selection, reasons and budget, then personally confirm Windows Hello/PIN. Use `zerokey_wait_request` on that same ID (up to 30 seconds); on timeout wait again with the returned `pending` or `authorizing` status. If canceled, expired, or failed, stop; do not automatically resubmit or switch to CLI to create another request. After reconnecting, query the original ID.
4. On `reused` or `provisioned`, report `changeSummary` and the **final** approved project/models/budget/expiry. If the user selected a different project, use the final path and confirm it still matches the task before writing there. Do not assume the original scope was approved.
5. For a project without an integration, call `zerokey_project_setup`, save its credential-free files without overwriting existing code, then run the returned `verify.command` and `verify.args` through the terminal. This makes one short model call. Continue until the first call succeeds or report the concrete protocol/source/budget error. Integrate `generateText` into the project as appropriate. For an existing integration use the returned `launcher` to run it. Credentials only enter the child process; never print the child environment.

`zerokey_cancel_request` cancels pending approval only. `authorizing` means the outcome is still pending; do not report it as canceled. Never collect PINs, approve Windows Hello, or read credentials. MCP does not execute arbitrary programs or provide plaintext keys.

If MCP was never available, use the CLI below. If a submitted request was interrupted, use `request-status --request-id "<id>"` to recover it before considering a new request.

## Configure or reuse

1. Resolve the existing absolute project folder. Run `node <ZEROKEY_SOURCE>/scripts/zerokey.ts status --project "<folder>"`. If `status` is `active` and `credentialPresent` is true, reuse the existing grant unless the user requests changes.
2. For new access, use `models --source "<provider>" --query "<name>" --limit 20` with optional `--cursor`. Select a suitable explicit model. Catalog presence does not prove account access or successful output.
3. Run `node <ZEROKEY_SOURCE>/scripts/zerokey.ts request --project "<folder>" --app "<project-name>" --models "<source/model>" --budget 1 --reason "<task reason>"`. Budget is dollars per day. Omit duration for long-lived access; use `--duration 7d` only for temporary access. Wait using `request-wait --request-id "<id>" --after-status pending --timeout 25`; subsequent waits use the returned status. The older blocking `provision` command also remains available. Never enter a PIN, approve on the user's behalf, simulate Hello, or bypass cancellation. Stop retrying after cancellation.
4. For a first integration run `init --project "<folder>"` to create non-secret templates (existing files are preserved), then `verify --project "<folder>"` for one short text call. Both accept `--model "<authorized-id>"`.
5. Run background applications using `node <ZEROKEY_SOURCE>/scripts/zerokey.ts run --no-window --project "<folder>" -- <program> <arguments>`. Windows console windows are suppressed while stdin, stdout, stderr and the exit code remain connected. Use `--interactive` instead for terminal interaction; the flags are mutually exclusive and go before `--`. With neither flag, `run` detects terminal connections automatically. It injects `OPENAI_API_KEY`, `LLM_API_KEY`, `OPENAI_BASE_URL`, `LLM_BASE_URL`, `OPENAI_MODEL`, `LLM_MODEL`, `LLM_API_PROTOCOL`, and `LITELLM_SESSION_ID`. Do not print the child environment or return credentials to the conversation.

Windows Hello and Credential Manager require the normal desktop session. If a restricted execution context cannot access them, use normal command approval to run the same broker command in the desktop session; do not change authorization rules. If the executable is missing, build the app with `npm run desktop:build -- --debug --no-bundle` in `<ZEROKEY_SOURCE>`.

## Integration

- Choose the endpoint matching the model protocol returned by `models`. Use `zerokey_project_setup` for a protocol-aware example or see `examples/demo/hello.mjs` in the source checkout.
- Generated `.zerokey/client.mjs` handles Chat Completions and Responses, includes the Go session header, and sanitizes upstream errors. Other protocols need their own adapter.
- OpenCode Go requires `x-litellm-session-id` from the injected `LITELLM_SESSION_ID`. Reuse it within a conversation, including retries. `run --session-id "<conversation-id>" -- ...` supports a shared conversation across processes.
- Keep Go (`opencode-go/*`) separate from balance-based OpenCode (`opencode-payg/*`). Do not enable paid fallback to work around a Go limit without instruction.
- Do not read the gateway `.env`, configuration-folder `.key` files, credential-store contents, or call management APIs/source-sync scripts. Use broker status for diagnostics.
- The app owns non-secret project metadata in its user data directory. No project `.env` containing a Key is needed.
- If MCP tools are missing, ZeroKey Settings > Agent integration can configure Codex, Claude Code or OpenCode. Saved configuration, actual connection and tools discovery are separate states; reload MCP or the client to activate a new entry. Never dump the client's full configuration for diagnosis.
- Applications under the same OS account may access that account's credentials. This reduces routine key handling in chat; it does not isolate malicious same-user processes.

## Changes and revocation

Changed models, budget, duration or an explicit change of recorded reasons require local approval. Omit reasons when simply reusing an existing grant; do not create a reason-only change during ordinary runs. An identical active grant is reused. Replacements revoke the old Key after the new configuration is saved. Revoke only when requested, using the desktop action or `revoke --project "<folder>"`. This removes the gateway key and local credential/record, not project files; keep the folder until revocation finishes. Clean up disposable test grants and generated files when the user requests it. Report model, budget, expiry and outcome without any Key value.
