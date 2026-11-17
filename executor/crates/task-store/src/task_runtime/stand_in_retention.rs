//! Seven-day history retention preserves live recovery and immutable event deduplication.
use super::stand_in_processing::write;
use super::*;

const CLEANUP_BATCH: usize = 1000;

#[cfg(test)]
#[path = "stand_in_retention_tests.rs"]
mod tests;

impl LocalTaskStore {
    pub fn prune_stand_in_history(
        &self,
        user: i64,
        at: chrono::DateTime<Utc>,
    ) -> Result<usize, TaskRuntimeError> {
        let mut guard = self.connection()?;
        let connection = guard.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let maintenance_id = format!("stand-in-retention:{user}");
        let previous = get_item_from(&connection, &maintenance_id, "stand_in_retention")?;
        if previous.is_some_and(|row| {
            row.metadata["nextCheckAt"]
                .as_i64()
                .is_some_and(|next| next > at.timestamp())
        }) {
            return Ok(0);
        }
        let cutoff = (at - chrono::Duration::days(7)).to_rfc3339();
        let state = get_item_from(
            &connection,
            &format!("stand-in-processing:{user}"),
            "stand_in_processing",
        )?
        .map(|row| row.metadata)
        .unwrap_or(Value::Null);
        // Keep the latest failed claim for each unresolved event. Older duplicate
        // failures are diagnostic history, not independent recovery operations.
        let actions = connection.execute(
            "WITH failed_claims AS (
               SELECT action.id, row_number() OVER (
                 PARTITION BY event.value ORDER BY action.created_at DESC,action.id DESC
               ) AS position
               FROM loop_items AS action, json_each(action.metadata,'$.arguments.eventIds') AS event
               JOIN loop_items AS intake ON intake.id=event.value AND intake.resource_type='stand_in_event'
               WHERE action.resource_type='stand_in_action'
                 AND json_extract(action.metadata,'$.userId')=?1
                 AND json_extract(action.metadata,'$.status')='failed'
                 AND json_extract(intake.metadata,'$.userId')=?1
                 AND json_extract(intake.metadata,'$.status')='pending'
             )
             DELETE FROM loop_items WHERE id IN (
               SELECT id FROM loop_items WHERE resource_type='stand_in_action'
                 AND json_extract(metadata,'$.userId')=?1
                 AND json_extract(metadata,'$.status') IN ('succeeded','failed','cancelled')
                 AND json_extract(metadata,'$.kind') != 'run_arrangement'
                 AND julianday(updated_at) < julianday(?2)
                 AND (?3 IS NULL OR json_extract(metadata,'$.batchId') IS NOT ?3)
                 AND id IS NOT ?4
                 AND id NOT IN (SELECT id FROM failed_claims WHERE position=1)
               ORDER BY updated_at,id LIMIT ?5
             )",
            params![user, cutoff, state["batchId"].as_str(), state["error"]["commandId"].as_str(), CLEANUP_BATCH],
        )?;
        // Settled event identities outlive payload retention: provider redelivery
        // must never resurrect an old message after its source checkpoint advances.
        let events = connection.execute(
            "WITH referenced_events AS MATERIALIZED (
               SELECT DISTINCT event.value FROM loop_items AS action,
                 json_each(action.metadata,'$.arguments.eventIds') AS event
               WHERE action.resource_type='stand_in_action'
                 AND json_extract(action.metadata,'$.userId')=?1 AND event.type='text'
             )
             UPDATE loop_items SET metadata=json_object(
               'id',id,'userId',?1,'status',json_extract(metadata,'$.status'),
               'createdAt',json_extract(metadata,'$.createdAt'),
               'roleScoped',json('true'),'compacted',json('true')
             ) WHERE id IN (
               SELECT intake.id FROM loop_items AS intake
               WHERE intake.resource_type='stand_in_event'
                 AND json_extract(intake.metadata,'$.userId')=?1
                 AND json_extract(intake.metadata,'$.status') IN ('handled','cancelled','migrated')
                 AND json_extract(intake.metadata,'$.compacted') IS NOT 1
                 AND julianday(intake.updated_at) < julianday(?2)
                 AND intake.id NOT IN (SELECT value FROM referenced_events)
                 AND NOT EXISTS (SELECT 1 FROM json_each(?3,'$.snapshot.events') WHERE json_extract(value,'$.id')=intake.id)
                 AND NOT EXISTS (SELECT 1 FROM json_each(?3,'$.routerSnapshot.intake') WHERE json_extract(value,'$.id')=intake.id)
               ORDER BY intake.updated_at,intake.id LIMIT ?4
             )",
            params![user, cutoff, state.to_string(), CLEANUP_BATCH],
        )?;
        let routes = connection.execute(
            "WITH retained_batches AS MATERIALIZED (
               SELECT DISTINCT json_extract(metadata,'$.batchId') AS batch FROM loop_items
               WHERE resource_type='stand_in_action' AND json_extract(metadata,'$.userId')=?1
                 AND json_extract(metadata,'$.batchId') IS NOT NULL
             )
             DELETE FROM loop_items WHERE id IN (
               SELECT receipt.id FROM loop_items AS receipt WHERE receipt.resource_type='stand_in_route'
                 AND json_extract(receipt.metadata,'$.userId')=?1
                 AND julianday(receipt.updated_at) < julianday(?2)
                 AND (?3 IS NULL OR json_extract(receipt.metadata,'$.result.snapshotId') IS NOT ?3)
                 AND (?4 IS NULL OR json_extract(receipt.metadata,'$.result.snapshotId') IS NOT ?4)
                 AND json_extract(receipt.metadata,'$.result.snapshotId') NOT IN (SELECT batch FROM retained_batches)
               ORDER BY receipt.updated_at,receipt.id LIMIT ?5
             )",
            params![user, cutoff, state["batchId"].as_str(), state["routerSnapshot"]["id"].as_str(), CLEANUP_BATCH],
        )?;
        let more = [actions, events, routes].contains(&CLEANUP_BATCH);
        write(
            &connection,
            "stand_in_retention",
            &json!({"id":maintenance_id,"userId":user,
            "nextCheckAt":if more {at.timestamp()} else {(at + chrono::Duration::days(1)).timestamp()}}),
        )?;
        connection.commit()?;
        Ok(actions + events + routes)
    }
}
