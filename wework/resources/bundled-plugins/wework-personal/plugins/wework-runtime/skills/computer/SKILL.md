---
name: computer
description: 'Control a desktop application outside the Wework built-in browser.'
---

Wework 电脑操控 routing:

- Use the `wework_computer` MCP tools only when the user asks to control a desktop application outside the Wework built-in browser.
- The `wework_computer` tools exist only in conversations started or resumed after computer use was enabled in Wework settings and its system permissions were granted.
- If the user asks to control the desktop but `wework_computer` tools are unavailable, do NOT search for npm packages, run bash tricks, or improvise another mechanism. Tell the user to open Wework 设置 → 集成 → 电脑操控, enable computer use, and finish the macOS permission prompts (in development builds the requesting app may appear as "Electron"), then continue the conversation in a new turn (or start a new conversation) and retry. Tools are not added midway through an active turn.
- Treat clicks, typing, key presses, scrolling, dragging, clipboard writes, menu invocation, and window movement as mutating actions.
- Stop immediately when the user takes control, cancels, or the observed application no longer matches the requested target.
- Never enter passwords, authentication codes, payment details, or other secrets unless the user explicitly authorizes that exact action in the current conversation.
- Do not use computer use for Wework built-in browser tasks; use the `browser_*` tools instead.

## Desktop workflows

- If the user named the app, pass its name or bundle ID directly to `run_steps` or `cua.getApp` within `run_script`. Use `list_apps` and `list_windows` when the app or window still needs to be identified. The driver can locate a control by role and name against fresh accessibility state during a batch. Observe first when the next action depends on an unknown UI state.
- When the steps are known, use `run_steps` with `app`, named controls, and `expect` or `wait_for` checks. Set `observe: {}` if you need the resulting accessibility diff. If a step fails, use the reported state to decide what to do next. A successful earlier step in the batch may already have changed the app.
- When intermediate observations determine the next action, use `run_script` to bind the app once and branch on `app.getState` or `app.query`. Return the relevant result. Stop the batch at any point that needs separate user authorization.
- For a workflow split across calls, pass `state_mode: "reuse"` to `run_script` and store app names or bundle IDs and intermediate values in `state` (up to 4 KiB of JSON). Use `state_mode: "reset"` to start over. Rebind apps from saved references and read fresh control targets before acting.
- For a standalone read, use `get_window_state` with `include_screenshot: false` first and `since: "latest"` on repeat reads of the same window with the same filters. Request a screenshot if accessibility state is insufficient or the task needs visual verification. Use only current accessibility tokens or current screenshot coordinates.
