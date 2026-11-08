use super::*;
use crate::task_runtime::{TaskCreate, TaskProviderKind};

#[tokio::test]
async fn memory_project_store_collision_keeps_authorization_and_reader_in_same_namespace() {
    use axum::{routing::get, Json, Router};
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name":"Local"})).unwrap())
        .unwrap();
    store.materialize_implicit_primary(7, "mac").unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"]["collaboration"] = json!({"enabled":true,"allProjects":false,"projects":[{"id":project.id,"store":"cloud"}],"excludedProjects":[],"tags":[]});
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let app = Router::new().route(
        &format!("/api/v1/cloud-projects/{}/files", project.id),
        get(|| async { Json(json!({"items":[{"id":"cloud-only"}]})) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let runtime = TaskRuntime::new(store).unwrap();
    let context = SpaceMcpRequestContext::new(
        None,
        Some(format!("http://{address}")),
        Some("fixture".into()),
    );
    let request: ExecutionRequest = serde_json::from_value(json!({"origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac"}})).unwrap();
    let identity = stand_in_identity(&request).unwrap();
    let mut args = json!({"projectId":project.id,"projectStore":"cloud","kind":"files"});
    assert!(
        check_project(&runtime, &identity, &args).is_ok(),
        "A local ID must not shadow an authorized cloud source"
    );
    assert_eq!(
        project_evidence(&runtime, &context, &args).await.unwrap()["items"][0]["id"],
        "cloud-only"
    );
    let disconnected = SpaceMcpRequestContext::new(None, context.backend_url.clone(), None);
    assert!(project_evidence(&runtime, &disconnected, &args)
        .await
        .unwrap_err()
        .contains("authenticated"));
    let mut restricted = context.clone();
    restricted.grant = Some(SpaceContextGrant {
        role: Some(SpaceContextRole::Executor),
        categories: HashSet::from([BoardToolCategory::Management]),
        ..SpaceContextGrant::default()
    });
    assert!(project_evidence(&runtime, &restricted, &args)
        .await
        .unwrap_err()
        .contains("dispatch role"));
    let ordinary = read_tool(
        &runtime,
        &context,
        "list_space_files",
        json!({"space_id":project.id,"projectStore":"cloud","project_read_store":"backend"}),
    )
    .await
    .unwrap();
    assert_eq!(
        ordinary,
        json!([]),
        "Tool arguments cannot opt into host-only routing"
    );
    let mut local_args = args.clone();
    local_args["projectStore"] = json!("local");
    assert!(
        check_project(&runtime, &identity, &local_args).is_err(),
        "An active cloud grant must not authorize the local project"
    );
    let mut revoked = runtime
        .stand_in_store()
        .personal_stand_in(7, "mac")
        .unwrap();
    revoked["primary"]["collaboration"]["projects"] = json!([]);
    runtime
        .stand_in_store()
        .save_personal_stand_in(7, "mac", revoked)
        .unwrap();
    assert!(check_project(&runtime, &identity, &args).is_err());
    args["projectStore"] = json!("local");
    assert!(
        check_project(&runtime, &identity, &args).is_err(),
        "A cloud grant must not authorize the local project"
    );
    assert_eq!(
        project_evidence(&runtime, &context, &args).await.unwrap(),
        json!([])
    );
    args["projectId"] = json!("missing-local-project");
    assert!(project_evidence(&runtime, &context, &args).await.is_err());
    args["projectStore"] = json!("other");
    assert!(project_evidence(&runtime, &context, &args).await.is_err());
    server.abort();
}

#[tokio::test]
async fn memory_cloud_project_file_rechecks_owner_and_limits_download_without_token_leak() {
    use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    // Modes: normal, removed during download, oversized, absent, wrong owner, folder.
    let state = Arc::new((
        AtomicUsize::new(0),
        AtomicBool::new(false),
        AtomicUsize::new(0),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/api/v1/cloud-projects/project/files",get(|State(state): State<Arc<(AtomicUsize,AtomicBool,AtomicUsize)>>, headers: HeaderMap| async move {
            assert_eq!(headers.get("authorization").unwrap(),"Bearer fixture-token");
            let mode = state.0.load(Ordering::SeqCst);
            Json(json!({"items":if mode == 3 || state.1.load(Ordering::SeqCst) {json!([])} else {json!([{"id":"file","cloud_project_id":if mode==4 {"other"} else {"project"},"kind":if mode==5 {"folder"} else {"file"}}])}}))
        }))
        .route("/api/v1/cloud-projects/files/file/access",get(move |State(state): State<Arc<(AtomicUsize,AtomicBool,AtomicUsize)>>, headers: HeaderMap| async move {
            assert_eq!(headers.get("authorization").unwrap(),"Bearer fixture-token");
            state.2.fetch_add(1,Ordering::SeqCst);
            Json(json!({"url":format!("http://{address}/object")}))
        }))
        .route("/object",get(|State(state): State<Arc<(AtomicUsize,AtomicBool,AtomicUsize)>>, headers: HeaderMap| async move {
            assert!(headers.get("authorization").is_none(),"Backend token must not be forwarded to object storage");
            match state.0.load(Ordering::SeqCst) {
                1 => {state.1.store(true,Ordering::SeqCst); "Project review is Friday".to_owned()},
                2 => "x".repeat(crate::runtime_work::document_evidence::MAX_TEXT_BYTES as usize+1),
                _ => "Project review is Friday".to_owned(),
            }
        }))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let root = tempfile::tempdir().unwrap();
    let runtime =
        TaskRuntime::new(LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap()).unwrap();
    let context = SpaceMcpRequestContext::new(
        None,
        Some(format!("http://{address}")),
        Some("fixture-token".into()),
    );
    let args = json!({"projectId":"project","projectStore":"cloud","kind":"file","fileId":"file"});
    let evidence = project_evidence(&runtime, &context, &args).await.unwrap();
    assert_eq!(evidence["content"], "Project review is Friday");
    assert_eq!(evidence["fileId"], "file");
    assert!(evidence.get("path").is_none());
    state.0.store(1, Ordering::SeqCst);
    assert!(project_evidence(&runtime, &context, &args)
        .await
        .unwrap_err()
        .contains("inventory"));
    state.1.store(false, Ordering::SeqCst);
    state.0.store(2, Ordering::SeqCst);
    assert!(project_evidence(&runtime, &context, &args)
        .await
        .unwrap_err()
        .contains("limit"));
    let requests = state.2.load(Ordering::SeqCst);
    for mode in [3, 4, 5] {
        state.0.store(mode, Ordering::SeqCst);
        assert!(project_evidence(&runtime, &context, &args)
            .await
            .unwrap_err()
            .contains("inventory"));
        assert_eq!(state.2.load(Ordering::SeqCst), requests);
    }
    let disconnected = SpaceMcpRequestContext::new(None, Some(format!("http://{address}")), None);
    assert!(project_evidence(&runtime, &disconnected, &args)
        .await
        .unwrap_err()
        .contains("authenticated"));
    assert_eq!(state.2.load(Ordering::SeqCst), requests);
    server.abort();
}

#[tokio::test]
async fn memory_project_files_without_issues_preserve_file_scope_and_current_membership() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let create = |name: &str| {
        store
            .create_project(ProjectCreate {
                name: name.into(),
                project_key: None,
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap()
    };
    let owner = create("File evidence");
    let other = create("Other");
    let file = store.upload_project_file(&owner.id, Some("policy/reports.txt"), serde_json::from_value(json!({"display_name":"reports.txt","base64":STANDARD.encode("Project reports always use UTF-8.")})).unwrap()).unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    let context = SpaceMcpRequestContext::new(None, None, None);
    let mut args = json!({"projectId":owner.id,"projectStore":"local","kind":"files"});
    let listing = project_evidence(&runtime, &context, &args).await.unwrap();
    assert!(listing
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["id"] == file.id));
    args["kind"] = json!("file");
    args["fileId"] = json!(file.id);
    let evidence = project_evidence(&runtime, &context, &args).await.unwrap();
    assert_eq!(evidence["content"], "Project reports always use UTF-8.");
    assert!(evidence.get("path").is_none());
    assert_eq!(
        evidence["originalContentHash"],
        format!("{:x}", Sha256::digest(b"Project reports always use UTF-8."))
    );
    let page = chunk(&evidence, &json!({})).unwrap();
    let request: ExecutionRequest = serde_json::from_value(json!({"origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac"}})).unwrap();
    let identity = stand_in_identity(&request).unwrap();
    assert!(check_project(&runtime, &identity, &args).is_err());
    let store = runtime.stand_in_store();
    store.materialize_implicit_primary(7, "mac").unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"]["collaboration"] = json!({"enabled":true,"allProjects":false,"projects":[{"id":owner.id,"store":"local"}],"excludedProjects":[],"tags":[]});
    let mut settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    check_project(&runtime, &identity, &args).unwrap();
    args["contentHash"] = page["contentHash"].clone();
    args["excerpt"] = json!("Project reports always use UTF-8.");
    args["content"] = json!("This project uses UTF-8 reports");
    let saved = save_memory(store, &identity, &args, &page).unwrap();
    assert_eq!(saved["evidence"]["source"]["fileId"], file.id);
    assert_eq!(
        saved["scope"],
        json!({"kind":"project","id":owner.id,"store":"local"})
    );
    let original_key = project_source_key(&project_source(&args));
    args["fileId"] = json!("other-file");
    assert_ne!(original_key, project_source_key(&project_source(&args)));
    assert!(project_evidence(&runtime, &context, &args).await.is_err());
    args["fileId"] = json!(file.id);
    args["projectId"] = json!(other.id);
    assert!(project_evidence(&runtime, &context, &args).await.is_err());
    args["projectId"] = json!(owner.id);
    settings["primary"]["collaboration"]["projects"] = json!([]);
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    assert!(check_project(&runtime, &identity, &args).is_err());
    runtime.delete_project_file(&file.id, false).unwrap();
    assert!(project_evidence(&runtime, &context, &args).await.is_err());
}

