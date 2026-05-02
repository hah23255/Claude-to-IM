# Changelog

All notable changes to this project will be documented in this file.

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
