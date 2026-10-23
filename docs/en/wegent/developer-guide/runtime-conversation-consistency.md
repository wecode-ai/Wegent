---
sidebar_position: 81
---

# Runtime conversation consistency

The shared conversation Store owns Wework transcripts. Execution lifecycle, Goal continuation, and composer drafts are separate state. A pane must not keep another writable transcript or infer missing history from the presence of rendered messages.

## Ordering contract

The pinned Codex `0.163.0-alpha.5` supports `thread/timeline/list`. Entries carry their canonical rollout `position`; the initial request reads the newest window, and `nextCursor` pages backwards. Each native request returns at most 100 entries. Ordinary executor reads combine at most five pages; only explicit full-content requests traverse the remaining history. Native cursors remain opaque.

`thread/items/list` supplies ordered arrays, but its entries and live notifications do not share a persisted position or snapshot revision. Receive order, timestamps, tool completion times, and text equality cannot establish canonical history order.

The executor preserves native positions on normalized turns and items. Multiple display blocks derived from one source item retain its position and their stable identities. Pages and events update items by identity; confirmed positions determine ordering. Distinct native items with identical text remain distinct. Unpersisted live output may remain provisional without a position. Completed live-cache items outside a native page must not be appended to that page.

Positions belong to a native `threadId`. Replacing a thread invalidates the previous branch's cached ordering and supersedes its in-flight reads. Ordinary task navigation retains each task's shared conversation.

A turn can span multiple native pages. Only a page containing its user item or turn-start boundary owns a synthetic user presentation; turn metadata carried by a cursor cannot transfer that ownership to another page.

Persisted items use native positions; unpositioned runtime items retain their observed native neighbors. Absence from a history page is not deletion. The executor overlays unfinished current items onto native history before projecting turns and messages once, so both API views contain the same current content. Completed historical caches cannot enter this overlay. Separate runtimeTurns carry only running background commands and their output, anchored by neighboring identities from the current native page without replaying cached text. The frontend uses native history as its base and runtime state as its overlay. Explicit supersededTurnIds remove replaced turns and reject late events. Native users bind to host send identities only through a unique user and presentation in the same turn.

## Ownership and synchronization

Native normalization produces turns/items and presentation messages in one pass. Guidance may split a turn into display segments, but turn-level artifacts aggregate across those segments rather than come only from the last segment. The native primary path does not reconstruct turns from rendered messages. Other runtimes and legacy history retain their explicit adapter boundaries.

Edit/retry supersession markers filter native turns before normalization so both projections agree. Metadata reads reuse the existing startup retry only for explicit not-ready protocol errors; permanent errors still propagate to the caller.

Task navigation, reconnection, and lifecycle reconciliation use `synchronizeRuntimeConversation`: identical requests coalesce, competing writes within a conversation serialize, and other conversations proceed independently. Archival invalidates outstanding writes. Navigation metadata reads do not mutate transcript content.

Live updates continue publishing during a history read. Their observed state is retained for the commit. Append-only tool deltas are materialized against that state before reconciliation, avoiding duplicate appends when native history already contains them. Text reconciliation uses stable item identity and preserves complete prefixes already included in native history. This contract does not claim that the upstream protocol exposes an atomic revision or watermark.

Child-thread views are read-only projections: they neither adopt the child as the parent task thread nor update parent context usage. The cache applies updates immediately; React subscriptions coalesce view notifications per animation frame without holding another message state.

Each live action is published once on arrival. Completing or aborting hydration only notifies subscribers of the snapshot change; replaying actions would repeat their side effects.

Paging and conversation-cache lifecycle own loaded native history. The provisional-output block limit cannot silently discard confirmed history. Goals project execution state; explicit transport gaps and recovery events belong to the synchronization layer.

## Viewport restoration

Bottom-follow snapshots retain follow intent. Historical reading snapshots retain message/item identity, available text offsets, and viewport position. Initial virtual positioning establishes the approximate viewport; the scroll controller then restores the same content, retaining pending restoration while layout mounts it. React keys and expansion state use item identity rather than array indices.

## Verification

A real pinned binary was exercised in an isolated Codex Home with 510 synthetic items across six native pages, confirming unique identities, monotonic positions, and the 100-entry page limit. Synthetic database seeding is test setup only; production reads use public RPC methods rather than Codex database access.

Focused regressions cover corrupted order repair, overlapping-page permutations, duplicate reads, identical text with distinct identities, snapshot/delta races, live updates after loading over 500 items, archival, native-thread replacement, and immediate task snapshot switching.

The `streaming-conversation-switching` desktop checkpoint is registered in the shared runner and CI suite. It mocks only model responses, uses the real executor to produce more than 500 items, continues streaming across task navigation, and checks stable identity/order without duplicated content. Repository policy requires an explicit request before running desktop E2E or `ai:verify`; registered coverage is not evidence of an executed run.
