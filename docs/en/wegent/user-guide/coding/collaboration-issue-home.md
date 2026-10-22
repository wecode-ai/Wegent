---
sidebar_position: 12
---

# Creating an Issue in Collaboration

New Issue opens a content-first composer. Its project picker stays inside the top of the composer. Hovering or focusing a sidebar project reveals New conversation, which opens this composer with that project selected. Clicking the project name still opens its board.

- `@` selects a project member, agent, or collaboration group. The first valid mention becomes the owner automatically; the bottom control displays its name.
- Use the searchable owner popup to change or clear ownership. Manual selection takes precedence over mentions. Mentioning multiple people does not create multiple owners.
- `#` references another Issue in the current project without changing ownership.
- Plugin, plan-mode, and slash-command menus from Tasks are unavailable here. Creation opens the new Issue in its project.
- After switching projects, remove or replace references belonging to the previous project.

Local projects from Tasks appear automatically under Local workspace. Reloading does not duplicate them. Remote code projects are excluded, and archived collaboration projects are not restored by synchronization. Separate project identities remain separate even when their names match.

The Executor stores local ownership; the backend stores cloud ownership. A collaboration group owner is a project group reference, not a resource-library Agent's Team ID. Assigning it does not automatically execute the group's workflow.

When a project has no execution environment, the New Issue page and creation dialog show no environment notice. You can still create and handle Issues manually. Offline devices and failed environment checks retain their notices and configuration, viewing, or retry actions.

## Change an existing Issue's owner

After selecting or clearing an owner in Issue details, select **Save assignment** beside the owner. The header does not show a duplicate save action. Saving also submits other pending detail edits. If saving fails, the draft and save action remain available for correction and resubmission.

The `collaboration-local-agent-dispatch` desktop regression checks that the owner state row contains exactly one save action, that it disappears after saving, and that the assigned agent actually starts work.

## Assign directly from a discussion

The **Assign to** selector sits immediately to the left of Send and defaults to **Keep current**. Search for the next member, write a comment, and select **Send and assign**. With no comment, select **Assign**; this creates no empty comment. Selecting a person takes effect only after submission.

Selecting users through `@` automatically chooses the first eligible user mentioned in the draft. Agent mentions do not trigger a human handoff. A manual selection, including **Keep current**, takes precedence over subsequent mention edits. Automatic selection resumes after a successful submission.

If the comment fails to send, its draft and selected assignee remain. If the comment succeeds but assignment fails, the selector and error remain so you can retry **Assign** without posting the saved comment again. This control preserves existing assignment permissions, notifications, and activity history.

The `collaboration-issue-assignment-activity` desktop regression verifies first-mention selection, persisted comments and ownership, assignment without a comment, and assignment history. Focused component tests cover manual overrides, permissions, duplicate submission, and failure recovery.

## Work on an Issue assigned to me

Open an assigned native cloud Issue from Inbox or its project board. Wework sends a desktop notification when another member assigns it.

Users with editing permission can start, complete, or restart an Issue directly through the detail status selector or board dragging. Status changes require no additional information or submission form. Communicate progress, results, and feedback through comments, replies, and attachments. Status history records each change.

For AI assistance, use **New task** in Issue details to create a linked task. The task retains its assignment binding. View its Delivery from the linked task; AI does not change the Issue status on the person's behalf.

## Start a collaboration-group task from the activity timeline

A collaboration-group assignment changes the Issue owner to the member taking the work. For an assignment to you, select **Let AI help me → Create task**, or choose **Reply and create a new task** under your assignment activity. The reply is saved as a comment before a new personal task panel opens. Its instructions contain the Issue reference and assignment, without acknowledgement replies such as “Received.” Sending after selecting the device, model, and workspace starts execution. The task retains its assignment binding so Delivery reports back to the round coordinator.

An AI-only handoff retains the worker as owner and does not start a coordinator summary.

## Archive completed Issues

Project boards and tables can archive Issues whose status is **Completed**. Incomplete Issues do not expose the archive action and cannot be included in a batch archive.

- Single archive: open a completed Issue's action menu and select **Archive**.
- Batch archive: select **Archive completed issues** in the board's **Completed** column header.
- Browse and restore: open the project's **Archived Issues** drawer to page through archived records and restore them individually. A restored Issue returns to the active list in its original project.

Archiving a parent Issue also archives its child Issues so the active task tree cannot retain orphaned children. Restoring that parent from the archive restores the full subtree. Restoring a child that was archived independently restores only that Issue. Native cloud projects, local projects, and GitHub/GitLab-backed projects share the same interaction. For external projects, archive and restore close and reopen the external Issue respectively.

## Regression verification

`pnpm --filter wework e2e:desktop --segment collaboration-shared-core` uses isolated Electron, the real backend, and the local Executor. Only model services are simulated. Added checks cover:

1. Icon-free project labels, stable row height, and project-specific new conversation navigation.
2. Creating Issues through member, agent, and group mentions, then checking persisted ownership through the API.
3. Issue-only `#` suggestions, distinct reference icons, and saved references.
4. Manual ownership changes and clearing without native selects; no task slash menu.
5. Seeding a local project through the real Tasks project API, reloading twice, and verifying one imported project with a working collaboration entry.

Cloud fixtures are archived by the checkpoint cleanup. Local fixtures live only in the test Executor home. Failures retain runner logs; tests do not skip or retry to hide failures.

`pnpm --filter wework e2e:desktop --segment collaboration-issue-archive` uses a real local project to verify that incomplete Issues cannot be archived, along with single archive and restore, batch archive, and archive-drawer updates.

`pnpm --filter wework e2e:desktop --segment collaboration-human-round-resume` covers concurrent human and AI assignment, Delivery returning to the coordinator, replies to the current human assignment opening a new task without acknowledgement text in its prompt.

## Web project views

Projects support Board, Calendar, Gantt, Table, Files, and Project settings. Calendar and Gantt selections persist in the URL across reloads and opening or closing Issue details. Project board cards and their drag previews display no unread dot or unread highlight.

Each lane on a native project board has a **Sort by** control in its header. Lanes default to highest priority first. Combine ascending or descending rules for priority, creation time, and update time, then move rules up or down or remove them. Rules apply from top to bottom: each subsequent rule breaks ties, and manual order breaks any remaining ties. Choose **Manual order** to reorder cards within status, priority, assignee, or tag lanes, or insert a card into another lane at a specific position. Non-status lanes can mix Issues with different statuses; reordering within a lane preserves status, assignee, and tags. Manual positions use the project’s shared order across groupings. Preferences are saved in the current browser by user, project, grouping, and lane, restore separately after reloads or account switches, and do not affect other members. Drop onto the blank space at the end of a lane to append a card. Group fields and position are saved together; a failed save commits neither. Changes to different lane preferences in multiple tabs are retained independently and synchronized to open boards.

The collaboration sidebar no longer includes My Work or Run Center. Their former URLs return to collaboration home. Open Issues that need action or review from Inbox or the project board.

Web regression: `pnpm --dir frontend exec playwright test collaboration/collaboration-project-views.spec.ts --project=chromium`. The existing Chromium CI suite includes this file. It uses real workspaces, projects, and unread Issues created by another member, then archives its fixtures.
