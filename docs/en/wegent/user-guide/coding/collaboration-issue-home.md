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

## Change an existing Issue's owner

After selecting or clearing an owner in Issue details, select **Save assignment** beside the owner. The header does not show a duplicate save action. Saving also submits other pending detail edits. If saving fails, the draft and save action remain available for correction and resubmission.

The `collaboration-local-agent-dispatch` desktop regression checks that the owner state row contains exactly one save action, that it disappears after saving, and that the assigned agent actually starts work.

## Work on an Issue assigned to me

When a native cloud project Issue is assigned directly to one member, they can open it from **Collaboration → My Work → Assigned to me** or the project board. Wework sends a desktop notification when another member assigns it. This workflow does not apply to external task sources or Issues owned by robots or collaboration groups.

1. Select **Start work** to move the Issue to **In progress**. Add progress, comments, and attachments in its details. Select **Ask AI for help** to create a linked task when AI help is useful.
2. When the work is ready, select **Submit for review** and enter a completion summary. The Issue moves to **Pending review**, and the summary is saved in the project conversation.
3. The original assigner can find the Issue under **My Work → To review** and choose **Accept work** or **Request changes** with a reason. If the original assigner cannot review, a project Owner or Maintainer can do so.
4. Acceptance moves the Issue to **Completed**. Requested changes return it to **In progress** so the assignee can revise and submit again.

These actions record status history and project activity and notify the relevant members. Reassignment clears the previous review result. Use these actions to advance the status of human-owned work.

## Archive completed Issues

Project boards and tables can archive Issues whose status is **Completed**. Incomplete Issues do not expose the archive action and cannot be included in a batch archive.

- Single archive: open a completed Issue's action menu and select **Archive**.
- Batch archive: select one or more completed Issues in the table, then select **Archive**.
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
