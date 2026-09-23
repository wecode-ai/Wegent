---
sidebar_position: 9
---

# Project AI manager

A project space can enable one AI manager. It inspects the project board, creates Issues, assigns owners, tracks progress, and proposes adjustments. Issue assignees own execution, status progress, and delivery. The manager cannot delete Issues or change project settings or membership.

Open **Project settings → Project AI manager** to choose an Agent, write instructions, and enable it. Cloud spaces require a project Agent backed by a Wegent Team. Local spaces use a local project Agent and continue to work offline.

## Triggers and conversation

The manager can have multiple triggers: Issue creation, tag addition, status changes, and Cron schedules. Members can also start a conversation on the manager page. Owners and Maintainers can request Issue changes. Other members can query and discuss; the server rejects writes from their conversations.

Automatic processing remains a separate feature. Saving overlapping event triggers returns a conflict, and runtime selection allows only one manager for the same event. Issues created by the manager do not trigger the manager again.

## Issue boundaries

The manager can read, search, create, comment on, edit, and assign Issues in its project. It creates an Issue without an assignee and assigns it separately. Ordinary changes to unassigned Issues can run immediately.

Changing an existing assignee requires approval from an Owner or Maintainer. Changing the scope of an active Issue or the status of a robot owned Issue creates a pending action. The human assignee confirms scope changes to their own Issue; an Owner or Maintainer confirms changes to robot owned Issues. Human assignees advance status through their own work actions, while the manager can leave a reminder. Approval checks the current Issue version, so stale proposals cannot apply.

Each run has its own history with executed and pending actions, linked Issues, status, and time. A read only query can complete without creating a false assignment or delivery.
