---
sidebar_position: 6
---

# Built-in browser

The built-in browser opens in the right workspace so you can inspect websites, verify local applications, and provide page context to AI.

Open the new-tab menu, choose **Browser**, and enter an `http`, `https`, or `file://` address, or a local absolute path. The current page remains loaded when you switch to file or review tabs. `file://` addresses and paths such as `/Users/.../file.html` are useful for previewing local HTML, PDF, image, and text files, and they can also open local folders. Markdown and extensionless text files also render as text. Folders render as read-only index pages where you can enter child folders or open files. When a local file cannot be previewed, Wework cancels the local-file download and shows a short toast.

You can keep multiple task tabs open at the top, and each task owns an independent built-in browser page. After you switch to another task, the previous task's browser keeps running while hidden. AI in that task can continue opening, waiting for, and inspecting pages, and the latest page state appears when you switch back. Browser pages are not shared across tasks. The right workspace currently provides one browser tab per task; it does not provide a browser-internal tab strip.

Background page-state synchronization does not overwrite the address while you are editing it. If a page is already open, leaving the address field without submitting restores the current page URL. If no page is open yet, the unsubmitted address is preserved and restored after switching conversations.

If a Wework dialog, menu, or overlay intersects the right browser area, the browser temporarily hides so the native page cannot cover the main interface. It returns automatically when the overlay closes or moves away.

## HTTP and certificate warnings

The built-in browser can open `http` addresses for local development services and trusted internal systems. HTTP traffic is not encrypted, so do not enter passwords, tokens, or other sensitive information on these pages.

On macOS, Wework continues loading an `https` page when its certificate is expired, self-signed, issued for another host, or otherwise rejected by system trust evaluation. A persistent certificate warning appears below the address bar for that origin and clears after navigation to a different origin. Continuing does not make the connection secure; verify the address and avoid submitting sensitive information.

Annotation mode lets you select a visible page element and attach a comment to the current message. Use it to identify layout, styling, or interaction issues.

When browser tools are enabled, AI can open, inspect, and operate pages in the same right-side embedded browser. It does not open a separate external Chrome window.

Common AI browser actions include:

- Opening or navigating to pages.
- Inspecting page structure to identify inputs, buttons, links, selects, checkboxes, and visible text.
- Clicking, typing, filling forms, pressing keys, hovering, scrolling, selecting options, and checking boxes.
- Waiting for page loads, visible text, or page stability.
- Capturing the current browser page for diagnostics.

AI uses structured `inspect` results to understand the page. `screenshot` still means a real image capture. Inspect results include element role, name, text, value, bounds, visibility, and actionability so the model can target elements more reliably.

The right panel shows the Agent browser-control state while AI operates the page. You can pause AI control and resume it after review. Confirm the target and impact before account, publishing, payment, deletion, or other high-risk actions.

## Browser controls

### Toolbar and More menu

| Feature               | UI steps and result                                                      | Limits                                                                           |
| --------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Open externally       | Browser toolbar → open externally                                        | Uses the system browser without transferring embedded-browser login state        |
| Find in page          | Toolbar … → Find → enter text and move between matches                   | Searches this webpage, not task history                                          |
| Device emulation      | … → device toolbar → preset or width/height; rotate, zoom, close to exit | Emulates a viewport, not a real phone or execution-device change                 |
| History               | … → history                                                              | Opens browsing history management                                                |
| Clear cookies / cache | … → corresponding data action                                            | Cookies affect sign-in; cache/storage cleanup affects site data. Save work first |
| Browser settings      | … → browser settings                                                     | Opens the settings controls below                                                |
| Downloads             | Toolbar → downloads → record → reveal, pause, resume or delete           | Available actions depend on download state; check the record before deleting     |

<!-- ui-source: src/components/settings/BrowserSettingsPage.tsx -->

<a id="browser-controls"></a>

Open **bottom-left account menu → Settings → Integrations → Browser**.

| Feature                              | Steps                                                                   | Result and limitations                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Full control                         | Read the risk description before toggling                               | Allows AI to submit forms and modify or delete webpage data without per-action confirmation; enable only if you accept this risk |
| Web URL and link target              | Choose built-in or system browser                                       | Controls ordinary web links, not the execution device                                                                            |
| Local URL target                     | Choose the destination for local links separately                       | Independent of HTTP/HTTPS link preferences                                                                                       |
| Browsing history                     | Open Manage, then open or delete entries in the history page            | Not task conversation history; clearing browser data is not required to inspect it                                               |
| Browsing data                        | Choose Clear and confirm or cancel after reading the dialog             | Signs you out of websites; save unsent webpage content first                                                                     |
| Downloads → Location                 | Choose Change and a directory; restore the default beside a custom path | Affects future downloads, not previously downloaded files                                                                        |
| Ask where to save before downloading | Enable before downloading                                               | Choose the destination for each download; otherwise use the configured directory                                                 |

Back, forward and reload in the browser toolbar affect this task's page. Submit an address-bar edit to navigate. For element-specific feedback, enable annotation, select the element, enter feedback, then review it in the composer before sending. Close overlapping dialogs to reveal the browser again.
