use super::*;
use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value as SqlValue};
use brz_mysql::Json;

fn row(slug: &str, spec: Value) -> db::KindRow {
    db::KindRow {
        kinds_id: 1,
        kinds_user_id: 0,
        kinds_kind: "ConnectorApp".into(),
        kinds_name: slug.into(),
        kinds_namespace: "system".into(),
        kinds_json: Json(brz_json::OpaqueJson::from_serializable(
            json!({"spec": spec}),
        )),
        kinds_is_active: true,
        kinds_created_at: chrono::Utc::now().naive_utc(),
        kinds_updated_at: chrono::Utc::now().naive_utc(),
    }
}

fn app(slug: &str, mode: &str, available: bool) -> App {
    App {
        config: service::row_to_app(&row(slug, json!({"name": slug, "toolLoadingMode": mode}))),
        keywords: vec![],
        available,
    }
}

fn request(shell: &str) -> ExecutionRequest {
    ExecutionRequest {
        user_id: 7,
        user_name: "connector-test".into(),
        auth_token: "test-task-token".into(),
        backend_url: "http://backend:8000".into(),
        bot: json!([{"shell_type": shell, "mcp_servers": [], "skills": []}]),
        prompt: json!("Invoke echo once without mentioning a connector"),
        ..Default::default()
    }
}

#[test]
fn chat_mounts_static_and_defers_lazy_without_keywords() {
    let mut request = request("Chat");
    assemble(
        &mut request,
        &[
            app("static-app", "static", true),
            app("lazy-app", "lazy", true),
        ],
        false,
    );
    assert_eq!(request.mcp_servers.len(), 1);
    assert_eq!(request.mcp_servers[0]["name"], "wegent-connectors");
    assert_eq!(
        request.mcp_servers[0]["auth"]["Authorization"],
        "Bearer test-task-token"
    );
    assert_eq!(
        request.skill_names,
        vec![json!("wegent-connector-lazy-app")]
    );
    assert!(request.preload_skills.is_empty());
    assert_eq!(
        request.skill_configs[0]["mcpServers"]["wegent-connector-lazy-app"]["headers"]["X-Connector-App"],
        "lazy-app"
    );
    assert_eq!(
        request.skill_configs[0]["mcpServers"]["wegent-connector-lazy-app"]["url"],
        "http://backend:8000/api/mcp/connectors/sse"
    );
    assert!(request.bot[0]["mcp_servers"].as_array().unwrap().is_empty());
}

#[test]
fn cloud_coding_mounts_static_and_compact_lazy_with_preserved_headers() {
    for shell in ["Codex", "ClaudeCode"] {
        let mut request = request(shell);
        assemble(
            &mut request,
            &[
                app("static-app", "static", true),
                app("lazy-app", "lazy", true),
            ],
            false,
        );
        let mut servers = request.bot[0]["mcp_servers"].as_array().unwrap().clone();
        super::super::skills::append_coding_mcp(&mut servers, &Default::default(), shell);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0]["name"], "wegent-connectors");
        assert_eq!(servers[1]["headers"]["X-Connector-Loading"], "lazy");
        if shell == "ClaudeCode" {
            assert_eq!(servers[1]["name"], "wca");
            assert!(servers[1]["headers"].get("X-Connector-App").is_none());
        } else {
            assert_eq!(servers[1]["headers"]["X-Connector-App"], "lazy-app");
        }
        assert_eq!(
            servers[1].get("alwaysLoad"),
            if shell == "ClaudeCode" {
                Some(&json!(true))
            } else {
                None
            }
        );
        assert_eq!(
            servers[1]["headers"]["Authorization"],
            "Bearer ${{task_token}}"
        );
        assert_eq!(servers[1]["url"], "${{backend_api_url}}/mcp/connectors/sse");
        assert_eq!(
            servers[1]["type"],
            if shell == "ClaudeCode" {
                "http"
            } else {
                "streamable-http"
            }
        );
    }
}

#[test]
fn connector_urls_normalize_an_existing_api_prefix() {
    for backend in [
        "http://backend:8000",
        "http://backend:8000/",
        "http://backend:8000/api",
        "http://backend:8000/api/",
    ] {
        for shell in ["Chat", "Codex"] {
            let mut request = request(shell);
            request.backend_url = backend.into();
            assemble(&mut request, &[app("static-app", "static", true)], false);
            let servers = if shell == "Chat" {
                &request.mcp_servers
            } else {
                request.bot[0]["mcp_servers"].as_array().unwrap()
            };
            assert_eq!(
                servers[0]["url"],
                if shell == "Chat" {
                    "http://backend:8000/api/mcp/connectors/sse"
                } else {
                    "${{backend_api_url}}/mcp/connectors/sse"
                },
                "backend={backend} shell={shell}"
            );
        }
    }
}

