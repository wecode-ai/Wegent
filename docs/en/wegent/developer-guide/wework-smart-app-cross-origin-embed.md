---
sidebar_position: 30
---

# Cross-origin iframes and region capture in Wework Smart Apps

This document defines the generic architecture for embedding a cross-origin page in a Wework
Smart App and sending a cropped screenshot back to the plugin. The host capability is independent
of business domains; Wework must not maintain site-specific allowlists.

## Architecture

The remote page remains a normal iframe. The Smart App, iframe, dialogs, and controls are composed
by the same WebContents, so layout, input, focus, stacking, and lifecycle retain standard web
semantics.

For capture, the plugin reports the iframe's `getBoundingClientRect()`. The scoped HostPipe resolves
the calling Smart App owner and invokes `capturePage(rect)` on that owner WebContents. Cross-origin
OOPIF pixels are part of the owner's final composited frame, so the plugin does not read iframe DOM
and does not need desktop screen-recording permission.

```text
BrowserWindow
  └─ Smart App <webview> (owner)
       ├─ plugin UI
       └─ cross-origin <iframe>

iframe DOMRect
  → dshCapture.ownerRect
  → owner WebContents.capturePage(rect)
  → PNG data URL
```

## Why native surfaces are not used

A `WebContentsView` belongs to the BrowserWindow native View tree, not the Smart App DOM compositor.
It cannot attach to an ordinary DOM node or interleave with plugin dialogs through CSS `z-index`.
Bounds synchronization, visibility toggles, occlusion rectangles, and clip paths only emulate DOM
behavior and introduce black frames, input interception, tab-lifecycle coupling, and capture races.

`dshSurface.open/setBounds/navigate/capture/close` is therefore not an appropriate abstraction for
a local web region inside a Smart App.

## Authentication constraints

Wework does not bypass target-site browser security. Embedded login requires the target site to:

1. allow framing via CSP `frame-ancestors` (do not rely on `X-Frame-Options` — it cannot
   express a cross-origin allowlist, and its `ALLOW-FROM` directive is obsolete);
2. complete authentication inside the current frame instead of forcing `top` or `parent` navigation;
3. issue cookies that are accepted and sent in the embedded context, for example with appropriate
   `SameSite=None; Secure` or partitioned-cookie attributes; and
4. reuse the persistent Wework browser session across Smart App reloads.

If the callback succeeds but the authorization endpoint remains anonymous, inspect only cookie
metadata in an isolated Electron session. Never record cookie values, login tickets, authorization
headers, or user identity data.

## Capability contract

Each Workbench HostPipe is bound to its Smart App tab ID when the runtime starts:

- `dshCapture.capabilities` reports whether owner-view region capture is available.
- `dshCapture.ownerRect` accepts `{x, y, width, height}` and returns a PNG data URL.

The request cannot specify a label, URL, or WebContents ID. The host validates finite, non-negative,
non-empty bounds, enforces dimension and pixel limits, rejects hidden or destroyed owners, and always
captures the owner bound to the HostPipe. It cannot capture another Smart App, a Wework window, or
the desktop.

## Plugin behavior and verification

Wework and browsers render the same iframe branch. Wework uses `dshCapture.ownerRect`; browsers fall
back to `getDisplayMedia`, and environments with neither capability keep the manual-paste guidance.
Opening dialogs, terminals, approval UI, or another tab must not change the iframe's display, source,
or lifecycle. Capturing only adds an image attachment.

Automated tests should cover owner scoping, invalid bounds, hidden owners, PNG-to-File conversion, persistent
iframe rendering, browser fallback, and repeated capture. The `dsh-owner-capture` desktop checkpoint
starts an actual Smart App from the UI and invokes its scoped capability. Real Electron verification
must use an isolated `scripts/ai-verify.mjs` session and cover login, iframe interaction, dialogs,
two consecutive captures, tab switching, and cleanup.
