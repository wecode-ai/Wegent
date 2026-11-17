use super::*;

impl RuntimeWorkStore {
    /// Adopt an authorized native conversation before mutating it, without replacing newer state.
    pub fn materialize_discovered_task(
        &self,
        link: RuntimeTaskLink,
    ) -> io::Result<Option<RuntimeTaskLink>> {
        let mut current = None;
        self.change_issue_index(|index| {
            if index
                .deleted_archived_task_ids
                .contains_key(&link.local_task_id)
            {
                return Ok(false);
            }
            let inserted = !index.tasks.contains_key(&link.local_task_id);
            current = Some(
                index
                    .tasks
                    .entry(link.local_task_id.clone())
                    .or_insert(link)
                    .clone(),
            );
            Ok(inserted)
        })?;
        Ok(current)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn materialization_keeps_current_state_and_never_resurrects_a_deleted_conversation() {
        let root = tempfile::tempdir().unwrap();
        let store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        let link = RuntimeTaskLink::new_pending(
            "native-thread".into(),
            "/workspace".into(),
            "Native".into(),
        );
        assert!(store
            .materialize_discovered_task(link.clone())
            .unwrap()
            .is_some());
        store.update_task("native-thread", |task| task.status = "done".into());
        assert_eq!(
            store
                .materialize_discovered_task(link.clone())
                .unwrap()
                .unwrap()
                .status,
            "done"
        );
        store
            .mark_deleted_archived_task_ids([link.local_task_id.clone()])
            .unwrap();
        assert!(store.materialize_discovered_task(link).unwrap().is_none());
    }
}
