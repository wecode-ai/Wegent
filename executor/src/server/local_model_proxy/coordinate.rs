// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task-scoped model routes for explicitly configured Codex team members.

use super::*;

pub(crate) const MEMBER_MODEL_MARKER: &str = "--wegent-member-";

#[derive(Debug, Clone)]
pub(crate) struct CoordinateMemberRoute {
    pub upstream: LocalModelProxyUpstream,
    pub vision_sidecar: Option<VisionSidecarUpstream>,
    pub(super) history: std::sync::Arc<history::CodexToolHistory>,
}

impl CoordinateMemberRoute {
    pub(crate) fn new(
        upstream: LocalModelProxyUpstream,
        vision_sidecar: Option<VisionSidecarUpstream>,
    ) -> Self {
        Self {
            upstream,
            vision_sidecar,
            history: Default::default(),
        }
    }
}

pub(crate) fn set_coordinate_members(
    token: &str,
    mut members: HashMap<String, CoordinateMemberRoute>,
) -> Result<(), String> {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    let registered = registry
        .routes
        .get_mut(token)
        .ok_or_else(|| "local model proxy task route is not registered".to_owned())?;
    for (alias, member) in &mut members {
        if let Some(previous) = registered.coordinate_members.get(alias) {
            member.history = previous.history.clone();
        }
    }
    registered.coordinate_members = members;
    Ok(())
}

pub(crate) fn coordinate_leader_upstream(token: &str) -> Result<LocalModelProxyUpstream, String> {
    registry()
        .lock()
        .expect("local model proxy registry should not be poisoned")
        .routes
        .get(token)
        .map(|registered| registered.upstream.clone())
        .ok_or_else(|| "local model proxy task route is not registered".to_owned())
}

