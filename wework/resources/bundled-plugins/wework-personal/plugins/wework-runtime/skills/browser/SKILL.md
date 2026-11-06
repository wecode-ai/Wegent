---
name: browser
description: 'Use the Wework built-in browser to open, inspect, navigate or interact with web pages.'
---

Wework 内置浏览器 routing:

- "Wework" refers to Wegent's desktop workbench. Describe its browser as the Wework built-in browser.
- For browser tasks inside Wework, use the `browser_*` MCP tools from the Wework 内置浏览器 tool server.
- Build the workflow from the user's requested outcome. Run browser tools sequentially, complete every requested action, and never claim an action succeeded unless its matching tool succeeded.
- Use `browser_open` for navigation and `browser_inspect` for structured page state. Inspect when targets or page understanding are needed, prefer numbered `index` targets, and reuse all known targets across adjacent actions. Inspect again only after an intentional page change, an unknown/stale target, or when the task needs a final-page summary.
- An explicit click request requires `browser_click` or `browser_click_coordinates`; filling, pressing Enter, page auto-update, JavaScript submission, or a screenshot does not count as a click.
- Use `browser_take_screenshot` only when the user explicitly requests a screenshot. Use `browser_evaluate` only for read-only diagnostics, never as a substitute for open/fill/click/press actions.
- On a transient action error, inspect the existing page and retry that action once with a fresh target. Do not reopen a page that is still available.
- Report progress in one short line when each requested subtask starts and finishes (for example "第 2/4 项完成：搜索结果已获取，开始第 3 项"), so the user can follow along and intervene in time. Keep progress lines brief. After all requested actions and any needed final inspect, give one concise result based on the final page.
- If a page redirects to a login or sign-in page (the URL or page content shows authentication is required), stop all further browser actions immediately. Tell the user the page requires login, ask them to log in inside the Wework built-in browser panel, and wait for their confirmation. Do not continue executing later steps while logged out. After the user confirms they have logged in, resume from the step that failed: reopen the target page, retry that step, and then continue the remaining steps.
- To upload a local file into a page upload control, use `browser_upload_file` with the absolute local file path; target the file input with a CSS selector, or omit the selector to use the first file input on the page. To clear browser data, use `browser_clear_data` with `kinds` chosen from cookies, cache, storage, and history; omitting `kinds` clears cookies, cache, and storage. Clearing cookies signs the user out of websites, so only clear what the user asked for.
- Do not use the bundled Browser or Chrome plugin runtimes for Wework browser tasks, including `agent.browsers.get("iab")`, `agent.browsers.get("extension")`, `browser:control-in-app-browser`, or `chrome:control-chrome`.
- Do not fall back to an external Chrome window unless the user explicitly asks for Chrome.
