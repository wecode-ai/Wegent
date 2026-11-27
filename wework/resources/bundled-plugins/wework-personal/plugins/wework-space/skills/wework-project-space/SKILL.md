---
name: wework-project-space
description: Discover, read or update Wework project spaces and Issues (事项, Issue, 看板事项), attachments, deliveries and members, with or without a bound project or Issue. Personal tasks (个人任务) and conversations (会话) use wework-runtime conversations instead.
---

# Wework project space

Use the `wework_space` MCP tools for project-space work. Discover deferred tools before reporting them unavailable; their schemas and business data are loaded when needed.

Project Issues (事项, Issue, 看板事项) are board items, distinct from personal tasks (个人任务) and conversations (会话). In a project context, “查一下事项” means list the current project's Issues with `list_board_items`; use `search_board_items` for requested filters. Explicit personal-task or conversation queries use `wework_control`, even in a project. A linked execution conversation is not the Issue itself. Identify the project and Issue in results; for empty results, state that no matching Issues were found in the queried project. Clarify only when the remaining intent or target is ambiguous.

1. Call `get_current_context` before answering questions about the current project or Issue. Reuse its `space_ref` for batch targets; it identifies the authorized storage source without enumerating projects. A dispatched Executor must not call `list_spaces` to resolve its binding. If `space_ref_error` is present, report that source-reference limitation while retaining authorized individual Issue reads. `bound: false` means there is no complete Issue binding; if `space_id` is present, reuse that project for Issue queries. Use `list_spaces` for personal discovery when no project is bound or the user requests another project. A personal conversation does not require a preselected project or a cloud link in the prompt.
2. Call `get_board_item` with that context before interpreting the Issue description.
   Read `list_board_item_comments` as well for PR links, follow-up requirements and review feedback. It returns the latest 200 comments by default; use `limit` (up to 500) and `after_sequence` to page forward. Write with `add_board_item_comment` to the same visible Issue activity.
3. Use `list_item_attachments` and `read_item_attachment` to inspect Issue attachments.
4. Use the current context instead of asking the user to repeat a project or Issue identifier.
5. Do not probe MCP resources, use Shell or `curl`, scrape the browser, or parse `wegent://` attachment URLs.
6. Never substitute Git or provider APIs when `wework_space` reports an offline, authorization, or capability error.
7. Do not claim Issue content is unavailable until the matching `wework_space` call returns an error.

Human assignee changes notify the new owner by default. Do not send a duplicate notification. For user-requested alerts or automation conditions, use `send_notification`; omit `recipient_user_id` to notify the authenticated user.

## Batch work and complete review

- `list_spaces` returns an object with `items`, `matched_total`, `next_cursor` and `coverage`; follow `next_cursor` until null, check `coverage.complete`, and preserve each item's `space` reference. Do not claim complete discovery or absence while coverage is incomplete. Backend spaces contain `project_store` and `space_id`; local spaces also contain `device_id`. Never infer the store from an ID.
- Call `describe_space_board` with `space` before choosing status IDs or conditional-write capabilities. Status IDs come from that project's board configuration.
- `search_board_items` accepts an explicit `scope` (`projects` with `spaces`, `workspace` with `workspace_id`, or `accessible`), typed `assignees`, separate `creator_user_ids`, `statuses` or `exclude_statuses`, tags and time ranges. It returns a page object, never a bare array. Continue `next_cursor` until null. A `collecting` result requires its `continuation_cursor`; do not treat `matched_so_far` as a complete total. Report incomplete source coverage.
- For “我参与的事项”, use `search_board_items` with `participation: "mine"` and `scope: { kind: "accessible" }` unless the user asks for a narrower scope. The filter uses the authenticated user and current Issue visibility.
- `aggregate_board_items` groups the complete filtered query using `query_id` or `search`, not just the last page. Tag counts describe memberships and can exceed the number of Issues.
- Use `batch_get_board_items` for details, versions and optional `permissions`, `attachment_metadata` or `delivery_summaries`. Each target is `{space, item_id}`. Results remain in input order and report failures independently. `batch_get_assignment_candidates` accepts `spaces` and optional candidate `types`.
- `batch_list_board_item_comments` requires each entry's `request_id`, `target` and `mode`. Use `oldest` followed by `after` with that entry's `next_cursor` for complete history; `latest` does not certify complete history. Check `has_earlier`, `has_later` and `history_complete` before drawing conclusions.
- Mutations use `batch_update_board_items`, `batch_assign_board_items`, `batch_add_board_item_comments` and `batch_create_board_items`. Supply one stable `operation_key` and unique per-entry `request_id`; updates and assignments require the observed `expected_version`. Use `preview: true` when a review is requested. Preview creates no receipt and does not authorize execution; commit revalidates business rules. Preserve existing approvals, notifications, mentions and execution semantics.
- Inspect every mutation result. Reusing a key with changed content is an error; replaying the same request never repeats effects. Repeated targets execute in input order and stop after a failed predecessor. A batch can partially succeed and is not a cross-source transaction. Recover a lost response with `get_board_operation` using its `operation_id` or original `operation_key`. An `unknown` result may have committed: read the receipt rather than resubmitting with a new key. Receipt reads revalidate current access.
- Batch wrappers do not widen dispatched roles, project/Issue scope or direct-parent read exceptions. Unsupported source capabilities fail explicitly; never switch to provider APIs.

To @ a member in a shared Backend project's comment, resolve the member with `get_assignment_candidates`, then pass `mentions=[{"type":"user","id":"52","label":"qindi"}]` together with the comment `body`, `space_id` and `item_id` to `add_board_item_comment`. Plain `@name` text does not notify. This uses the same member and Issue access checks as the page and creates one notification per recipient; do not also call `send_notification`. Pure local projects do not have a shared member inbox.
