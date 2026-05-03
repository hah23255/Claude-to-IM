# Changelog

All notable changes to this project will be documented in this file.

## [0.3.0] — 2026-05-03

### Added — observability hook (provider-neutral)

A new optional `LifecycleHooks.onTraceEvent` callback emits structured
`TraceEvent`s at key points in message processing so a host can build per-
message traces without coupling the bridge to any specific observability
system (OpenTelemetry, Sentry, Langfuse, Datadog, etc.). Six event types:
`message-start`, `command-dispatch`, `llm-stream-start`, `llm-stream-end`,
`delivery`, `message-end`. All events for one message share `messageId`.
Errors thrown from `onTraceEvent` are swallowed and logged so observability
problems never break the bridge's hot path.

- `src/lib/bridge/host.ts` — `TraceEvent` discriminated union + 6 event
  interfaces; extended `LifecycleHooks` with `onTraceEvent?(event)`.
- `src/lib/bridge/conversation-engine.ts` — `processMessage()` accepts new
  `onTraceEvent` and `traceMessageId` parameters; emits `llm-stream-start`
  /`llm-stream-end` around the SSE stream consumption. `ConversationResult`
  gains `toolUseCount: number` (tracked inside `consumeStream`).
- `src/lib/bridge/bridge-manager.ts` — module-level `emitTrace()` helper;
  emits `message-start`, `command-dispatch`, `delivery`, `message-end` at
  the right points in `handleMessage()`. Status mapping covers `ok` /
  `error` / `aborted` / `command-only`.

### Tests

- New `src/__tests__/unit/bridge-trace-events.test.ts` (8 cases): event
  ordering, shape, `messageId` correlation across events, `/run` prefix
  stripping reflected in `promptLength`, `@bot` suffix stripping in command
  names, `hasArgs` flag accuracy, robustness when `onTraceEvent` throws,
  no-op behavior when host omits the hook.

### Notes

- Tool-use granularity is summarised as `toolUseCount` on `llm-stream-end`
  rather than per-tool spans. Per-tool tracing is a v0.4 follow-up.
- Permission-flow events (`permission-request` / `permission-resolution`)
  are not yet emitted; they cross multiple inbound messages and need a
  separate correlation-ID design.

## [0.2.0] — 2026-05-02

### Added — IM control commands (v2)

Four new slash commands let users drive the Claude Code CLI from inside the IM,
on top of the existing `/new`, `/bind`, `/cwd`, `/mode`, `/status`, `/sessions`,
`/stop`, and `/perm`:

- **`/run <prompt>`** — explicit prompt form. Strips the `/run` prefix and runs
  the inner text through the regular conversation pipeline. Useful when a
  prompt would otherwise be misread as a command (e.g. asking Claude *about* a
  slash command, or sending text that begins with `/`).
- **`/resume <session_id> [prompt]`** — rebind the current chat to an existing
  session and, when a prompt is supplied, fire it through the normal
  session-locked conversation flow. Combines `/bind` plus first-message into a
  single mobile-friendly tap.
- **`/model <name>`** — override the active binding's model at runtime.
  Validated against a permissive model-id charset (letters, digits, `._-/:`,
  max 100 chars) — safe to use across providers without hardcoding model names.
- **`/restart`** — drop the current session and create a fresh one in the same
  chat, preserving `cwd`, `mode`, and `model` overrides. Aborts any task
  running on the old session.

### Changed

- `/help` and `/start` now group commands by category (Session control /
  Configuration / Prompts & permissions) and list the v2 additions.
- `_testOnly.handleCommand` is now exported alongside `_testOnly.handleMessage`
  so unit tests can drive command dispatch directly without standing up the
  full adapter loop.

### Notes

- The bridge does **not** spawn the `claude` CLI as a subprocess for these
  commands. All four reuse existing `BridgeStore` / `LLMProvider` /
  `ChannelBinding` primitives, so there is no new shell-injection or
  subprocess-lifecycle surface to defend.
- Per-command ACLs remain a v3 concern. Today, any user authorised by their
  adapter's `isAuthorized()` check can run any slash command.

## [0.1.0]

Initial host-agnostic extraction.
