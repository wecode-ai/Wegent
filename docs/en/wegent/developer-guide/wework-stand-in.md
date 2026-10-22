---
sidebar_position: 42
---

# Wework Stand-in

Stand-in is a personal configuration, accessible from the collaboration navigation and project toolbar. The project entry opens the same settings focused on the current project. One role is the default; Add role is always available, while role switching and shared scheduling appear only with multiple roles.

The main screen shows the execution agent, optional handling instructions, work sources, automatic assignment handling, and collapsed execution settings. Choose a general assistant, personal agent, or project agent. Choosing a project agent automatically connects its owning project and restricts the role to that project; personal agents can cover multiple projects. Instructions reuse the normal composer, skills, plugins and Goal mode. Personal settings can be saved without cloud catalogs, project device bindings or model readiness; dispatch validates the current actor, Issue permission and the agent's device and model policies.

Every edit, including the automatic handling toggle, takes effect only after Save. Failed saves retain the draft; version conflicts cannot overwrite another editor. Closing a dirty configuration requires explicit discard. Back from a secondary page discards that page's edits. Disabling stops new assignments while existing Runtime tasks continue.

A role can cover all participating collaboration projects, including future projects, with individual exclusions, or a selected project list. Optional tags narrow its scope. Settings are account-scoped in the selected Executor's SQLite database; devices remain independent. Local projects are displayed only on their owning device.

One personal document owns role configuration, ordering, versions and the shared automatic-selection option. Legacy project configurations migrate transactionally into roles preserving project scopes, assignment cutoffs and original project-agent authority. Project-addressed RPCs are projections over this document, with no duplicate project persistence.

## Role selection

Scope and exact tag matching are deterministic. Tagged matches take precedence over unrestricted roles. A single matching role executes directly. Multiple matches use the first role in the shared scheduling order by default, with exactly one execution per assignment.

The shared checkbox enables model selection only when several roles match. Selection consumes tokens; polling, deduplication and rule matching do not. A restricted ephemeral request without tools returns one allowed role ID and a reason. Decisions are cached by assignment and configuration version, including failures, to avoid repeated model calls. Selection failures appear in personal settings and can be retried after adjusting settings or clicking Retry.

The Executor filters historical, unrelated, unassigned and already-bound work before selection, then reuses ordinary task creation, binding, sessions and result views. Manual delegation works with automatic handling disabled and uses the same selection policy when no role is specified. Execution provenance records the selected role and reason. Cloud execution retains current Issue permission checks; local work remains functional offline. No new backend queue or distributed lock is introduced.

## Feedback in collaboration notifications

Collaboration notifications read the existing Runtime execution list and match stand-in tasks by project, Issue, and assignment identity. The original assignment notification shows the mask icon and working, waiting, finished, or failed state. Local and manually started stand-ins without an assignment notification also appear here. Clicking the task title opens the existing execution conversation without dispatching another task.

Notifications show the source, event and time, task content, and lightweight actions without an extra “New task” heading. New notifications snapshot the actual assigning user or manager agent name at creation; inbox reads do not query related records. Entries without a name omit assigner information and show the task title and time directly, without placeholder copy. Stand-in handling updates the identity and state in the same entry.

The inline handling area accepts follow-up instructions, answers real Runtime questions, and retries failed stand-in tasks. Ordinary follow-up input expands after clicking Reply; pending questions appear directly. Replies continue the same conversation. A rejected send keeps the draft and displays the error. Question options and request identifiers come from the conversation, never from interpreting result text.

Completion, failure, and pending input make the entry unread again and update its position. Desktop alerts respect collaboration notification preferences and are suppressed while that execution is visible. The desktop frontend owns this projection; no backend API or Executor protocol is added.

Stand-in read markers and desktop delivery receipts are account-scoped on the current device and do not sync between devices. Original assignment notifications retain the existing read API. Each auxiliary collection retains at most 1000 entries for 90 days and is pruned on reads and writes. Cleanup never deletes real notifications, tasks, or execution history.

Focused tests cover durable versioned settings, independent tag rules, assignment age, existing binding filtering, device switching, and sidebar configuration merging and updates. The `stand-in`, `stand-in-workspace`, `stand-in-cloud`, `stand-in-controls`, and `stand-in-notifications` desktop checkpoints run in existing CI. Only model responses are replaced; storage, task execution, cloud APIs, and device connections use real implementations.

## Verification

Use isolated Electron, project and Executor fixtures; cloud checkpoints use real backend APIs and connections. Only model responses are substituted. Keep screenshot evidence outside the repository and record actual results in the PR.

Cover the single-role default, project entry, draft cancellation, save conflicts and recovery, all-project connection with exclusions and future projects, adding roles, deterministic overlap selection, opt-in model selection, zero selection calls for a single match, assignment filtering, deduplication and legacy migration without expanding authority.
