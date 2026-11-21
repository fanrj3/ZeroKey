# ZeroKey

<!-- impeccable:product-schema 1 -->

## Platform

web

The interface ships inside a cross-platform desktop container.

## Stack

User-selected: Tauri 2, TypeScript, Vite, React, official shadcn/ui components. Rust handles local credentials, gateway administration, and native authorization. LiteLLM and PostgreSQL remain the inference and accounting backend.

## Users

A developer using local coding agents and multiple upstream API providers, including third-party relays and OpenCode Go.

## Product Purpose

Configure project model access once without pasting API keys into chats. Keep upstream keys at a local gateway; provision reusable, model-limited virtual keys with daily budgets and optional expiry.

Success means a developer can review a project's access once, run it repeatedly through their agent without handling keys in the conversation, inspect its usage, and adjust or revoke its grant when needed.

## Positioning

A desktop approval and credential broker in front of a shared model gateway. Sources can be official providers or third-party relays; a project receives scoped gateway access rather than the original upstream credential. LiteLLM remains responsible for model routing, virtual-key enforcement, and centralized usage accounting.

## Operating Context

The current development host is Windows. The user wants a lighter cross-platform desktop app. The gateway currently runs locally at localhost:4000 with LiteLLM and PostgreSQL in Docker. Configured sources include BBAI, OpenCode Go, and Openlux; source/model lists are read from the gateway, not fixed product limits.

The core workflow is: inspect available models, choose a project folder, review model scope and daily budget, approve locally, then reuse the grant through the agent Skill or process launcher. New agent requests are reviewed in the desktop app. Source administration and full billing remain available through LiteLLM's management interface.

## Capabilities and Constraints

- Default project keys do not expire. Temporary grants can explicitly use seven days or another duration.
- Approve the first grant or a change of permissions; reuse active grants during ordinary work.
- Never return plaintext upstream or virtual keys to the renderer or agent chat.
- Display project, requested models, budget, and expiry before approval.
- Keep OpenCode Go and OpenCode balance-based access distinct; preserve conversation session IDs.
- Actual gateway model restrictions, exhausted-budget rejection, and key revocation have been verified.
- Cross-platform credential storage is required. Native authentication mechanisms vary by operating system and must be represented honestly.
- Windows uses Windows Hello when available; the current fallback is an independent application PIN. macOS/Linux biometric support must not be advertised as implemented.
- The Windows app uses an application-provided title bar instead of the system title bar, with ordinary window controls and dragging behavior.
- Keep management and project credentials in the system credential store. The native broker injects a project virtual key into the launched program; generated credentials are not returned in agent output.
- Daily budgets use gateway cost estimates. A relay's actual charges or an OpenCode Go subscription balance remain subject to the source account and its billing rules.
- A discovered model is a catalog entry, not proof of account access, protocol compatibility, or successful output. Media endpoints require their own integration and verification.
- The Sources page can preview and add missing models for the configured BBAI, Openlux and OpenCode adapters. Automatic additions are optional and off by default; Rust owns startup and six-hour checks while the app resides in the tray. Upstream removals are flagged for review while existing routes and grants are retained. Source credentials stay at LiteLLM through fixed authenticated GET catalog routes.
- A browser-only preview must clearly identify unavailable desktop capabilities rather than invent connected state, project usage, or authorization results.
- This workflow reduces upstream-key distribution and routine key handling in chats; it does not isolate credentials from malicious processes running as the same OS user.

## Brand Commitments

Name: ZeroKey. Chinese interface. All UI components must use official shadcn/ui and retain their standard interaction behavior. Clear navigation for sources, project authorization, usage, and settings.

Confirmed desktop theme (2026-11-17): official shadcn/ui Blue over neutral surfaces, with dark as the default and light/system modes available in Settings > Appearance. Remember the local choice and apply it before rendering. Use blue for primary actions; success, warning, and error states also need readable text and an icon. Preserve the existing layout, components, and authorization workflow.

## Evidence on Hand

- The Windows Tauri application has been built and inspected against the live local gateway. Type checks and Rust authorization-rule checks pass.
- `scripts/verify-virtual-key.ps1` verifies a key without expiry, an allowed text request, denial of another model, exhausted-budget rejection, and rejection after revocation. These checks do not substitute for the user's first Windows Hello approval.
- Source snapshot on 2026-11-17: BBAI has 15 registered entries, OpenCode Go 32, and Openlux 180 imported text-model candidates. These are observed counts, not guarantees or fixed requirements.
- A restricted Openlux key successfully returned `OK` from `openlux/gpt-4o-mini-2024-07-18`; the temporary verification key was revoked. Other catalog entries must not inherit that verification claim.
- A user-approved Windows Hello issuance for `examples/mcp-demo` returned real model text, and the same authorization was reused without another prompt. The new tray flow verified hidden-main request presentation, external cancellation and wait wake-up. A separate `examples/tray-demo` request completed personal native confirmation, reached provisioned, and returned `ZeroKey OK` through the generated template. Actual macOS/Linux builds remain unverified.

## Open Decisions

- Further visual changes must preserve the confirmed shadcn/ui Blue theme and official component requirement unless the user changes that direction.
- Whether the gateway should later move to a server remains open. Current operation is local, and server deployment is not a completed capability claim.
- Additional media endpoint support and verification are future work; listing a model alone must not imply that integration is complete.

## Product Principles

- A project grant is reusable configuration, not a per-request approval.
- Show actual gateway and project state; never invent usage or health data.
- Prefer explicit model scope and reversible revocation to distributing upstream credentials.
- Make authorizations reviewable without exposing credentials.
