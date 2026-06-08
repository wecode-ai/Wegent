---
sidebar_position: 23
---

# Page Zoom Policy

## Background

Wegent mobile and desktop clients require a stable page layout, so users must not be able to manually zoom the entire page through browser or WebView defaults. Business components such as image previews, canvases, and remote desktops may still provide their own zoom controls.

The Next.js frontend already declares a fixed viewport in its root layout. The standalone `wework` client only declares an initial scale and does not centrally handle desktop page-zoom shortcuts.

## Goals

- Prevent pinch-to-zoom for the entire page on mobile clients.
- Prevent `Ctrl/Cmd + +/-/0` from zooming or resetting the entire page on desktop clients.
- Prevent `Ctrl/Cmd + wheel` from zooming the entire page.
- Prevent page-level native zoom gestures in WebViews that expose gesture events.
- Preserve zoom implemented by business components through buttons, sliders, or internal event handling.

## Non-goals

- Do not remove zoom buttons from images, canvases, charts, or remote desktops.
- Do not intercept scrolling without a modifier key.
- Do not change operating-system display scaling or accessibility settings.
- Do not change the WebView rendering scale from the Tauri Rust layer.

## Design

### Declarative viewport

`wework/index.html` will use the same viewport policy as the Next.js frontend:

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"
/>
```

This declaration controls page zoom in mobile browsers and mobile WebViews. The Next.js frontend will retain its existing `maximumScale: 1` and `userScalable: false` root-layout configuration.

### Central page-zoom guard

`wework` will provide a dedicated page-zoom guard module installed by the application entry point. It will handle only inputs that trigger default browser or WebView page zoom:

- `keydown`: when `Ctrl` or `Meta` is pressed, intercept `+`, `-`, `=`, numeric-keypad add/subtract, and `0`.
- `wheel`: prevent the default action when `Ctrl` or `Meta` is pressed.
- `gesturestart` and `gesturechange`: prevent native page zoom on platforms that expose these events.

The guard will not handle ordinary clicks, component state, or wheel events without a modifier. Explicit component zoom controls and internal component zoom logic therefore remain unaffected.

The installation function will return a cleanup function so tests and future application teardown can remove all listeners. Event listeners will use browser-compatible options; listeners that call `preventDefault()` must not be passive.

## Data Flow

1. The `wework` application entry point starts.
2. The page-zoom guard registers input listeners on `document`.
3. When the user triggers page-level zoom input, the guard calls `preventDefault()`.
4. Other input continues to business components.
5. Application teardown or test cleanup invokes the returned function to remove listeners.

The feature does not call the backend, persist state, or introduce a user setting.

## Testing

Unit tests will cover:

- Blocking `Ctrl` and `Meta` zoom-in, zoom-out, and reset shortcuts.
- Blocking wheel events modified by `Ctrl` or `Meta`.
- Blocking native zoom gesture events.
- Allowing ordinary keys and wheel events.
- Removing all listeners through the cleanup function.
- Ensuring the `wework` viewport contains the fixed-scale declaration.

Verification will run the relevant `wework` unit tests, TypeScript checks, and lint. Existing business-component zoom tests must continue to pass.

## Risks and Constraints

Browsers may still allow users to change zoom through developer tools or browser menus, which page scripts cannot reliably control. The Tauri client does not expose a zoom menu, so this design covers its normal manual input paths.

Disabling page zoom reduces access to browser zoom as an accessibility feature. The business UI must remain readable and responsive, and operating-system accessibility features must remain available.
