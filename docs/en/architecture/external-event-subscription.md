---
sidebar_position: 31
---

# External event subscription and wait nodes

Scope: wait-node state machine, event-rule matching, external reference registration, GitLab event ingestion, wait rounds, and compensation.

```mermaid
flowchart LR
    DEFINITION[Workflow definition<br/>wait node + event rules] --> PROJECTION[Projection<br/>wait activates to waiting]
    PROJECTION --> RUN[Automation execution]
    RUN --> REGISTER[register_external_reference<br/>provider + opaque_ref + run_id]
    REGISTER --> BINDING[EventBinding]
    BINDING -->|compensate on register| EVALUATE[Rule evaluation]
    ADAPTER[Provider adapter<br/>GitLab webhook] --> BUFFER[Event buffer]
    BUFFER --> EVALUATE
    EVALUATE -->|trigger / debounce| ACTION{Action}
    ACTION -->|complete| DONE[Wait completed]
    ACTION -->|rerun| ROUND[wait_round + 1<br/>stage rerun]
    DONE --> RELEASE[releaseReadyNodes<br/>advance downstream stages]
```

```mermaid
sequenceDiagram
    participant U as User
    participant E as Wework editor
    participant B as Backend services
    participant R as Robot runtime
    participant P as Provider (GitLab)

    U->>E: Configure wait node with event rules (trigger/debounce, complete/rerun)
    E->>B: Save workflow definition
    B->>B: Validate wait nodes carry rules and no automation binding
    B->>R: Run upstream stage
    R->>B: register_external_reference(provider, opaque_ref, run_id)
    B->>B: Validate automation run and ready/waiting wait node
    B->>B: Create EventBinding and set wait status to waiting
    B->>B: Compensate: evaluate immediately if the event already arrived
    P->>B: Event arrives (GitLab webhook)
    B->>B: Match rules against bindings and evaluate
    alt complete
        B->>B: Complete the wait node and release downstream stages
    else rerun
        B->>B: Increment wait_round and reactivate the stage execution
    end
```

| Edge | Code ownership |
| --- | --- |
| Wait-node and event-rule definition | Issue workflow schema, Wework workflow editor |
| Registration and binding | `external_events/registration.py`, `binding.py`, `wework-space` MCP, Executor `mcp.rs` |
| Provider event ingestion | `external_events/adapters.py`, `project_incoming_hooks.py` |
| Buffering and rule evaluation | `external_events/buffer.py`, `evaluate.py` |
| Wait projection and advancement | `project_workflow_projection.py`, `issueWorkflow.ts` |

Essential invariants:

- A wait node must define at least one rule with a non-empty event type and must not bind an automation rule; the start node cannot depend on others, and the end node cannot be depended on.
- Only an automation execution of a preset workflow with a `ready`/`waiting` wait node may register external references; registration is scoped by `automation_run_id`.
- The (provider, opaque_ref, workflow node + automation run) binding triple is unique; repeated registration is idempotent and never advances twice.
- Only event types matching a bound rule change wait state; unmatched events are recorded but never advance or rerun.
- `trigger` evaluates immediately on arrival; `debounce` aggregates within its window first.
- `complete` finishes the wait node and releases downstream stages; `rerun` increments `wait_round` and reruns only that stage.
- Registration compensates immediately when the event already arrived, so no waiting window is missed.
- start/end are structural DAG boundaries that never execute; deletion and rewiring must preserve the boundaries.
