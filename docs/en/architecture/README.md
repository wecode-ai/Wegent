---
sidebar_position: 1
---

# Architecture-governed logic

Before changing a flow below, update its connection graph, sequence diagram, code ownership, and essential invariants, confirm that the path is complete, and only then change code. Keep one independently maintained file per topic; add one file and one catalog row for a new governed flow.

| Logic                                              | Architecture file                                                            | Change scope                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Board automation and Wegent execution              | [board-automation.md](board-automation.md)                                   | Assignment, execution truth, runtime activation, continuation, cancellation, terminal projection              |
| Custom AI manager comment continuation             | [automation-manager-continuation.md](automation-manager-continuation.md)     | Comment identity, execution binding, runtime-session continuation, task-state isolation                       |
| Embedded-browser navigation and tabs               | [embedded-browser.md](embedded-browser.md)                                   | Bridge routing, pending open, WebView lifecycle, navigation completion, multi-tab E2E                         |
| Issue, task, and workflow orchestration            | [issue-task-workflow.md](issue-task-workflow.md)                             | Issue aggregation, task binding, workspace inheritance, DAG readiness, status aggregation                     |
| Issue Runtime status, delivery, and UI projection  | [issue-runtime-delivery-projection.md](issue-runtime-delivery-projection.md) | Runtime terminal persistence, stage aggregation, Delivery fulfillment, invalidation, Issue-detail consistency |
| Workflow stage deliverables and dependency context | [workflow-stage-deliverables.md](workflow-stage-deliverables.md)             | Structured requirements, manual and automated gates, code evidence, successor input snapshots                 |
| Workflow stage execution routing                   | [workflow-stage-execution-routing.md](workflow-stage-execution-routing.md)   | Human start, cloud dispatch, local/cloud device routing, unified stage execution contract                     |
| Project-space Agent capability                     | [project-space-agent-capability.md](project-space-agent-capability.md)       | Local Gateway, ContextGrant, Codex Plugin, offline provider, MCP lifecycle                                    |
| Project execution state and Runtime capacity       | [project-execution-state.md](project-execution-state.md)                     | Claim, event ordering, cancellation, retry, lease, concurrency capacity, UI projection                        |
| Git Worktree execution                             | [git-worktree-execution.md](git-worktree-execution.md)                       | Device routing, capability, preflight, queued creation, lifecycle, persistence, UI projection                 |
| Text-model vision delegation                       | [model-vision-delegation.md](model-vision-delegation.md)                     | Explicit model reference, catalog capability, sidecar configuration, image replacement, failure isolation     |
| Wework host plugin runtime                         | [workbench-plugin-runtime.md](workbench-plugin-runtime.md)                   | Profile composition, services and UI slots, dynamic modules, sidecars, teardown, and recovery                 |
| Smart apps (DeepSeek Harness runtime)              | [deepseek-harness-apps.md](deepseek-harness-apps.md)                         | Application-type navigation, package validation, version binding, model proxying, instances, tabs, and cleanup |
| IM private-chat runtime streaming                  | [im-runtime-streaming.md](im-runtime-streaming.md)                           | Callback key, `runtime:event` envelope, relay and IM forwarding, terminal event, failure isolation            |
| Codex notification isolation                       | [codex-notification-routing.md](codex-notification-routing.md)               | Shared app-server, thread routing, burst isolation, process exit, terminal projection                         |

Detailed product prose remains in the existing developer guides. This directory contains only reviewable architecture truth.
