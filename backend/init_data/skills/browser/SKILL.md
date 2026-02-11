---
name: browser
description: Complete real user web tasks end-to-end via browser-tool: navigate, interact, wait for page state, extract results, and provide evidence when needed.
---

# Browser Control Skill

## Goal

Finish the user’s real task reliably.  
Prioritize successful completion and correct results over aggressive call minimization.

## Operating Rules

1. Start with the intended action directly (`navigate`/`open`/`act`/`evaluate`). Do not run `status` as a pre-check.
2. Use `snapshot` only when refs are required for interaction (click/type/select/drag/scrollIntoView).
3. Prefer `evaluate` for extraction. Return structured data in one comprehensive call when possible.
4. Use condition waits by default (`loadState`/`url` → `selector`/`text`/`textGone` → `fn`). Avoid `timeMs` unless explicitly needed.
5. Before clicking potentially off-screen elements, run `act.scrollIntoView` on the ref first.
6. Keep context stable: once `targetId` is known, pass it in follow-up calls when supported.
7. Avoid blind loops: every extra call must have a clear purpose.

## Reliability and Recovery

1. If `Ref not found`, do not reuse stale refs. Take one fresh `snapshot`, retry once, then stop if still failing.
2. For repeated failures with the same cause, stop and explain the blocker clearly instead of retrying endlessly.
3. Connection recovery is built into the tool. Allow auto-recovery once; if still disconnected, instruct user to install/connect extension.

## Screenshot Policy

1. Default: no screenshot.
2. Use screenshots only when user asks, or when visual proof is required.
3. Prefer element screenshots (`ref` or `element`) over full-page screenshots.
4. Use full-page screenshots only for page-level evidence.

## Recommended Flow

1. Direct action first (`navigate`/`open` or immediate `act`/`evaluate`).
2. If interaction needs refs, run `snapshot` (`interactive: true` preferred).
3. Wait for readiness using `act.wait` with explicit conditions.
4. Interact (`scrollIntoView` → `click/type/select/drag` as needed).
5. Extract/verify with `evaluate` (preferred) or `snapshot`.
6. Provide screenshot evidence only when necessary.

## Connection Handling

Connection recovery is built into the tool. On connection failure, let the tool auto-attach/launch/retry once. If still disconnected, stop and instruct the user to install/connect the extension.

## Minimal CLI Usage

Use `<BROWSER_TOOL_CMD>` for commands:

- macOS/Linux: `~/.wegent-executor/bin/browser-tool`
- Windows: `~/.wegent-executor/bin/browser-tool.cmd`

```bash
<BROWSER_TOOL_CMD> '<json>'
```

## Quick Examples

```bash
# Navigate directly
<BROWSER_TOOL_CMD> '{"action":"navigate","url":"https://example.com"}'

# Snapshot only when refs are needed
<BROWSER_TOOL_CMD> '{"action":"snapshot","interactive":true}'

# Act on ref
<BROWSER_TOOL_CMD> '{"action":"act","request":{"kind":"click","ref":"e1"}}'

# Ensure element is visible before click (recommended on long pages)
<BROWSER_TOOL_CMD> '{"action":"act","request":{"kind":"scrollIntoView","ref":"e1"}}'

# Condition wait (preferred over fixed sleep)
<BROWSER_TOOL_CMD> '{"action":"act","request":{"kind":"wait","loadState":"domcontentloaded","timeoutMs":15000}}'

# URL-based wait
<BROWSER_TOOL_CMD> '{"action":"act","request":{"kind":"wait","url":"checkout","timeoutMs":10000}}'

# Run JS in page context via act.evaluate (function or expression)
<BROWSER_TOOL_CMD> '{"action":"act","request":{"kind":"evaluate","fn":"() => ({title: document.title, href: location.href})"}}'

# Run JS against a target element ref via act.evaluate
<BROWSER_TOOL_CMD> '{"action":"act","request":{"kind":"evaluate","ref":"e1","fn":"(el) => ({text: el.textContent?.trim() || \"\"})"}}'

# Close current tab (or pass targetId)
<BROWSER_TOOL_CMD> '{"action":"act","request":{"kind":"close"}}'

# Element screenshot (prefer over full-page when only target proof is needed)
<BROWSER_TOOL_CMD> '{"action":"screenshot","ref":"e1","type":"jpeg"}'

# Comprehensive extraction in one evaluate
<BROWSER_TOOL_CMD> '{"action":"evaluate","expression":"(() => ({title:document.title,url:location.href}))()"}'
```
