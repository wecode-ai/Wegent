---
sidebar_position: 19
---

# Wework Message Scroll Verification

The Wework desktop chat list uses virtual scrolling. After sending a message, scrolling must cover the asynchronous layout measurements for both the user message and waiting indicator until the list is stably pinned to the bottom, keeping the thinking indicator fully visible. As a streaming response grows, the view should follow it only while the user remains at the bottom; otherwise the user's current viewport must be preserved.

Implementations must preserve these invariants:

- The final streaming message uses the virtualizer's normal measurement path, avoiding duplicate measurements that can invalidate the bottom anchor.
- A new user message or waiting indicator must not rely on one synchronous scroll. Follow layout-height changes through a short stabilization window, then restore the latest-turn reading-position protection.
- Once the user scrolls upward, later message-height changes must not pull the viewport back to an earlier message. The pause must be kept even when the upward scroll has not yet crossed the bottom tolerance; the follow engine must not yank the viewport back to the bottom on account of that.
- The scroll anchor belongs to the app: the chat scroll container keeps `overflow-anchor: none` on at all times, so the browser never adjusts `scrollTop` behind the reader's back when content height changes. The browser's own anchoring reacts in opposite directions depending on whether the change happened above or below the viewport, and relying on that guess is what produced the repeated bounces and the viewport drifting down. With it disabled, only two things can move the reader: their own scrolling, and the layout change that just happened — both measurable.
- There is exactly one decision point, and it only relies on measurements: while the reader owns the viewport, the scroll area's layout-change handler takes "where the sampled text sits on screen now" minus "where it sat when sampled", adds "how far `scrollTop` moved in that window", and writes the result back to `scrollTop` (`correction = ΔanchorOffset + ΔscrollTop`). A pure reader scroll moves the text by exactly `-ΔscrollTop`, so the two cancel and their scrolling is never taken back; whatever is left is the layout change's own effect, which has to be given back. That single rule covers a whole-list reflow (the conversation narrowing when the file panel opens), a re-measured row above the viewport, and a streaming response growing below it, and it holds for every scroll origin (moving `scrollTop` by `x` moves the text by `-x` in each). The handler runs inside the ResizeObserver callback (after layout, before paint), so the move is never visible; when the sampled text is no longer on screen the change cannot be attributed, so nothing is guessed and the sample is simply retaken; the correction must re-sample afterwards, otherwise the window spans across it.
- Layout height must never be fabricated to keep the scrollbar still (for example by holding a shrunken row at its old height): the fabricated height has to be released eventually, and the release moves the scrollbar and the content again while leaving blank space that never disappears once the reader scrolls to it. Scrollbar movement can only be reduced with better initial estimates, which shrink the re-measure deltas themselves.
- The user viewport anchor is the reading position the user chose (message plus text offset plus the `scrollTop` it belongs to). It is refreshed on real user intent (wheel, pointer, touch, key) and after every correction; when no visible anchor can be resolved the previous sample is kept, and an empty capture must never overwrite a usable anchor.
- When the user explicitly clicks “scroll to bottom,” the button's pointer event must not remain recorded as manual scroll intent. The action must own bottom following through a short stabilization window so later virtual measurements or streaming growth still reach the latest bottom. The bottom-follow ownership must be held until the viewport actually settles at the bottom; it must not be released at a fixed point in time, otherwise a still-growing response can leave the viewport mid-conversation.
- When reopening a long conversation, the canonical turn-level conversation view must merge by the global `messageIndex` returned by the executor transcript. A locally preserved stopped turn that is absent from the paginated snapshot must return to its original position instead of being appended after the latest AI response; temporary turns without an index may use message timestamps as a secondary ordering key. Provider transcript pages remain Provider-owned: deduplicate them by stable IDs without merging local stopped turns into them or bypassing their pagination.
- When an idle task receives a new goal, the goal and first instruction must be sent atomically through one `runtime.tasks.send`. Codex `thread/goal/set` automatically starts the goal turn, so the executor must await that turn instead of issuing another `turn/start`; otherwise the real output is associated with the wrong position while the duplicate idle turn eventually shows a “Message generation failed” error after 180 seconds.
- Regression coverage must send a message in a long-history real Electron conversation, pause the model response, and assert that the scroller is at the bottom and the waiting indicator is fully contained by the scroll-container bounds.

## Streaming Rendering Ownership

Streaming text and scroll following each have exactly one scheduler. Component animation, direct scrolling, and delayed scroll timers must not compete:

- `useBufferedStreamingText` only coalesces text updates received within one frame into the next animation frame. It must not maintain a typewriter queue that trails the authoritative message content; the next frame must commit the latest complete prefix, with a short timeout fallback when frames are unavailable.
- `Streamdown` remains in `streaming` mode for incremental Markdown parsing. Existing windowing and freezing continue to own non-tail Markdown blocks; animation must not rebuild the whole message tree.
- Streaming auto-follow in `ScrollableMessageArea` is owned by one damped spring. ResizeObserver callbacks, message appends, and runtime-state changes may only ask that spring to keep tracking the latest bottom; they must not also perform streaming jumps or schedule stabilization timers.
- User upward scrolling, turn-navigation suspension, or auto-scroll suspension immediately cancels the spring. Non-streaming layout stabilization, history restoration, and explicit “scroll to bottom” actions keep their existing paths without running concurrently with the streaming spring.
- With `prefers-reduced-motion`, skip spring motion and position the viewport at the bottom immediately.

Run the desktop regression:

```bash
cd wework
pnpm e2e:desktop:streaming-text
```

The scenario uses real backend requests and a deterministic SSE response stream supplied by the desktop E2E harness. It pauses the server before output begins so the race between the user message rendering and the later waiting-indicator and virtual-list measurements is deterministic. Do not hide a scroll regression by skipping the scenario, mocking frontend requests, or weakening the bottom or visibility assertions.

Streaming rendering changes must also verify that frame coalescing immediately displays the latest complete prefix, including Unicode content, plus spring convergence, user-scroll pause, and bottom-follow recovery. The real Electron scenario must retain viewport-anchor evidence before and after later streaming appends and verify that those appends do not move the user-selected anchor. The explicit bottom-recovery regression must dispatch real pointer-down and click events, continue appending enough content to change the virtualized height after the click, and finally assert that the remaining bottom distance is within the scroll tolerance.

The ordering regression first stops a response, sends 26 follow-up turns to move the stopped turn outside the default transcript page, switches to other tasks, reopens the original task, and verifies that the latest AI response—not the “Stopped” notice—occupies the bottom position.

The goal-continuation regression verifies that one `runtime.tasks.send` payload contains both the goal and first instruction, then reads the real executor log to confirm that submission awaits exactly one turn automatically started by `thread/goal/set`, issues no extra `turn/start`, and renders no error card during streaming or after completion.
