// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex};

use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use wegent_executor::services::api_client::fetch_task_skills;

#[derive(Clone, Default)]
struct RequestLog {
    paths: Arc<Mutex<Vec<String>>>,
    auth_headers: Arc<Mutex<Vec<String>>>,
}

#[tokio::test]
async fn fetch_task_skills_returns_ref_metadata() {
    let log = RequestLog::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route(
            "/api/v1/tasks/123/skills",
            get({
                let log = log.clone();
                move |headers: HeaderMap| async move {
                    log.paths
                        .lock()
                        .unwrap()
                        .push("/api/v1/tasks/123/skills".to_owned());
                    log.auth_headers.lock().unwrap().push(
                        headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("")
                            .to_owned(),
                    );
                    Json(json!({
                        "task_id": 123,
                        "team_id": 456,
                        "team_namespace": "team-a",
                        "skills": ["ghost-skill", "subscription-skill"],
                        "preload_skills": ["subscription-skill"],
                        "skill_refs": {
                            "ghost-skill": {
                                "skill_id": 11,
                                "namespace": "team-a",
                                "is_public": false
                            }
                        },
                        "preload_skill_refs": {
                            "subscription-skill": {
                                "skill_id": 22,
                                "namespace": "team-a",
                                "is_public": false
                            }
                        }
                    }))
                }
            }),
        )
        .with_state(State(log.clone()));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let result = fetch_task_skills(&base_url, "123", "token").await.unwrap();

    assert_eq!(
        log.paths.lock().unwrap().as_slice(),
        ["/api/v1/tasks/123/skills"]
    );
    assert_eq!(
        log.auth_headers.lock().unwrap().as_slice(),
        ["Bearer token"]
    );
    assert_eq!(result.task_id, 123);
    assert_eq!(result.team_id, Some(456));
    assert_eq!(result.team_namespace.as_deref(), Some("team-a"));
    assert_eq!(result.skills, vec!["ghost-skill", "subscription-skill"]);
    assert_eq!(result.preload_skills, vec!["subscription-skill"]);
    assert_eq!(
        result.skill_refs["ghost-skill"]["skill_id"],
        Value::from(11)
    );
    assert_eq!(
        result.preload_skill_refs["subscription-skill"]["skill_id"],
        Value::from(22)
    );
}
