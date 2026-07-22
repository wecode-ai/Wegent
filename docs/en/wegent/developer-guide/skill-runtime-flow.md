---
sidebar_position: 11
---

# Skill Runtime Flow

This document explains how Wegent selects, resolves, propagates, and consumes skills across execution scenarios. The focus is on why skill resolution must stay centralized in backend, and why sandbox / local-device startup cannot rely on skill names alone.

## Two Layers Of Meaning

Skill data in Wegent has two distinct layers:

| Layer | Representative fields | Meaning |
| --- | --- | --- |
| Requested selection | `Ghost.spec.skills`, `Ghost.spec.preload_skills`, `Task.additional_skills`, `Subscription.spec.skillRefs` | Which skills a source asked this task to carry |
| Resolved references | `ExecutionRequest.skill_refs`, `ExecutionRequest.preload_skill_refs`, `GET /tasks/{id}/skills` response `skill_refs` / `preload_skill_refs` | The final skill identity resolved by backend against current visibility and namespace rules |

Names alone are not sufficient because the same skill name may exist in:

- a user's private `default` namespace
- a team namespace
- the public skill space

At runtime, skill deployment must therefore prefer the exact tuple:

- `skill_id`
- `namespace`
- `is_public`

## Unified Rules

The current runtime boundary is:

1. backend is the only skill resolver
2. executor, sandbox, and local-device flows only consume resolved refs
3. `skills` / `preload_skills` remain for backward compatibility
4. new consumers should prefer `skill_refs` / `preload_skill_refs`

This boundary matters. If each execution surface implements its own same-name resolution policy, behavior will drift and become unmaintainable.

## Core Fields

### Ghost

Ghost is the static skill source:

- `spec.skills`
- `spec.preload_skills`
- `spec.skill_refs`
- `spec.preload_skill_refs`

`skill_refs` and `preload_skill_refs` are written when the Bot/Ghost is created or updated and already represent exact skill identities.

### Chat / Chat Shell

When a user explicitly selects skills for a single message, the entry field is:

- `payload.additional_skills`

Those selections are merged with request-time `preload_skills` in `build_execution_request()`, then resolved by `TaskRequestBuilder` into:

- `ExecutionRequest.skill_names`
- `ExecutionRequest.preload_skills`
- `ExecutionRequest.user_selected_skills`
- `ExecutionRequest.skill_refs`
- `ExecutionRequest.preload_skill_refs`

Within that result:

- `user_selected_skills` is for prompt emphasis
- `skill_refs` / `preload_skill_refs` are for precise deployment

### Task Persistence

For compatibility, task-level persistence still uses the historical field:

- `Task.metadata.labels.additionalSkills`
- `Task.metadata.labels.requestedSkillRefs`

Specifically:

- `additionalSkills` is the legacy name-only list
- `requestedSkillRefs` is the new raw selection payload with `name/namespace/is_public`

Neither field stores derived `skill_id` values. That is intentional: `skill_id` is runtime-resolved state and can become stale if persisted.

### Subscription

Subscription-scoped explicit skills come from:

- `Subscription.spec.skillRefs`

They are not copied into task labels. During task-level lookup, backend reconstructs them through:

`Task -> BackgroundExecution(task_id) -> Subscription(subscription_id)`

and resolves them again into current skill refs.

This avoids caching derived execution state into Task metadata.

## Scenario Flows

### 1. Regular Chat / Chat Shell

Flow:

1. Ghost provides default skills and refs
2. message-level `additional_skills` are merged into request-time `preload_skills`
3. `TaskRequestBuilder` resolves everything into `ExecutionRequest.*refs`
4. execution surfaces use those refs to download skills precisely

This path also drives skill prompt emphasis because `user_selected_skills` is produced here.

### 2. Subscription Execution

Flow:

1. `Subscription.spec.skillRefs` becomes request-time explicit skill input
2. `build_execution_request()` calls `TaskRequestBuilder`
3. backend emits `ExecutionRequest.skill_refs` / `preload_skill_refs`
4. the first execution can use request refs directly

If a later sandbox restart or delayed initialization only has `task_id`, it cannot assume the original request is still present. That is why the task-skills API must reproduce the same resolved refs.

### 3. Sandbox / Local Device Startup

These flows do not reuse the original `ExecutionRequest`. Instead they call:

- `GET /tasks/{task_id}/skills`

That endpoint now dynamically combines:

- Ghost default skills
- Ghost stored refs
- task-label `additionalSkills`
- subscription `spec.skillRefs`

and returns:

- `skills`
- `preload_skills`
- `skill_refs`
- `preload_skill_refs`

This lets sandbox / local-device startup recover the same precise skill identities even when they only know `task_id`.

## Prompting Versus Deployment

The subtle but important split in this bug is between skill prompting and skill deployment.

### Skill Prompting

Skill prompting uses:

- `ExecutionRequest.user_selected_skills`

Claude Code's `build_skill_emphasis_prompt()` consumes that field to emphasize explicitly selected skills.

### Skill Deployment

Skill deployment uses:

- `skill_refs`
- `preload_skill_refs`

Without refs, the runtime falls back to name-based lookup. That is unreliable for same-name, multi-namespace, and subscription-bound skills.

So:

- returning refs from `/tasks/{id}/skills` does not change skill prompting behavior
- it fixes precise deployment for sandbox and local-device startup

## Compatibility

The current implementation keeps these compatibility guarantees:

1. `/tasks/{id}/skills` still returns `skills` / `preload_skills`
2. historical tasks that only store `additionalSkills` names are resolved on read
3. new tasks also store `requestedSkillRefs`, so normal chat tasks preserve namespace/public selection for sandbox and local-device startup
4. historical Ghosts without stored `skill_refs` are backfilled by backend lookup rules

Old tasks, old Ghosts, and older consumers therefore continue to work; newer consumers should simply prefer refs when available.

## Maintenance Guidance

When introducing any new skill source, follow these rules:

1. persist only the original selection, never derived `skill_id`
2. route all precise runtime resolution through backend, then let execution surfaces consume the result passively

If those boundaries hold, Chat, Subscription, Sandbox, and local-device behavior will remain aligned.