#[test]
fn keyword_phrases_require_all_terms_and_preload_chat_or_direct_coding() {
    for shell in ["Chat", "Codex", "ClaudeCode"] {
        for (prompt, matched) in [("WRITE the DOCUMENT", true), ("write a table", false)] {
            let mut request = request(shell);
            request.prompt = json!([{"type": "input_text", "text": prompt}, {"type": "image", "text": "document"}]);
            let mut app = app("lazy-app", "lazy", true);
            app.keywords = vec!["write document".into()];
            assemble(&mut request, &[app], false);
            if shell == "Chat" {
                assert_eq!(
                    request
                        .preload_skills
                        .contains(&json!("wegent-connector-lazy-app")),
                    matched
                );
                assert_eq!(request.mcp_servers.len(), usize::from(matched));
                assert_eq!(
                    request.skill_configs[0].get("mcpServers").is_none(),
                    matched
                );
            } else {
                assert_eq!(
                    request.bot[0]["mcp_servers"][0]["headers"]["X-Connector-Loading"] == "lazy",
                    !matched
                );
            }
        }
    }
    assert!(!keywords_match("anything", &[String::new(), "  ".into()]));
}

#[test]
fn claude_compact_tools_share_a_server_within_the_provider_name_budget() {
    let mut request = request("ClaudeCode");
    let slug = "a".repeat(100);
    let apps = [
        app(&slug, "lazy", true),
        app("another-app", "lazy", true),
        app("pending-app", "lazy", false),
    ];
    assemble(&mut request, &apps, false);
    let mut servers = request.bot[0]["mcp_servers"].as_array().unwrap().clone();
    super::super::skills::append_coding_mcp(&mut servers, &Default::default(), "ClaudeCode");
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0]["name"], "wca");
    assert_eq!(servers[0]["alwaysLoad"], true);
    assert!(servers[0]["headers"].get("X-Connector-App").is_none());
    for tool in crate::connector_runtime::loading::deferred_tools(&apps[0].config) {
        let full_name = format!(
            "mcp__{}__{}",
            servers[0]["name"].as_str().unwrap(),
            tool["name"].as_str().unwrap()
        );
        assert!(full_name.len() <= 128, "{full_name}");
    }
}

#[test]
fn device_coding_does_not_mount_cloud_connector_servers() {
    let mut request = request("Codex");
    assemble(
        &mut request,
        &[
            app("static-app", "static", true),
            app("lazy-app", "lazy", true),
        ],
        true,
    );
    assert_eq!(request.bot[0]["mcp_servers"], json!([]));
    assert!(request.skill_configs.is_empty());
}

#[test]
fn selected_provider_skill_gets_one_scope_and_supersedes_personal_mcp() {
    for shell in ["Chat", "ClaudeCode"] {
        let mut request = request(shell);
        request.skill_configs = vec![json!({
            "name": "provider-skill", "connector_slug": "lazy-app",
            "mcpServers": {"personal": {"url": "https://personal.invalid"}}
        })];
        request.skill_names = vec![json!("provider-skill")];
        request.user_selected_skills = vec![json!("provider-skill")];
        assemble(&mut request, &[app("lazy-app", "lazy", true)], false);
        assert_eq!(request.skill_configs.len(), 1);
        assert_eq!(request.skill_configs[0]["connector_available"], true);
        let servers = request.skill_configs[0]["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(
            servers["wegent-connector-lazy-app"]["headers"]["X-Connector-App"],
            "lazy-app"
        );
        assert_eq!(
            servers["wegent-connector-lazy-app"]["url"],
            if shell == "Chat" {
                "http://backend:8000/api/mcp/connectors/sse"
            } else {
                "${{backend_api_url}}/mcp/connectors/sse"
            }
        );
        assert!(request.mcp_servers.is_empty());
        assert_eq!(request.bot[0]["mcp_servers"], json!([]));
    }
}

