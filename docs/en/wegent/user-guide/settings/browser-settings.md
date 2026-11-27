---
sidebar_position: 7
---

# Browser settings

Wework desktop manages its built-in browser under **Settings → Integrations → Browser**. Codex browser tools control the same visible page in the current task's right panel instead of opening another Chrome window.

## AI operation permissions

**Full control** is off by default. When enabled, AI can operate the built-in browser across all tasks on this device, including submitting forms and changing or deleting page data, without asking for confirmation each time. This device-local setting persists across restarts. Turning it off restores confirmation for subsequent actions that require approval. Taking over the browser still pauses AI operations.

## Link targets

Regular web links and local development links can use separate targets:

- **Default browser** delegates the link to the operating system's default browser.
- **Wework** opens the link in the built-in browser panel bound to the current task.

If no task browser panel is available, Wework falls back to the system browser so the link still opens.

Local links include `localhost`, `*.localhost`, the `127.0.0.0/8` loopback range, `0.0.0.0`, and the IPv6 loopback address. Regular web links use the system browser by default, while local development links use Wework.

## Browsing data and privacy

Type part of a page title or URL in the address bar to find a previously visited page. Use the arrow keys to select a result and press Enter to open it. Choosing **Search the web** sends your query to Google. Open **More → History** to review or delete visits.

The built-in browser uses data storage isolated from Wework's main interface. Clearing all browsing data in Settings removes browsing and download history, cookies, caches, and site storage. Downloaded files and your Wework app sign-in are preserved.

Wework does not read or import passwords, contact details, or personal profiles saved in Chrome. Set the relevant link target to the system browser when an existing Chrome session is required. This boundary avoids copying or separately storing browser credentials.

## Downloads

Downloads use the system Downloads folder by default. You can select another directory or enable **Ask where to save before downloading** to show the system save dialog for every download.

When a download finishes, use the notification to open the file or reveal it in your file manager. To see previous downloads, select the downloads toolbar button or **More → Downloads**. The list shows each file's name, status, size, and time, including entries for files that have moved or been deleted. You can pause or resume an active download and delete a paused task together with its partial file.
