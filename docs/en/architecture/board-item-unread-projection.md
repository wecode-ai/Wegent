---
sidebar_position: 24
---

# Board Issue unread projection

Scope: Issue content changes, status changes, and Runtime or Delivery dynamics advance one content revision, while per-user read cursors project unread state onto the board.

```mermaid
flowchart LR
    USER[User update] --> CHANGE[Meaningful Issue change]
    RUNTIME[Runtime state] --> CHANGE
    DELIVERY[Delivery / Workflow dynamic] --> CHANGE
    CHANGE --> REV[(metadata.content_revision)]
    REV --> EVENT[Issue changed event]
    EVENT --> BOARD[Board reload]
    OPEN[User opens detail] --> READ[Atomically write metadata.read_revisions.user_id]
    REV --> UNREAD[Server unread projection]
    READ --> UNREAD
    UNREAD --> BOARD
```

```mermaid
sequenceDiagram
    participant C as Change source
    participant S as LoopItem service
    participant DB as metadata_json
    participant E as Issue changed event
    participant B as Board

    C->>S: Submit a meaningful content or dynamic change
    S->>DB: Atomically increment content_revision
    S->>DB: Align the actor read revision
    S-->>E: Publish item_id + content_revision
    E-->>B: Invalidate and reload
    DB-->>B: is_unread = read_revision < content_revision
    B->>S: Open Issue and mark read
    S->>DB: Atomically ensure read_revisions object and update this user's cursor
    S-->>B: Return is_unread=false
```

| Edge                                      | Code ownership                                                        |
| ----------------------------------------- | --------------------------------------------------------------------- |
| Meaningful change → content revision      | Backend `loop_item_unread` and LoopItem mutation services             |
| User read → read revision                 | Backend deliveries API and `loop_item_unread`                         |
| Revision → current-user unread projection | Backend `LoopItemService.response_values` and delivery schema         |
| Issue changed → board refresh             | Backend `loop_item_events` and Wework `projectChatSocket`             |
| Unread projection → card marker / read    | Wework `CloudTodoWorkspace`, `CloudTodoBoardCard`, and deliveries API |

Essential invariants:

- Unread is a server-side relationship projection for the current user, not local client state.
- `content_revision` advances only for user-visible Issue content, status, Workflow, Runtime, or Delivery changes. Reordering, listing, and marking read do not advance it.
- `read_revisions` reuses the LoopItem `metadata_json`, keyed by user ID with the last read `content_revision`; no database table is added.
- The formula is fixed: an absent read cursor or `read_revision < content_revision` means unread.
- A meaningful update aligns the actor's read cursor in the same transaction, so a user's own edit does not immediately become unread.
- Mark-read must ensure a missing or invalid `read_revisions` value is an object and update one user's JSON path in the same database expression. It must not read and overwrite the entire `metadata_json`, discard other users' cursors, increment the LoopItem optimistic-lock `version`, or change business `updated_at`.
- The Issue changed event only invalidates projections and is never unread truth. List and detail APIs restore correct state after reconnects or cross-device access.
