---
sidebar_position: 19
---

# Wework Message Scroll Verification

The Wework desktop chat list uses virtual scrolling. After sending a message, the latest user message must be fully inside the chat scroll container. As a streaming response grows, the view should follow it only while the user remains at the bottom; otherwise the user's current viewport must be preserved.

Implementations must preserve these invariants:

- The final streaming message uses the virtualizer's normal measurement path, avoiding duplicate measurements that can invalidate the bottom anchor.
- Once the user scrolls upward, later message-height changes must not pull the viewport back to an earlier message.
- Regression coverage must send a message in the real Tauri application and assert that the user-message bounds are fully contained by the scroll-container bounds.

Run the desktop regression:

```bash
cd wework
pnpm e2e:desktop:streaming-text
```

The scenario uses real backend requests and a deterministic SSE response stream supplied by the desktop E2E harness. Do not hide a scroll regression by skipping the scenario, mocking frontend requests, or weakening the visibility assertion.
