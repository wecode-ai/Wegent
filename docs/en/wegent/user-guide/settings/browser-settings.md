---
sidebar_position: 7
---

# Browser settings

Wework desktop manages its built-in browser under **Settings → Integrations → Browser**. Codex browser tools control the same visible page in the current task's right panel instead of opening another Chrome window.

## Link targets

Regular web links and local development links can use separate targets:

- **Default browser** delegates the link to the operating system's default browser.
- **Wework** opens the link in the built-in browser panel bound to the current task.

If no task browser panel is available, Wework falls back to the system browser so the link still opens.

Local links include `localhost`, `*.localhost`, the `127.0.0.0/8` loopback range, `0.0.0.0`, and the IPv6 loopback address. Regular web links use the system browser by default, while local development links use Wework.

## Browsing data and privacy

The built-in browser uses data storage isolated from Wework's main interface. Clearing browsing data removes built-in browser cookies, caches, and site storage without clearing the Wework app sign-in.

Wework does not read or import passwords, contact details, or personal profiles saved in Chrome. Set the relevant link target to the system browser when an existing Chrome session is required. This boundary avoids copying or separately storing browser credentials.

## Downloads

Downloads use the system Downloads folder by default. You can select another directory or enable **Ask where to save before downloading** to show the system save dialog for every download.

When a download starts, the built-in browser automatically opens its download bar and shows live progress. You can pause or resume an active download, and delete a paused task together with its partial file. After it finishes, you can see the file name and reveal the file in Finder.
