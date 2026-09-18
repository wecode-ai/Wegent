//! Task/subtask sharding: ID encoding, slot computation, and the brz-mysql
//! routing policy.
//!
//! Mirrors `wecode/task_sharding/task_id` and `wecode/task_sharding/shard`:
//! new-format IDs encode `uid | reserved | seq` (53-bit JS-safe integers);
//! `tasks_{slot:04}` / `subtasks_{slot:04}` physical tables are selected from
//! the slot derived from the ID (or owner user id).
//!
//! Consolidates the three former duplicate copies (`src/sharding.rs`,
//! `src/remote_workspace_tree/sharding.rs`,
//! `src/remote_workspace_status/mysql_deps.rs`) into one. The table-name
//! formatting functions are replaced by [`TaskRouting`] / [`wegent_backend_rs::task_routing::NoSharding`]
//! policies used with brz-mysql's `ShardedMysqlService` + `{{tasks}}`/
//! `{{subtasks}}` tokens.
use brz_mysql::{MysqlResult, MysqlRouteKey, MysqlRouteOutput, MysqlRouting};

/// 16 uid bits at the top of a new-format ID (shift 37).
pub const UID_SHIFT: u32 = 37;
/// 4 reserved bits (shift 33).
pub const RESERVED_SHIFT: u32 = 33;
/// 33 sequence bits.
pub const SEQ_MASK: u64 = (1_u64 << 33) - 1;
/// 16-bit uid mask.
pub const UID_MASK: u64 = (1_u64 << 16) - 1;
/// JS `Number.MAX_SAFE_INTEGER`.
pub const MAX_JS_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;
/// Minimum new-format ID (any id with a nonzero uid field).
pub const MIN_USER_SCOPED_ID: u64 = 1_u64 << UID_SHIFT;
/// Routing slot count (`SLOT_COUNT`, 1024).
pub const SLOT_COUNT: u32 = 1 << 10;
/// Whether an ID uses the new user-scoped encoding (`is_new_task_id`).
pub fn is_new_task_id(task_id: u64) -> bool {
    if !(MIN_USER_SCOPED_ID..=MAX_JS_SAFE_INTEGER).contains(&task_id) {
        return false;
    }
    let uid = task_id >> UID_SHIFT;
    let reserved = (task_id >> RESERVED_SHIFT) & 0xF;
    let sequence = task_id & SEQ_MASK;
    uid > 0 && reserved == 0 && sequence > 0
}

/// Extract the uid field from a new-format ID (`uid_from_id`).
pub fn uid_from_id(encoded_id: u64) -> u64 {
    (encoded_id >> UID_SHIFT) & UID_MASK
}

/// `WECODE_TASK_SHARD_COUNT` (power of two, 1..=1024) as configured in the
/// source image environment; the recorded physical table `tasks_0749`
/// (task 525154241368021, uid 3821, slot 3821 % 1024 = 749) proves the
/// deployment runs with 1024 shards, while the source code constant is 16
/// when the variable is absent.
pub fn shard_count_from_env() -> u32 {
    std::env::var("WECODE_TASK_SHARD_COUNT")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|count| *count > 0 && count.is_power_of_two() && *count <= 1024)
        .unwrap_or(16)
}

/// Physical shard index for a slot modulo shard count.
pub fn physical_shard_for_slot(slot: u32, shard_count: u32) -> u32 {
    slot % shard_count
}

/// Routing slot from a new-format ID (`_slot_from_new_id`).
pub(super) fn slot_from_new_id(encoded_id: u64) -> u32 {
    (uid_from_id(encoded_id) % u64::from(SLOT_COUNT)) as u32
}

/// Routing slot from an owner user id (`_slot_from_user_id`).
pub(super) fn slot_from_user_id(user_id: u64) -> u32 {
    (user_id % u64::from(SLOT_COUNT)) as u32
}

