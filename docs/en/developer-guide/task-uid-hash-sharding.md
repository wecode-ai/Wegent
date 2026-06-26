---
sidebar_position: 29
---

# Task UID Hash Sharding

## Goal

Reduce growth pressure on the single `tasks` and `subtasks` tables, and remove the dependency on application server time for ID generation.

Goals:

- `task_id` is globally unique.
- `subtask_id` is globally unique.
- Multi-server uniqueness does not depend on local server clocks.
- A user's own task list does not scan multiple task tables.
- Existing `tasks` and `subtasks` data remains readable through legacy fallback.

## Design

Use a centralized allocator that embeds UID routing information into `task_id` and `subtask_id`. Store task and subtask rows in hash-sharded tables by owner UID. Callers depend only on function interfaces so the allocator can later be replaced without changing task/subtask store callers.

```text
tasks_0000 ... tasks_1023
subtasks_0000 ... subtasks_1023

tasks      # legacy, old data only
subtasks   # legacy, old data only
```

Shard rule:

```text
task table = tasks_{owner_user_id % shard_count}
subtask table = subtasks_{owner_user_id % shard_count}
```

Subtasks follow the task owner's shard, not the sender's UID.

## Tables

### ID Allocator Interface and ID Format

The allocator is exposed as functions, so business code does not directly depend on a concrete ID service.

```text
allocate_task_id(user_id) -> int
allocate_subtask_id(user_id) -> int
```

Current implementation:

```text
task_id = UserScopedIdFactory.next_id(owner_user_id)
subtask_id = UserScopedIdFactory.next_id(owner_user_id)

53-bit ID = 16-bit uid + 4-bit reserved + 33-bit seq
```

Constraints:

- `user_id` must fit in the 16-bit uid field. Out-of-range values fail instead of being masked.
- Each uid uses an independent Redis sequence key: `wecode_task_global_seq_{uid}`.
- New uid keys default to `150000`, so the first allocated sequence is `150001`; override it with `WECODE_TASK_SEQ_INITIAL_SEQUENCE`.
- Within one uid, the incrementing sequence owns uniqueness. The high UID bits carry routing information.
- Within one uid, `task_id` and `subtask_id` share one sequence key so their ID spaces cannot collide.
- Business code only calls `allocate_task_id()` and `allocate_subtask_id()`.
- Replacing the allocator later must not require changes to task/subtask store callers.
- New data does not maintain `task_uid_index` / `subtask_uid_index` route tables.

### tasks_xxxx

Same logical schema as the current `tasks` table. New tasks are written to `tasks_{owner_user_id % shard_count}`.

### subtasks_xxxx

Same logical schema as the current `subtasks` table. New subtasks are written to the task owner's `subtasks_xxxx`.

## Write Flow

### Create Task

```text
1. Call `allocate_task_id(owner_user_id)` to get a globally unique task_id.
2. Compute the tasks_xxxx table from owner_user_id.
3. Insert into tasks_xxxx.
```

### Create Subtask

```text
1. Decode owner UID from task_id.
2. Call `allocate_subtask_id(owner_user_id)` to get a globally unique subtask_id.
3. Compute the subtasks_xxxx table from owner_user_id and insert into it.
```

## Read Flow

### Task Detail

```text
task_id
-> decode owner UID from ID
-> tasks_{owner_user_id % shard_count}
```

If the route row is missing, fall back to legacy `tasks`.

### User Task List

```text
user_id
-> tasks_{user_id % shard_count}
-> where user_id = ?
-> order by updated_at desc
```

The owner task list does not need a separate `task_index`.

### Message List

```text
task_id
-> decode owner UID from ID
-> subtasks_{owner_user_id % shard_count}
-> where task_id = ?
```

If the route row is missing, fall back to legacy `subtasks`.

### Subtask Lookup

```text
subtask_id
-> decode owner UID from ID
-> subtasks_{owner_user_id % shard_count}
```

If the route row is missing, fall back to legacy `subtasks`.

## Group Chat and Shared Tasks

Opening a group chat by `task_id` is unchanged:

```text
task_id -> decode owner UID from ID -> tasks_xxxx / subtasks_xxxx
```

Permissions continue to use the existing membership table, such as `resource_members`.

For a user's joined group chat list, the initial implementation can use the membership table as the entry point:

```text
resource_members where entity_id = current_user_id and resource_type = 'Task'
-> task_id list
-> batch decode owner UID
-> batch read tasks_xxxx
```

If this list becomes large and requires precise pagination by recent activity, add a member-facing index table later.

## Legacy Compatibility

Keep existing `tasks` and `subtasks` as legacy tables.

```text
New data: tasks_xxxx / subtasks_xxxx
Old data: tasks / subtasks
```

Routing rule:

```text
ID decodes to owner UID -> sharded table
ID does not match the new format -> legacy table
```

The first release does not need to move historical data.

## Benefits

- Globally unique task and subtask IDs.
- Multi-server uniqueness is guaranteed by the UUID factory, not by local application server clock consistency.
- The allocator is wrapped behind functions and can be replaced later.
- User task list is routed directly by UID hash.
- Task and subtask point lookups can decode their route from the ID.
- No separate `task_index` or `subtask_index` list tables are required.
- No separate `task_uid_index` or `subtask_uid_index` ID route tables are required.
- Historical data remains readable.

## Risks and Constraints

- A very large user can become a single-shard hotspot.
- Monthly archive and cold-data management are less direct than monthly partitioning.
- ID-only reads depend on the UID routing bits embedded in IDs.
- Joined group chat lists initially rely on `resource_members` plus batch ID decoding; large-scale usage may need a member index later.

## Rollout Order

1. Add migrations for hash-sharded tables.
2. Connect UserScoped ID based `allocate_task_id(user_id)` / `allocate_subtask_id(user_id)` and shard routers.
3. Refactor `task_store` to write new tasks to hash shards and read through route plus legacy fallback.
4. Refactor `subtask_store` to write new subtasks to hash shards and read through route plus legacy fallback.
5. Add tests for task creation, task detail, task lists, message lists, and subtask lookup.
6. Enable new writes gradually and verify legacy reads remain stable.
