use super::*;

#[test]
fn corrected_conversation_evidence_stays_suppressed_after_restart_and_stale_replay() {
    for evidence in [
        json!({"taskId":"primary-chat","messageId":"user-statement-1"}),
        json!({"taskId":"role-chat","messageId":"user-statement-2"}),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.db");
        let store = LocalTaskStore::open(&path).unwrap();
        let mut original = json!({"scope":{"kind":"personal"},
            "content":"Birch release owner is Lin","evidence":evidence});
        original["evidence"]["excerpt"] = json!("Lin owns the Birch release");
        let saved = store
            .save_stand_in_memory(7, "mac", original.clone())
            .unwrap();
        let mut correction = saved.clone();
        correction["content"] = json!("Birch release owner is Zhou");
        correction["sourceTaskId"] = json!("correction-chat");
        correction["evidence"] = json!({"taskId":"correction-chat","messageId":"new-user-statement",
            "excerpt":"Zhou now owns the Birch release, not Lin"});
        let corrected = store.save_stand_in_memory(7, "mac", correction).unwrap();
        drop(store);
        let store = LocalTaskStore::open(&path).unwrap();

        assert!(matches!(
            store.save_stand_in_memory(7, "mac", saved),
            Err(TaskRuntimeError::VersionConflict)
        ));
        original["content"] = json!("Lin is responsible for Birch releases");
        // Replaying the same conversation statement must not revive its old meaning.
        assert!(matches!(
            store.save_stand_in_memory(7, "mac", original.clone()),
            Err(TaskRuntimeError::MemorySuppressed)
        ));
        assert_eq!(store.stand_in_memories(7).unwrap(), vec![corrected.clone()]);

        // A rejected stale update must not create suppression for the correction.
        assert_eq!(
            store
                .save_stand_in_memory(
                    7,
                    "mac",
                    json!({
            "scope":corrected["scope"],"content":corrected["content"],
            "evidence":corrected["evidence"]})
                )
                .unwrap(),
            corrected
        );
        assert!(store.save_stand_in_memory(8, "mac", original).is_ok());
        let connection = store.connection().unwrap();
        let mut statement = connection
            .prepare(
                "SELECT metadata FROM loop_items WHERE resource_type='stand_in_memory_tombstone'",
            )
            .unwrap();
        for metadata in statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
        {
            let metadata = metadata.unwrap();
            for removed_text in ["Birch", "Lin", "Zhou", "upload", "record"] {
                assert!(!metadata.contains(removed_text));
            }
        }
    }
}
