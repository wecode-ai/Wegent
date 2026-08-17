---
sidebar_position: 3
---

# GitLab MR Fix-Task Integration

The GitLab MR integration turns Merge Request review feedback (CI failures,
review comments) into **fix-task cards** on the project-space board, closing the
loop from review to fix to re-submit to merge.

## Overview

- Whenever an MR has feedback (a failed CI pipeline or a new review comment),
  the board gets a card carrying the fix context for whoever will act on it
  (human or AI): the MR link, source branch, review comments, CI failure
  summary, and iteration history.
- The card lifecycle follows the MR automatically; no manual upkeep.

## Enabling

1. In the project space "Task source", choose GitLab and fill in the repository
   URL and an access token (needs `api` scope; `write_repository` is also
   recommended).
2. Toggle "Integrate this repository's MRs". Checking it during project
   creation enables the integration automatically; you can also toggle it from
   the project manage page at any time.
3. The backend installs a project Webhook on the GitLab repository (events:
   merge_request / note / pipeline).

> The token stays on the backend and is only used to call the GitLab API; it is
> never handed to the executing AI.

## Card lifecycle

| Stage | Card status | Trigger |
|---|---|---|
| MR has feedback (CI fail / review comment) | Inbox (unassigned) | auto-created |
| Assigned to AI / person | In progress | on assignment |
| Fix pushed (new commit) | In review | on push |
| New comment / CI fails again | In progress | on new feedback |
| MR merged / closed | Completed | automatic |

Rules:

- Only comments **new to the current round** keep a card in "in progress";
  comments from earlier rounds are treated as addressed.
- CI green with no new comments → the card moves to "in review" for
  confirmation.
- Repeated failures of the same MR **accumulate on one card** (history tracks
  each round; comment counts show "new in this round").

## Card content

The card description starts with a **task instruction** that varies by state:

- In progress: tells the fixer "CI failed / review comments exist; fix and push
  to the source branch".
- CI green but new comments this round: explicitly notes "CI passed, but new
  review comments need addressing".
- In review / completed: says no further change is needed / the MR was merged.

Below it sit the data: review comments (all), current-round CI (failed jobs +
log tail), and history (one-line summaries of recent rounds).

## Project automation assignment (optional)

An MR fix card is a standard board task: **creating one fires the project
automation `task.created` event**, so a project automation rule can decide who
handles it instead of only the hard-coded "collect inbox + MR author" flow.

Configure a rule on the project manage page with `event_config`
`sources: ["gitlab"]` and `tags: ["mr-fix"]` to match MR fix cards exactly:

- **Manual assignment**: the rule names a project robot; new MR fix cards are
  dispatched to it automatically.
- **AI-managed assignment**: a custom WeWork AI or Wegent team acts as the
  dispatcher, reading project/task/member capabilities and assigning the card to
  the best person or robot.

With no matching rule, the card keeps the default behavior: it lands in the
inbox assigned to the MR author.

## AI execution

- Once a card is assigned to a project robot, each actionable round (CI failure
  or a new comment) **auto-re-triggers a fresh run** (a new run reads the
  latest card).
- Auto re-triggers are capped by the project's
  `ai_automation.max_retry_count` (default 10; set 0 to disable); past the cap
  the card stays "in progress" for a human.
- A running robot reads the card via `get_board_item` (including the task
  instruction); pushing a fix re-runs CI automatically.

## Disabling

Turn off "MR integration" on the project manage page: the GitLab Webhook and
integration data are removed; existing cards stay on the board.

## Notes

- The Webhook callback URL is derived from the backend's public URL (in an
  intranet deployment, make sure GitLab can reach it).
- A robot cannot yet push a fix back to the MR branch (the executor has no
  clone/credentials provisioning for these cards); "re-submit" is currently
  done by a human.
