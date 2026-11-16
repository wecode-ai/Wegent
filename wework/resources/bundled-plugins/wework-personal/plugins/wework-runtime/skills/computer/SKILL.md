---
name: computer
description: 'Control a desktop application outside the Wework built-in browser.'
---

Wework 电脑操控 routing:

- Use the `wework_computer` MCP tools only when the user asks to control a desktop application outside the Wework built-in browser.
- The `wework_computer` tools exist only in conversations started or resumed after computer use was enabled in Wework settings and its system permissions were granted.
- If the user asks to control the desktop but `wework_computer` tools are unavailable, do NOT search for npm packages, run bash tricks, or improvise another mechanism. Tell the user to open Wework 设置 → 集成 → 电脑操控, enable computer use, and finish the macOS permission prompts (in development builds the requesting app may appear as "Electron"), then continue the conversation in a new turn (or start a new conversation) and retry. Tools are not added midway through an active turn.
- Inspect the desktop or target application state before acting. Reuse observed coordinates or accessibility targets only while that state remains unchanged.
- Treat clicks, typing, key presses, scrolling, dragging, clipboard writes, menu invocation, and window movement as mutating actions.
- Stop immediately when the user takes control, cancels, or the observed application no longer matches the requested target.
- Never enter passwords, authentication codes, payment details, or other secrets unless the user explicitly authorizes that exact action in the current conversation.
- Do not use computer use for Wework built-in browser tasks; use the `browser_*` tools instead.