#[test]
fn unauthorized_apps_have_guidance_but_no_callable_tools() {
    let mut request = request("Chat");
    assemble(
        &mut request,
        &[
            app("static-app", "static", false),
            app("lazy-app", "lazy", false),
        ],
        false,
    );
    assert!(request.mcp_servers.is_empty());
    assert!(request.skill_configs.is_empty());
    let prompt = request.prompt.as_str().unwrap();
    assert!(prompt.contains("connector-oauth?slug=static-app"));
    assert!(!prompt.contains("connector-oauth?slug=lazy-app"));
}

#[test]
fn static_provider_uses_the_aggregate_once_and_personal_mcp_survives_missing_grant() {
    for available in [true, false] {
        let mut request = request("Chat");
        request.skill_configs = vec![json!({
            "name": "provider-skill", "connector_slug": "static-app",
            "mcpServers": {"personal": {"url": "https://personal.invalid"}}
        })];
        request.preload_skills = vec![json!("provider-skill")];
        assemble(
            &mut request,
            &[app("static-app", "static", available)],
            false,
        );
        assert_eq!(request.mcp_servers.len(), usize::from(available));
        assert_eq!(
            request.skill_configs[0].get("mcpServers").is_none(),
            available
        );
        assert!(
            !request
                .prompt
                .as_str()
                .unwrap()
                .contains("connector-oauth?slug=static-app")
        );
    }
}

fn sql_kind(slug: &str, kind: &str, spec: Value) -> Row {
    vec![
        ("kinds_id", SqlValue::I64(1)),
        (
            "kinds_user_id",
            SqlValue::I64(if kind == "ConnectorApp" { 0 } else { 7 }),
        ),
        ("kinds_kind", SqlValue::Text(kind.into())),
        ("kinds_name", SqlValue::Text(slug.into())),
        ("kinds_namespace", SqlValue::Text("system".into())),
        (
            "kinds_json",
            SqlValue::Text(json!({"spec": spec}).to_string()),
        ),
        ("kinds_is_active", SqlValue::I8(1)),
        ("kinds_created_at", SqlValue::DateTime),
        ("kinds_updated_at", SqlValue::DateTime),
    ]
}

#[tokio::test]
async fn catalog_and_grant_reads_enforce_identity_visibility_and_no_upstream_probe() {
    let fixture = MysqlRows::start_results(|sql| {
        if sql.contains("'ConnectorApp'") {
            assert!(sql.contains("namespace = 'system'") && sql.contains("user_id = 0"));
            let rows = vec![
                sql_kind("allowed", "ConnectorApp", json!({"authType":"oauth2","toolLoadingMode":"lazy","keywords":["write document"]})),
                sql_kind("hidden", "ConnectorApp", json!({"visibility":"roles","allowedRoles":["admin"],"authType":"oauth2"})),
                sql_kind("disabled", "ConnectorApp", json!({"enabled":false})),
            ];
            return (rows[0].clone(), rows);
        }
        if sql.contains("FROM users") {
            assert!(sql.contains("users.id = ? AND users.user_name = ?"));
            let row = vec![
                ("users_id", SqlValue::I64(7)), ("users_user_name", SqlValue::Text("connector-test".into())),
                ("users_password_hash", SqlValue::Text("unused".into())), ("users_email", SqlValue::Text("".into())),
                ("users_git_info", SqlValue::Null), ("users_is_active", SqlValue::I8(1)),
                ("users_role", SqlValue::Text("user".into())), ("users_auth_source", SqlValue::Text("test".into())),
                ("users_preferences", SqlValue::Text("{}".into())), ("users_created_at", SqlValue::DateTime),
                ("users_updated_at", SqlValue::DateTime),
            ];
            return (row.clone(), vec![row]);
        }
        assert!(sql.contains("'ConnectorConnection'"));
        assert!(sql.contains("namespace = 'system'") && sql.contains("kinds.name = ? AND kinds.user_id = ?"));
        let row = sql_kind("allowed", "ConnectorConnection", json!({"status":"expired","refreshTokenEncrypted":"test-refresh"}));
        (row.clone(), vec![row])
    }).await;
    let mut request = request("Chat");
    request.prompt = json!("write a document");
    attach(&fixture.mysql, &mut request, false).await.unwrap();
    assert_eq!(request.mcp_servers.len(), 1);
    assert_eq!(request.mcp_servers[0]["auth"]["X-Connector-App"], "allowed");
    assert_eq!(
        request.preload_skills,
        vec![json!("wegent-connector-allowed")]
    );
    assert_eq!(fixture.queries().len(), 3);
}