/// Resolve a `{{tasks}}`/`{{subtasks}}` template to its physical table name
/// for the given slot, or the base table when `slot` is `None` (legacy id /
/// user_id 0).
fn physical_table(template: &str, slot: Option<u32>, shard_count: u32) -> String {
    match slot {
        Some(slot) => format!(
            "{template}_{:04}",
            physical_shard_for_slot(slot, shard_count)
        ),
        None => template.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Routing keys
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

/// Internal sharding routing policy. Use with `mysql.with_route(TaskRouting)`.
/// SQL uses `{{tasks}}` / `{{subtasks}}` tokens; the caller binds the key via
/// `.route(wegent_backend_rs::task_routing::ByTaskId(id))` / `.route(wegent_backend_rs::task_routing::ByUserId(uid))` or passes it as the first
/// SQL argument.
pub struct TaskRouting;

impl MysqlRouting for TaskRouting {
    fn resolve<'a>(
        &'a self,
        template: &'a str,
        key: &'a dyn MysqlRouteKey,
    ) -> MysqlResult<impl MysqlRouteOutput + 'a> {
        let shard_count = shard_count_from_env();
        let slot = if let Some(wegent_backend_rs::task_routing::ByTaskId(id)) =
            key.downcast_ref::<wegent_backend_rs::task_routing::ByTaskId>()
        {
            if is_new_task_id(*id) {
                Some(slot_from_new_id(*id))
            } else {
                None // legacy task id -> base table
            }
        } else if let Some(wegent_backend_rs::task_routing::ByUserId(uid)) =
            key.downcast_ref::<wegent_backend_rs::task_routing::ByUserId>()
        {
            if *uid == 0 {
                None
            } else {
                Some(slot_from_user_id(*uid))
            }
        } else {
            None
        };
        Ok(physical_table(template, slot, shard_count))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_the_recorded_task_to_shard_0509() {
        // Recorded case: task 69956427469753 with uid 509 and shard count 1024.
        assert!(is_new_task_id(69_956_427_469_753));
        assert_eq!(uid_from_id(69_956_427_469_753), 509);
        assert_eq!(slot_from_new_id(69_956_427_469_753), 509);
    }

    #[test]
    fn legacy_task_ids_have_no_slot() {
        assert!(!is_new_task_id(42));
    }

    #[test]
    fn user_id_routes_to_the_same_slot_as_its_encoded_ids() {
        assert_eq!(slot_from_user_id(509), 509);
    }

    #[test]
    fn shard_count_folds_slots_into_physical_shards() {
        assert_eq!(physical_shard_for_slot(1, 16), 1);
        assert_eq!(physical_shard_for_slot(17, 16), 1);
    }

    #[test]
    fn rejects_malformed_new_ids() {
        // Reserved bits set or zero sequence -> not a new-format id.
        let reserved_set = (1_u64 << RESERVED_SHIFT) | (1_u64 << UID_SHIFT) | 1;
        assert!(!is_new_task_id(reserved_set));
        let zero_seq = 1_u64 << UID_SHIFT;
        assert!(!is_new_task_id(zero_seq));
    }

    #[test]
    fn physical_table_resolves_slot_and_base() {
        assert_eq!(physical_table("tasks", Some(509), 1024), "tasks_0509");
        assert_eq!(physical_table("subtasks", Some(509), 1024), "subtasks_0509");
        assert_eq!(physical_table("tasks", None, 1024), "tasks");
        assert_eq!(physical_table("subtasks", None, 1024), "subtasks");
    }

    #[test]
    fn task_routing_resolves_by_task_id() {
        let policy = TaskRouting;
        let key = wegent_backend_rs::task_routing::ByTaskId(69_956_427_469_753);
        let out = policy.resolve("tasks", &key).expect("resolve");
        let mut buf = String::new();
        out.write_to(&mut buf).expect("write");
        assert_eq!(buf, format!("tasks_{:04}", 509 % shard_count_from_env()));

        // Legacy task id -> base table.
        let legacy = wegent_backend_rs::task_routing::ByTaskId(42);
        let out = policy.resolve("tasks", &legacy).expect("resolve");
        let mut buf = String::new();
        out.write_to(&mut buf).expect("write");
        assert_eq!(buf, "tasks");
    }

    #[test]
    fn task_routing_resolves_by_user_id() {
        let policy = TaskRouting;
        let key = wegent_backend_rs::task_routing::ByUserId(509);
        let out = policy.resolve("tasks", &key).expect("resolve");
        let mut buf = String::new();
        out.write_to(&mut buf).expect("write");
        assert_eq!(buf, format!("tasks_{:04}", 509 % shard_count_from_env()));

        // user_id 0 -> base table.
        let zero = wegent_backend_rs::task_routing::ByUserId(0);
        let out = policy.resolve("subtasks", &zero).expect("resolve");
        let mut buf = String::new();
        out.write_to(&mut buf).expect("write");
        assert_eq!(buf, "subtasks");
    }

    #[tokio::test]
    async fn shared_pool_preserves_wecode_routing() {
        super::super::mysql_tests::assert_shared_pool(
            |mysql| mysql.with_route(TaskRouting),
            "SELECT id FROM `tasks_",
        )
        .await;
    }
}
