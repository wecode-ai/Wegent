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

An item identity shared by the native page and observed stream establishes a confirmation boundary. History supersedes unpositioned provisional cache entries before that boundary; they cannot move to the end of confirmed history. Previously positioned history remains loaded, and the unconfirmed live suffix remains visible. This boundary uses identity intersection rather than text or timestamp guesses.

## Ownership and synchronization

Native normalization produces turns/items and presentation messages in one pass. The native primary path does not reconstruct turns from rendered messages. Other runtimes and legacy history retain their explicit adapter boundaries.

Task navigation, reconnection, and lifecycle reconciliation use `synchronizeRuntimeConversation`: identical requests coalesce, competing writes within a conversation serialize, and other conversations proceed independently. Archival invalidates outstanding writes. Navigation metadata reads do not mutate transcript content.

Live updates continue publishing during a history read. Their observed state is retained for the commit. Append-only tool deltas are materialized against that state before reconciliation, avoiding duplicate appends when native history already contains them. Text reconciliation uses stable item identity and preserves complete prefixes already included in native history. This contract does not claim that the upstream protocol exposes an atomic revision or watermark.

Paging and conversation-cache lifecycle own loaded native history. The provisional-output block limit cannot silently discard confirmed history. Goals project execution state; explicit transport gaps and recovery events belong to the synchronization layer.

## Viewport restoration

Bottom-follow snapshots retain follow intent. Historical reading snapshots retain message/item identity, available text offsets, and viewport position. Initial virtual positioning establishes the approximate viewport; the scroll controller then restores the same content, retaining pending restoration while layout mounts it. React keys and expansion state use item identity rather than array indices.

## Verification

A real pinned binary was exercised in an isolated Codex Home with 510 synthetic items across six native pages, confirming unique identities, monotonic positions, and the 100-entry page limit. Synthetic database seeding is test setup only; production reads use public RPC methods rather than Codex database access.

Focused regressions cover corrupted order repair, overlapping-page permutations, duplicate reads, identical text with distinct identities, snapshot/delta races, live updates after loading over 500 items, archival, native-thread replacement, and immediate task snapshot switching.

The `streaming-conversation-switching` desktop checkpoint is registered in the shared runner and CI suite. It mocks only model responses, uses the real executor to produce more than 500 items, continues streaming across task navigation, and checks stable identity/order without duplicated content. Repository policy requires an explicit request before running desktop E2E or `ai:verify`; registered coverage is not evidence of an executed run.
