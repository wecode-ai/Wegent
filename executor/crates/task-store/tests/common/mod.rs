use serde_json::{json, Value};
use tempfile::TempDir;
use wegent_local_task_store::{ChatAgent, LocalTaskStore};

pub fn fixture() -> (TempDir, LocalTaskStore, String) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let group = store
        .chat_group_request("create", json!({"name":"Resource configuration"}))
        .unwrap();
    let id = group["group"]["id"].as_str().unwrap().to_owned();
    (directory, store, id)
}

pub fn agent(store: &LocalTaskStore, owner: &str) -> ChatAgent {
    store.create_chat_agent(owner, serde_json::from_value(json!({
        "name":"Configured Agent","execution_mode":"auto","execution_device_id":"local-device"
    })).unwrap()).unwrap()
}

pub fn update(
    store: &LocalTaskStore,
    owner: &str,
    configuration: Value,
) -> Result<Value, wegent_local_task_store::TaskRuntimeError> {
    let group = store
        .chat_group_request("get", json!({"group_id":owner}))
        .unwrap();
    store.chat_group_request(
        "update",
        json!({"group_id":owner,
            "name":group["group"]["name"],"status":"active","version":group["group"]["version"],
            "configuration":configuration
        }),
    )
}

pub fn crew(owner: &str, agent: &str) -> Value {
    json!({"id":"same-crew-id","owner_type":"workspace","owner_id":"original-definition-owner",
        "binding_owner_id":owner,"name":"Crew","leader":{"kind":"agent","id":agent},"members":[]})
}
