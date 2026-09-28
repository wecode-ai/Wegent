---
sidebar_position: 11
---

# Issue activity comment composer interaction contract

This contract covers the main composer in issue activity. Inline reply composers always scroll with their cards.
“Per frame” means geometry invariants on every rendered frame, not a timed animation. All dimensions are CSS pixels.

## Collaboration Issue activity and execution

Opening an Issue from the Collaboration board shows creation, status changes, and comments in time order in the right detail drawer. An execution belongs to the comment that started it: the comment shows its run status, and selecting the status opens the linked task conversation in a second drawer while keeping the Issue visible. Collaboration no longer opens a separate execution overlay. The Tasks tab keeps its board task entry point.

A comment initially shows a body preview, with expansion for long content. The author, run status, time, and Reply action remain visible when the body is collapsed. Reply opens that comment's inline composer on demand; comments with an active execution cannot be replied to. Completed runs display their persisted terminal status instead of an unverified status.

For AI managed workflows, the manager writes an execution prompt for each child task from the Issue. Executors report their outcomes to the manager, who then decides whether the Issue moves to In review or Completed. Finishing a child task does not automatically make either transition. These manager decisions appear alongside manual status changes in the activity timeline. The automation summary shows the current stage and child task progress without repeating the full stage chain.

## Geometry and states

- `V`: the visible bottom edge of the actual detail scroll container.
- `G = max(16px, safe-area-inset-bottom)`: pinned bottom inset.
- `N`: the composer's normal-flow bottom in viewport coordinates.
- `B`: its actual bottom. While activity is visible and the composer fits, `B = min(N, V-G)` on every frame, within `1px`.
- Its horizontal edges match the content column within `1px`; state changes must not change width.
- Keep one DOM instance to preserve focus, drafts, attachments and IME composition.

```mermaid
stateDiagram-v2
  [*] --> Pinned: Long content, N greater than V-G
  [*] --> InFlow: Short content, N at or below V-G
  Pinned --> InFlow: Scroll down until N reaches V-G
  InFlow --> Pinned: Scroll up until N exceeds V-G
  Pinned --> Pinned: Height or viewport changes
  InFlow --> InFlow: Content changes without crossing the boundary
```

## Frame-by-frame behavior

| Situation                              | Required behavior                                                                  | Prohibited behavior                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Enter activity                         | Pin for long content; remain after short content without excessive whitespace      | Flash in the middle before snapping down                    |
| Scroll the middle                      | Keep `B = V-G`; only content moves                                                 | Body text visible below the pinned composer                 |
| Approach the end                       | Transition continuously when `N = V-G`                                             | Position animation, jitter or duplicate inputs              |
| Reach the end                          | Use normal flow; at least `12px` after the final event and `32px` page-end spacing | Permanent occlusion or duplicate spacer height              |
| Reverse scrolling                      | Retrace the same geometry without resetting draft, focus or scroll                 | Force scrolling to the bottom                               |
| Enter more lines                       | Grow upward from two lines; cap the text area at `240px`, then scroll internally   | Native resize handle or downward growth                     |
| Expand attachments, settings or errors | Grow upward; constrain height in short panels and keep controls reachable          | Controls outside the panel or clipped popovers              |
| Receive content or load images         | Reflow under the same formula; preserve the reader's position in the middle        | Timers or repeated scrollTo calls to conceal layout defects |
| Resize panel or change safe area       | Recompute layout against actual `V` and `G` on the next frame                      | Cached window dimensions or screen coordinates              |

An opaque panel-colored bottom gutter prevents content from appearing beneath the pinned surface.
The composer reserves its own normal-flow space: do not add a second fixed-height placeholder. Keep settings menus on their separate overlay layer.
In short panels, constrain composer height to the visible height minus the bottom inset and `16px` top clearance, with internal scrolling as necessary.

## Implementation constraints

1. The detail pane is the only vertical body scroll owner; activity must not create another scroll region.
2. Keep one bottom-inset source. Do not add scroll-container bottom padding to the sticky bottom inset; put end spacing inside the content column.
3. Use browser layout instead of per-scroll top/transform writes or input remounts.
4. Dynamic input, attachment and settings heights must participate in layout; never position using only the initial measured height.
5. Respect the configured send shortcut, Shift+Enter and IME confirmation; preserve drafts and attachments after failure.
6. Web and desktop share the main composer, attachment cards and image preview. Hosts provide file storage and download services. Show image thumbnails during upload, then use the shared lightbox with zoom, download and close controls.
7. The main toolbar contains execution settings, attachments and send. Typing `@` reveals available member or agent candidates; inserting a mention changes only the comment body and never implicitly reassigns the Issue.
8. Execution settings apply to the current comment's execution context; never substitute a project-wide configuration action. Keep the draft while sending and clear it only on success. Results from an old Issue must not update the new Issue's composer.

## Acceptance evidence

Each activity body initially shows up to `240px`, or `192px` on narrow screens (at most `767px`), roughly 8–10 ordinary text lines.
Measure rendered height: short content needs no toggle; overflowing content offers Show full content / Collapse without truncating Markdown source.
Only collapse the body, keeping authors, timestamps, reply controls and run status accessible. Expansion preserves tables, code and links without introducing a nested vertical scroller.
Remeasure after resizing, streaming updates and image loading; preserve the user's expanded state.
If collapsing moves the activity above the panel, bring its top into view instead of jumping to the list's bottom.

Use short and multi-screen Markdown threads, code blocks, a final run event, attachments and send errors.
Check desktop and narrow panels at entry, mid-scroll, `1px` on both sides of the transition, the end and reverse scrolling.
Include multiline input, expanded settings and viewport resizing. Record scrollTop, scroll-container rect, composer rect and normal-flow bottom per frame; assert the formula and retain middle/end screenshots.
Append content while reading the middle and verify no forced bottom jump. The final event must be fully readable at the end.

An isolated CSS check proves only layout mechanics. Unit tests, type checks and still images do not replace real Electron scroll acceptance.
Under repository policy, run E2E and AI verify only when explicitly requested, and report unexecuted checks as unverified.

Web and desktop activity share the desktop Markdown renderer for headings, numbered lists, highlighted code, table copy/expansion and diagram previews. Hosts provide clipboard, navigation, theme and authenticated attachment services; local files and local HTML previews remain desktop capabilities. Do not add a separate Web body renderer or stylesheet.