#[tokio::test]
async fn memory_issue_attachments_bind_real_file_content_to_project_and_issue() {
    use base64::Engine;
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(ProjectCreate {
            name: "Attachment memory".into(),
            project_key: None,
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    let mut issues = Vec::new();
    for title in ["Owner", "Other"] {
        issues.push(
            store
                .create_task(
                    &project.id,
                    TaskCreate {
                        title: title.into(),
                        description: String::new(),
                        status: "inbox".into(),
                        priority: "none".into(),
                        milestone_id: None,
                        parent_id: None,
                        tags: vec![],
                        assignee_user_id: None,
                        assignee_agent_id: None,
                        assignee_group_id: None,
                        workflow: None,
                    },
                )
                .unwrap(),
        );
    }
    let runtime = TaskRuntime::new(store).unwrap();
    let bytes = wegent_document_parser::pdf::simple_pdf_bytes();
    let attachment = runtime
        .add_task_attachment(
            &project.id,
            &issues[0].id,
            serde_json::from_value(json!({"display_name":"guide.pdf",
            "base64":base64::engine::general_purpose::STANDARD.encode(&bytes)}))
            .unwrap(),
        )
        .await
        .unwrap();
    let context = SpaceMcpRequestContext::new(None, None, None);
    let mut args = json!({"projectId":project.id,"projectStore":"local",
        "itemId":issues[0].id,"kind":"attachments"});
    let listing = project_evidence(&runtime, &context, &args).await.unwrap();
    assert_eq!(listing[0]["id"], attachment.id);
    args["kind"] = json!("attachment");
    args["attachmentId"] = json!(attachment.id);
    let evidence = project_evidence(&runtime, &context, &args).await.unwrap();
    assert!(!evidence["content"].as_str().unwrap().is_empty());
    assert_eq!(
        evidence["originalContentHash"],
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert_eq!(evidence["attachmentId"], attachment.id);
    assert!(evidence.get("path").is_none());
    let store = runtime.stand_in_store();
    store.materialize_implicit_primary(7, "mac").unwrap();
    let mut settings = store.personal_stand_in(7, "mac").unwrap();
    settings["primary"]["collaboration"] = json!({"enabled":true,"allProjects":false,
        "projects":[{"id":project.id,"store":"local"}],"excludedProjects":[],"tags":[]});
    store.save_personal_stand_in(7, "mac", settings).unwrap();
    let request: ExecutionRequest = serde_json::from_value(json!({
        "origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac"}
    }))
    .unwrap();
    let identity = stand_in_identity(&request).unwrap();
    let page = chunk(&evidence, &json!({})).unwrap();
    let mut save = args.clone();
    save["contentHash"] = page["contentHash"].clone();
    // The JSON chunk quotes this short PDF fixture's original text.
    save["excerpt"] = json!(evidence["content"]
        .as_str()
        .unwrap()
        .lines()
        .next()
        .unwrap());
    save["content"] = json!("Project PDF test evidence");
    let saved = save_memory(store, &identity, &save, &page).unwrap();
    assert_eq!(saved["evidence"]["source"]["attachmentId"], attachment.id);
    assert_eq!(saved["evidence"]["source"]["itemId"], issues[0].id);
    assert_eq!(
        saved["scope"],
        json!({"kind":"project","id":project.id,"store":"local"})
    );
    store
        .delete_stand_in_memory(7, saved["id"].as_str().unwrap(), 1)
        .unwrap();
    save["content"] = json!("Paraphrased project PDF evidence");
    assert_eq!(
        save_memory(store, &identity, &save, &page).unwrap()["status"],
        "suppressed"
    );
    for (field, value) in [
        ("itemId", issues[1].id.as_str()),
        ("projectId", "foreign"),
        ("attachmentId", "foreign"),
    ] {
        let mut other = args.clone();
        other[field] = json!(value);
        assert!(
            project_evidence(&runtime, &context, &other).await.is_err(),
            "{field}"
        );
    }
    runtime
        .delete_task_attachment(&project.id, &issues[0].id, &attachment.id)
        .await
        .unwrap();
    assert!(project_evidence(&runtime, &context, &args).await.is_err());
}

#[tokio::test]
async fn memory_cloud_issue_attachment_revalidates_membership_and_bounds_downloads() {
    use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    // Modes: normal, revoke during download, oversized, unavailable before read.
    let state = Arc::new((
        AtomicUsize::new(0),
        AtomicBool::new(false),
        AtomicUsize::new(0),
    ));
    let app = Router::new()
        .route(
            "/api/v1/loop-items/issue",
            get(|| async { Json(json!({"id":"issue","cloud_project_id":"project"})) }),
        )
        .route(
            "/api/v1/loop-items/issue/attachments",
            get(
                |State(state): State<Arc<(AtomicUsize, AtomicBool, AtomicUsize)>>| async move {
                    Json(
                        if state.0.load(Ordering::SeqCst) == 3 || state.1.load(Ordering::SeqCst) {
                            json!([])
                        } else {
                            json!([{"id":"attachment"}])
                        },
                    )
                },
            ),
        )
        .route(
            "/api/v1/loop-item-attachments/attachment/content",
            get(
                |State(state): State<Arc<(AtomicUsize, AtomicBool, AtomicUsize)>>,
                 headers: HeaderMap| async move {
                    assert_eq!(
                        headers.get("authorization").unwrap(),
                        "Bearer fixture-token"
                    );
                    state.2.fetch_add(1, Ordering::SeqCst);
                    match state.0.load(Ordering::SeqCst) {
                        1 => {
                            state.1.store(true, Ordering::SeqCst);
                            "Release review is Friday".to_owned()
                        }
                        2 => "x".repeat(
                            crate::runtime_work::document_evidence::MAX_TEXT_BYTES as usize + 1,
                        ),
                        _ => "Release review is Friday".to_owned(),
                    }
                },
            ),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let runtime =
        TaskRuntime::new(LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap())
            .unwrap();
    let context = SpaceMcpRequestContext::new(
        None,
        Some(format!("http://{address}")),
        Some("fixture-token".into()),
    );
    let args = json!({"projectId":"project","projectStore":"cloud","itemId":"issue",
        "kind":"attachment","attachmentId":"attachment"});
    let evidence = project_evidence(&runtime, &context, &args).await.unwrap();
    assert_eq!(evidence["content"], "Release review is Friday");
    assert!(evidence.get("path").is_none());
    state.0.store(1, Ordering::SeqCst);
    assert!(project_evidence(&runtime, &context, &args)
        .await
        .unwrap_err()
        .contains("ownership changed"));
    state.1.store(false, Ordering::SeqCst);
    state.0.store(2, Ordering::SeqCst);
    assert!(project_evidence(&runtime, &context, &args)
        .await
        .unwrap_err()
        .contains("limit"));
    let downloads = state.2.load(Ordering::SeqCst);
    state.0.store(3, Ordering::SeqCst);
    assert!(project_evidence(&runtime, &context, &args).await.is_err());
    assert_eq!(state.2.load(Ordering::SeqCst), downloads);
    server.abort();
}
