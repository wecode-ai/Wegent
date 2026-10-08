---
sidebar_position: 45
---

# Collaboration worktree verification plan

## Environment

Use isolated Electron, the real local Executor, and a Git repository created by the desktop runner. Only model responses are substituted. Project configuration, tasks, Git worktrees, and snapshots use their real implementations. Personal workspaces and global Git configuration are excluded.

Run `pnpm --filter wework e2e:desktop -- --segment collaboration-worktree-policy`. The checkpoint is registered in the desktop runner and Core CI shards and creates its own prerequisites.

## Cases

| Case             | Action                                             | Expected result                                                                |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Shared directory | Initialize, save shared policy, create task        | Persisted project policy; task does not use a worktree                         |
| Change policy    | Save isolated policy                               | Fingerprint and prepared devices unchanged                                     |
| Isolation        | Create another task                                | Actual worktree type, different directory, real .git                           |
| Continue         | Send follow-up                                     | Same task and directory, no extra task                                         |
| Agent dispatch   | Assign an Issue to a local Agent under each policy | Same policy as manual conversations; isolated tasks have different directories |
| Cancel reclaim   | Open confirmation and cancel                       | Directory and files remain                                                     |
| Reclaim          | Add untracked file and confirm                     | Directory removed; restore action visible                                      |
| Restore          | Restore snapshot                                   | Original path and untracked contents restored; no automatic execution          |

Unit tests additionally cover defaults, non-Git projects, shared-policy requests, persistence, the local queue and backend scheduling. Worktree preflight failure blocks execution instead of falling back to shared storage. Read task state through Issue bindings and runtime queries rather than relying on ordinary sidebar inclusion of prepared directories.

## Evidence and cleanup

Keep runner logs, failure snapshots and milestone captures under `wework/test-results/`; do not commit generated artifacts. The runner stops isolated processes on exit. Stop separately started ai:verify sessions explicitly. Record actual results and outstanding verification in the PR; the plan itself is not evidence of passing tests.
