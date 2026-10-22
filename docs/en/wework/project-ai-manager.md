---
sidebar_position: 9
---

# Project AI manager

A project space enables one project AI by default. It inspects the project board, creates Issues, assigns owners, tracks progress, and proposes adjustments. Issue assignees own execution, status progress, and delivery. The manager cannot delete Issues or change project settings or membership.

Click **Project AI** at the bottom of the board to expand the task composer. Interacting with any composer control pins the panel open until its close button is clicked. Messages use the task conversation renderer; linked Issues open their details, and the upper right button opens the full task. New projects enable project AI automatically when an eligible Agent is available. Local spaces prefer the current device Agent; cloud spaces require a project Agent backed by a Wegent Team. Configure the manager Agent, instructions, and on/off switch under **Project settings → Collaboration members → Project manager**, the last member tab. Local spaces continue to work offline.

## Triggers and conversation

Configure multiple manager triggers under **Project settings → Automatic processing**: Issue creation, tag addition, status changes, and Cron schedules. Members can start a conversation from the board entry. Owners and Maintainers can request Issue changes. Other members can query and discuss; the server rejects writes from their conversations.

Ordinary automation rules and manager triggers appear together under Automatic processing. Saving overlapping event triggers returns a conflict, and runtime selection starts only one rule for an event. Issues created by the manager do not trigger the manager again.

Manual conversations and event triggers both create ordinary task executions. Cloud runs are scheduled in the background while Wework is closed; local projects run on the local executor. Manager runs are serialized per project and show distinct waiting, running, completed, and failed states.

## Issue boundaries

The manager can read, search, create, comment on, edit, and assign Issues in its project. It creates an Issue without an assignee and assigns it separately. Ordinary changes to unassigned Issues can run immediately.

Changing an existing assignee requires approval from an Owner or Maintainer. Changing the scope of an active Issue or the status of a robot owned Issue creates a pending action. The human assignee confirms scope changes to their own Issue; an Owner or Maintainer confirms changes to robot owned Issues. Human assignees advance status through their own work actions, while the manager can leave a reminder. Approval checks the current Issue version, so stale proposals cannot apply.

Each run has its own history with executed and pending actions, linked Issues, status, and time. A read only query can complete without creating a false assignment or delivery.
