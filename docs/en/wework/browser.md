---
sidebar_position: 6
---

# Built-in browser

The built-in browser opens in the right workspace so you can inspect websites, verify local applications, and provide page context to AI.

Open the new-tab menu, choose **Browser**, and enter an `http` or `https` address. The current page remains loaded when you switch to file or review tabs.

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

Use **Settings → Browser** to choose a download folder or clear browser data. Clearing data signs you out of websites.
