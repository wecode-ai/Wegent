use super::*;
use axum::{extract::State, routing::post, Json, Router};
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn memory_connection_checkpoints_isolate_accounts_resources_queries_and_cursors() {
    let source = json!({"providerId":"docs","profile":"account","kind":"document","id":"one",
        "collectionKey":"team", "boundary":{"cursor":"authorized-start"}});
    let args = json!({"query":{"limit":10,"filter":"mine"},"cursor":"page-1"});
    let key = connection_page_key(&source, &args);
    for field in [
        "providerId",
        "profile",
        "kind",
        "id",
        "collectionKey",
        "boundary",
    ] {
        let mut other = source.clone();
        other[field] = json!("different");
        assert_ne!(key, connection_page_key(&other, &args), "{field}");
    }
    for other in [
        json!({}),
        json!({"query":{"limit":10,"filter":"theirs"},"cursor":"page-1"}),
        json!({"query":args["query"],"cursor":"page-2"}),
    ] {
        assert_ne!(key, connection_page_key(&source, &other));
    }
    let mut reordered: Value =
        serde_json::from_str(r#"{"cursor":"page-1","query":{"filter":"mine","limit":10}}"#)
            .unwrap();
    reordered["source"] = json!({"name":"Forged caller label"});
    reordered["offset"] = json!(8192);
    reordered["contentHash"] = json!("chunk-hash");
    assert_eq!(key, connection_page_key(&source, &reordered));
}

#[derive(Clone)]
struct Provider {
    store: LocalTaskStore,
    revoke: Arc<AtomicBool>,
    calls: Arc<Mutex<Vec<Value>>>,
}

async fn provider(State(state): State<Provider>, Json(request): Json<Value>) -> Json<Value> {
    state.calls.lock().unwrap().push(request.clone());
    assert_eq!(request["providerId"], "docs");
    if state.revoke.load(Ordering::SeqCst) {
        let mut settings = state.store.personal_stand_in(7, "mac").unwrap();
        settings["primary"]["connections"] = json!([]);
        state
            .store
            .save_personal_stand_in(7, "mac", settings)
            .unwrap();
    }
    let result = if request["method"] == "listResources" {
        assert!(request["input"].get("scope").is_none());
        assert_eq!(request["input"]["kind"], "document");
        if request["input"]["query"] == "large-page" {
            return Json(
                json!({"ok":true,"result":{"items":(0..50).map(|id| json!({"providerId":"docs","profile":"account","kind":"document","id":format!("large-{id}"),"name":"资料🌳".repeat(100)})).collect::<Vec<_>>(),"hasMore":true,"nextCursor":"page-2"}}),
            );
        }
        assert_eq!(request["input"]["query"], "provider-defined-query");
        if request["input"]["cursor"] == "page-2" {
            json!({"items":[{"providerId":"docs","profile":"account","kind":"document","id":"new","name":"New document"}],"hasMore":false})
        } else {
            json!({"items":[{"providerId":"docs","profile":"other-account","kind":"document","id":"private","name":"Private"}],"hasMore":true,"nextCursor":"page-2"})
        }
    } else {
        assert_eq!(request["method"], "readSource");
        assert_eq!(request["input"]["source"]["id"], "new");
        assert_eq!(request["input"]["source"]["profile"], "account");
        assert_eq!(request["input"]["source"]["policy"]["askBeforeAct"], true);
        assert!(request["input"]["source"].get("scope").is_none());
        json!({"items":[{"id":"fact","text":"Release owner is Lin"}],"hasMore":false})
    };
    Json(json!({"ok":true,"result":result}))
}

#[tokio::test]
async fn memory_collection_protocol_preserves_grants_pagination_and_revocation() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.automation_store = crate::runtime_work::automations::AutomationStore::new(
        root.path().join("automations.json"),
    );
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    store.materialize_implicit_primary(7, "mac").unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"]["connections"] = json!([{"providerId":"docs","profile":"account","kind":"document","id":"*","scope":"all","name":"Documents","policy":{"automatic":false,"askBeforeAct":true}}]);
    settings["primary"]["enabled"] = json!(false);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let grant = settings["primary"]["connections"][0].clone();
    let automation = handler
        .automation_store
        .create(crate::runtime_work::automations::memory_review(7, "mac").unwrap())
        .unwrap();
    let (_, run) = handler
        .automation_store
        .start_manual_run(&automation.id)
        .unwrap();
    let task = run.coordination.as_ref().unwrap().task_id.clone();
    let origin = json!({"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac","standInId":"@primary","automationId":automation.id});
    let identity = StandInMcpIdentity {
        task_id: task.clone(),
        user: 7,
        device: "mac".into(),
        role: Some("@primary".into()),
        work: None,
        ask_before_act: true,
        coordinator_batch: None,
        project: None,
        review: false,
        memory_review: true,
        readonly_worker: false,
    };
    handler.upsert_local_task(RuntimeTaskLink {local_task_id:task,runtime_handle:json!({"origin":origin,"executionRequest":{"user_id":7,"standInSchedule":{"id":automation.id,"version":automation.version,"runId":run.id}}}),..Default::default()});
    let state = Provider {
        store: store.clone(),
        revoke: Arc::new(AtomicBool::new(false)),
        calls: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route("/", post(provider))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    crate::runtime_work::connection_host::TEST_HOST.scope(json!({"url":format!("http://{address}/"),"token":"fixture-token","registeredAt":chrono::Utc::now().timestamp()}), async {
        let mut args = json!({"collection":grant,"query":"provider-defined-query"});
        let first = handler.memory_connection_operation(&identity,"list_memory_connection_resources",&args).await.unwrap();
        let first: Value = serde_json::from_str(first["content"].as_str().unwrap()).unwrap();
        assert_eq!(first["items"],json!([]));
        assert_eq!(first["nextCursor"],"page-2");
        args["cursor"] = first["nextCursor"].clone();
        let second = handler.memory_connection_operation(&identity,"list_memory_connection_resources",&args).await.unwrap();
        let second: Value = serde_json::from_str(second["content"].as_str().unwrap()).unwrap();
        assert_eq!(second["items"][0]["id"],"new");
        let mut read = json!({"source":second["items"][0],"collection":grant});
        read["source"]["policy"]["askBeforeAct"] = json!(false);
        let page = handler.memory_connection_operation(&identity,"read_memory_connection",&read).await.unwrap();
        read["contentHash"] = page["contentHash"].clone();
        let page: Value = serde_json::from_str(page["content"].as_str().unwrap()).unwrap();
        assert_eq!(page["items"][0]["id"],"fact");
        read["itemId"] = json!("fact");
        read["excerpt"] = json!("Release owner is Lin");
        read["content"] = json!("The release owner is Lin.");
        let saved = handler.memory_connection_operation(&identity,"remember_from_connection",&read).await.unwrap();
        assert_eq!(saved["scope"]["id"],"new");
        let mut large = json!({"collection":grant,"query":"large-page"});
        let mut assembled = String::new();
        loop {
            let part = handler.memory_connection_operation(&identity,"list_memory_connection_resources",&large).await.unwrap();
            assert!(part["content"].as_str().unwrap().len() <= 8192);
            assembled.push_str(part["content"].as_str().unwrap());
            if part["nextOffset"].is_null() { break; }
            large["offset"] = part["nextOffset"].clone();
            large["contentHash"] = part["contentHash"].clone();
        }
        let resources: Value = serde_json::from_str(&assembled).unwrap();
        assert_eq!(resources["items"].as_array().unwrap().len(),50);
        assert_eq!(resources["items"][49]["id"],"large-49");
        assert_eq!(resources["items"][49]["name"],"资料🌳".repeat(100));
        assert_eq!(resources["nextCursor"],"page-2");
        large["contentHash"] = json!("stale");
        assert_eq!(handler.memory_connection_operation(&identity,"list_memory_connection_resources",&large).await.unwrap_err().code,"invalid_memory_evidence");
        let calls = state.calls.lock().unwrap().len();
        let mut forged = args.clone();
        forged["collection"]["profile"] = json!("other-account");
        assert_eq!(handler.memory_connection_operation(&identity,"list_memory_connection_resources",&forged).await.unwrap_err().code,"permission_denied");
        forged["collection"] = read["source"].clone();
        assert_eq!(handler.memory_connection_operation(&identity,"list_memory_connection_resources",&forged).await.unwrap_err().code,"permission_denied");
        assert_eq!(state.calls.lock().unwrap().len(),calls);
        state.revoke.store(true,Ordering::SeqCst);
        for (operation, arguments) in [("list_memory_connection_resources", &args),("read_memory_connection", &read),("remember_from_connection", &read)] {
            let mut settings = store.personal_stand_in(7,"mac").unwrap();
            settings["primary"]["connections"] = json!([grant]);
            store.save_personal_stand_in(7,"mac",settings).unwrap();
            assert_eq!(handler.memory_connection_operation(&identity,operation,arguments).await.unwrap_err().code,"permission_denied");
        }
        assert_eq!(store.stand_in_memories(7).unwrap(),vec![saved]);
    }).await;
    server.abort();
}

#[test]
fn memory_collection_binding_rejects_other_partitions_and_caller_policy() {
    let grant = json!({"providerId":"p","profile":"a","kind":"doc","id":"*","scope":"all","collectionKey":"partition","policy":{"askBeforeAct":true}});
    let mut reference = json!({"providerId":"p","profile":"a","kind":"doc","id":"new","collectionKey":"partition","policy":{"askBeforeAct":false}});
    assert_eq!(
        concrete_collection_source(&grant, &reference).unwrap()["policy"],
        grant["policy"]
    );
    for field in ["providerId", "profile", "kind", "collectionKey"] {
        let mut forged = reference.clone();
        forged[field] = json!("other");
        assert!(concrete_collection_source(&grant, &forged).is_none());
    }
    reference["id"] = json!("*");
    assert!(concrete_collection_source(&grant, &reference).is_none());
}
