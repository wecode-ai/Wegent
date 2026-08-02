---
sidebar_position: 19
---

# Wework Message Scroll Verification

The Wework desktop chat list uses virtual scrolling. After sending a message, scrolling must cover the asynchronous layout measurements for both the user message and waiting indicator until the list is stably pinned to the bottom, keeping the thinking indicator fully visible. As a streaming response grows, the view should follow it only while the user remains at the bottom; otherwise the user's current viewport must be preserved.

Implementations must preserve these invariants:

- The final streaming message uses the virtualizer's normal measurement path, avoiding duplicate measurements that can invalidate the bottom anchor.
- A new user message or waiting indicator must not rely on one synchronous scroll. Follow layout-height changes through a short stabilization window, then restore the latest-turn reading-position protection.
- Once the user scrolls upward, later message-height changes must not pull the viewport back to an earlier message.
- Regression coverage must send a message in a long-history real Tauri conversation, pause the model response, and assert that the scroller is at the bottom and the waiting indicator is fully contained by the scroll-container bounds.

Run the desktop regression:

```bash
cd wework
pnpm e2e:desktop:streaming-text
```

The scenario uses real backend requests and a deterministic SSE response stream supplied by the desktop E2E harness. It pauses the server before output begins so the race between the user message rendering and the later waiting-indicator and virtual-list measurements is deterministic. Do not hide a scroll regression by skipping the scenario, mocking frontend requests, or weakening the bottom or visibility assertions.