pub(super) fn member_route<'a>(
    registered: &'a RegisteredUpstream,
    body: &[u8],
) -> Result<Option<&'a CoordinateMemberRoute>, HttpError> {
    let Some(model) = requested_model(body) else {
        return Ok(None);
    };
    if !model.contains(MEMBER_MODEL_MARKER) {
        return Ok(None);
    }
    let child_is_authorized = request_thread_identity(body).is_some_and(|identity| {
        identity.parent_thread_id.is_some_and(|parent| {
            parent != identity.thread_id && registered.thread_ids.contains(&parent)
        })
    });
    if !child_is_authorized {
        return Err(HttpError {
            status: StatusCode::CONFLICT,
            detail: "a coordinate member model requires an authorized child thread".to_owned(),
        });
    }
    registered
        .coordinate_members
        .get(&model)
        .map(Some)
        .ok_or_else(|| HttpError {
            status: StatusCode::CONFLICT,
            detail: "the requested coordinate member model is not registered for this task"
                .to_owned(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router};
    use tokio::sync::mpsc;

    fn upstream(endpoint: &str, key: &str) -> LocalModelProxyUpstream {
        upstream_from_model_config(&json!({
            "base_url": endpoint,
            "api_key": key,
            "model_id": "same-model"
        }))
        .unwrap()
    }

    #[test]
    fn coordinate_routes_preserve_member_provider_and_credentials() {
        let token = register(
            "coordinate-routes",
            upstream("https://leader.example", "leader"),
        );
        bind_thread(&token, "leader").unwrap();
        let alias = format!("same-model{MEMBER_MODEL_MARKER}reviewer");
        set_coordinate_members(
            &token,
            HashMap::from([(
                alias.clone(),
                CoordinateMemberRoute::new(upstream("https://reviewer.example", "reviewer"), None),
            )]),
        )
        .unwrap();
        {
            let mut registry = registry().lock().unwrap();
            let registered = registry.routes.get_mut(&token).unwrap();
            let body = serde_json::to_vec(&json!({
                "model": alias,
                "client_metadata": {"thread_id": "child", "parent_thread_id": "leader"}
            }))
            .unwrap();
            authorize_task_thread(registered, &body).unwrap();
            let route = member_route(registered, &body).unwrap().unwrap();
            assert_eq!(route.upstream.base_url, "https://reviewer.example");
            assert_eq!(route.upstream.api_key, "reviewer");
            assert_eq!(route.upstream.model_id.as_deref(), Some("same-model"));
            assert_eq!(registered.upstream.api_key, "leader");
        }
        unregister(&token);
    }

    #[test]
    fn coordinate_reconfiguration_preserves_tool_history_for_resumed_members() {
        let token = register(
            "coordinate-resume",
            upstream("https://leader.example", "leader"),
        );
        let alias = format!("same-model{MEMBER_MODEL_MARKER}resume");
        let member = CoordinateMemberRoute::new(upstream("https://member.example", "member"), None);
        let history = member.history.clone();
        set_coordinate_members(&token, HashMap::from([(alias.clone(), member)])).unwrap();
        set_coordinate_members(
            &token,
            HashMap::from([(
                alias.clone(),
                CoordinateMemberRoute::new(upstream("https://member.example", "updated"), None),
            )]),
        )
        .unwrap();
        {
            let registry = registry().lock().unwrap();
            let member = &registry.routes[&token].coordinate_members[&alias];
            assert!(std::sync::Arc::ptr_eq(&member.history, &history));
            assert_eq!(member.upstream.api_key, "updated");
        }
        unregister(&token);
    }

    #[test]
    fn coordinate_models_cannot_select_another_tasks_provider_or_replace_the_leader() {
        let token = register(
            "coordinate-isolation",
            upstream("https://leader.example", "leader"),
        );
        bind_thread(&token, "leader").unwrap();
        {
            let registry = registry().lock().unwrap();
            let registered = registry.routes.get(&token).unwrap();
            for metadata in [
                json!({"thread_id": "leader"}),
                json!({"thread_id": "foreign", "parent_thread_id": "foreign-parent"}),
                json!({"thread_id": "child", "parent_thread_id": "leader"}),
            ] {
                let body = serde_json::to_vec(&json!({
                    "model": format!("model{MEMBER_MODEL_MARKER}missing"),
                    "client_metadata": metadata
                }))
                .unwrap();
                assert!(member_route(registered, &body).is_err());
            }
            assert!(member_route(registered, br#"{"model":"ordinary-model"}"#)
                .unwrap()
                .is_none());
        }
        unregister(&token);
    }

    #[tokio::test]
    async fn coordinate_proxy_forwards_member_model_and_auth_to_its_provider() {
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/responses",
                    post(move |headers: HeaderMap, Json(body): Json<Value>| {
                        let sender = sender.clone();
                        async move {
                            sender.send((headers, body)).unwrap();
                            (
                                [(header::CONTENT_TYPE, "text/event-stream")],
                                "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n",
                            )
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let token = register(
            "coordinate-provider-http",
            upstream("https://unused-leader.example", "leader-secret"),
        );
        bind_thread(&token, "leader-http").unwrap();
        let alias = format!("same-model{MEMBER_MODEL_MARKER}http");
        set_coordinate_members(
            &token,
            HashMap::from([(
                alias.clone(),
                CoordinateMemberRoute::new(
                    upstream(&format!("http://{address}"), "member-secret"),
                    None,
                ),
            )]),
        )
        .unwrap();
        let response = handle_for_token(
            token.clone(),
            HeaderMap::new(),
            Bytes::from(
                serde_json::to_vec(&json!({
                    "model": alias,
                    "input": [{"role": "user", "content": "review"}],
                    "stream": true,
                    "client_metadata": {
                        "thread_id": "child-http",
                        "x-codex-parent-thread-id": "leader-http"
                    }
                }))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let (headers, body) = receiver.recv().await.unwrap();
        assert_eq!(headers[header::AUTHORIZATION], "Bearer member-secret");
        assert_eq!(body["model"], "same-model");
        unregister(&token);
        server.abort();
    }
}
