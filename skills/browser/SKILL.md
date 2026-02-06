---
name: browser
description: Fast, reliable browser automation via CDP relay. Use for real page interaction and extraction with minimal calls.
---

# Browser Control Skill

## Hard Rules

1. Start with the intended action directly (`navigate`/`open`/`act`/`evaluate`). Do not run `status` as a pre-check.
2. Keep calls minimal: target `<= 8` per task (hard cap `12`, unless user explicitly asks for deep exploration).
3. Prefer `evaluate` for extraction. Combine data into one comprehensive extraction when possible (avoid repeated partial extraction).
4. `snapshot` is for refs/structure only. Budget: at most `1 initial + 1 final` per page.
5. If `Ref not found`: do not retry stale ref. Take one fresh `snapshot`, retry once, then stop if still failing.
6. `act.wait` is strict: do not use `timeMs` by default. Use condition waits (`text`/`selector`/state). Use fixed-time waits only when user explicitly asks or no condition is possible.
7. `screenshot` is strict: default `0`. Use only if user explicitly requests it or visual evidence is strictly necessary after text/DOM extraction. Max `1` screenshot per task unless user asks for more.
8. Keep tab context stable: once `targetId` is known, pass it in subsequent actions when supported.

## Execution Order

1. Direct action first (`navigate`/`open` or immediate `act`/`evaluate`).
2. Use `snapshot` only if refs are needed for interaction.
3. Execute interactions with minimal `act` calls (merge related input when possible).
4. Use one final verification step only if needed (`evaluate` preferred; `snapshot` optional).

## Connection Handling

Connection recovery is built into the tool. On connection failure, let the tool auto-attach/launch/retry once. If still disconnected, stop and instruct the user to install/connect the extension.

## Minimal CLI Usage

```bash
~/.wegent-executor/bin/browser-tool '<json>'
```

## Quick Examples

```bash
# Navigate directly
~/.wegent-executor/bin/browser-tool '{"action":"navigate","url":"https://example.com"}'

# Snapshot only when refs are needed
~/.wegent-executor/bin/browser-tool '{"action":"snapshot","interactive":true}'

# Act on ref
~/.wegent-executor/bin/browser-tool '{"action":"act","request":{"kind":"click","ref":"e1"}}'

# Comprehensive extraction in one evaluate
~/.wegent-executor/bin/browser-tool '{"action":"evaluate","expression":"(() => ({title:document.title,url:location.href}))()"}'
```
