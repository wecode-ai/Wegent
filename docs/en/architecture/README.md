---
sidebar_position: 1
---

# Architecture-governed logic

Before changing a flow below, update its connection graph, sequence diagram, code ownership, and essential invariants, confirm that the path is complete, and only then change code. Keep one independently maintained file per topic; add one file and one catalog row for a new governed flow.

| Logic                                        | Architecture file                                        | Change scope                                                                                     |
| -------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Board automation and Wegent execution        | [board-automation.md](board-automation.md)               | Assignment, execution truth, runtime activation, continuation, cancellation, terminal projection |
| Custom AI manager comment continuation       | [automation-manager-continuation.md](automation-manager-continuation.md) | Comment identity, execution binding, runtime-session continuation, task-state isolation |
| Embedded-browser navigation and tabs         | [embedded-browser.md](embedded-browser.md)               | Bridge routing, pending open, WebView lifecycle, navigation completion, multi-tab E2E            |
| Issue, task, and workflow orchestration       | [issue-task-workflow.md](issue-task-workflow.md)         | Issue aggregation, task binding, workspace inheritance, DAG readiness, status aggregation         |
| Issue Runtime status, delivery, and UI projection | [issue-runtime-delivery-projection.md](issue-runtime-delivery-projection.md) | Runtime terminal persistence, stage aggregation, Delivery fulfillment, invalidation, Issue-detail consistency |
| Workflow stage deliverables and dependency context | [workflow-stage-deliverables.md](workflow-stage-deliverables.md) | Structured requirements, manual and automated gates, code evidence, successor input snapshots |
| Project-space Agent capability               | [project-space-agent-capability.md](project-space-agent-capability.md) | Local Gateway, ContextGrant, Codex Plugin, offline provider, MCP lifecycle                         |
| Project execution state and Runtime capacity | [project-execution-state.md](project-execution-state.md) | Claim, event ordering, cancellation, retry, lease, concurrency capacity, UI projection           |
| Git Worktree execution                       | [git-worktree-execution.md](git-worktree-execution.md)   | Device routing, capability, preflight, queued creation, lifecycle, persistence, UI projection    |

Detailed product prose remains in the existing developer guides. This directory contains only reviewable architecture truth.
