use super::*;
use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value as SqlValue};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn user() -> UserRow {
    UserRow {
        users_id: 7,
        users_user_name: "identity-test".into(),
        users_password_hash: "unused".into(),
        users_email: None,
        users_git_info: None,
        users_is_active: true,
        users_role: "user".into(),
        users_auth_source: "test".into(),
        users_preferences: "{}".into(),
        users_created_at: Default::default(),
        users_updated_at: Default::default(),
    }
}

fn sql_row(slug: &str, spec: Value) -> Row {
    vec![
        ("kinds_id", SqlValue::I64(1)),
        ("kinds_user_id", SqlValue::I64(0)),
        ("kinds_kind", SqlValue::Text("ConnectorApp".into())),
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
async fn listing_and_real_http_calls_route_colliding_identities_and_enforce_scope() {
    for only_target in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (requests_tx, mut requests_rx) = tokio::sync::mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0; 1024];
                while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = stream.read(&mut chunk).await.unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&chunk[..count]);
                }
                let request = String::from_utf8(bytes).unwrap();
                requests_tx
                    .send(request.lines().next().unwrap().to_string())
                    .unwrap();
                stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{\"ok\":true}").await.unwrap();
            }
        });
        let targets: Vec<_> = [
            ("reports", "archive__lookup"),
            ("reports__archive", "lookup"),
        ]
        .into_iter()
        .filter(|(slug, _)| !only_target || *slug == "reports__archive")
        .collect();
        let rows: Vec<_> = targets
            .iter()
            .map(|(slug, raw)| {
                sql_row(
                    slug,
                    json!({
                        "authType":"none", "transport":"http", "mcpUrl":base, "toolAllowlist":[raw],
                        "httpTools":[{"name":raw,"method":"GET","path":format!("/{slug}/{raw}")}]
                    }),
                )
            })
            .collect();
        let fixture = MysqlRows::start_results(move |sql| {
            assert!(
                sql.contains("'ConnectorApp'")
                    && sql.contains("user_id = 0")
                    && sql.contains("namespace = 'system'")
            );
            (rows[0].clone(), rows.clone())
        })
        .await;
        let user = user();
        let catalog: Vec<_> = db::list_connector_app_kinds(&fixture.mysql)
            .await
            .unwrap()
            .iter()
            .map(service::row_to_app)
            .collect();
        let tools = list_tools_for_user(&fixture.mysql, &catalog, &user).await;
        assert_eq!(tools.len(), targets.len());
        for (slug, raw) in &targets {
            let name = wegent_protocol::connector::qualify_tool(slug, raw);
            assert!(tools.iter().any(|tool| tool["name"] == name));
            let result = call_tool_for_user(
                &fixture.mysql,
                &user,
                Some(slug),
                Some(&json!({"name":name,"arguments":{}})),
            )
            .await;
            assert_eq!(result["isError"], false, "{result}");
            assert_eq!(
                requests_rx.recv().await.unwrap(),
                format!("GET /{slug}/{raw} HTTP/1.1")
            );
        }
        let name = wegent_protocol::connector::qualify_tool("reports__archive", "lookup");
        let result = call_tool_for_user(
            &fixture.mysql,
            &user,
            Some("reports"),
            Some(&json!({"name":name})),
        )
        .await;
        assert_eq!(result["isError"], true);
        assert!(
            result["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("outside")
        );
        assert!(requests_rx.try_recv().is_err());
        server.abort();
    }
}

#[tokio::test]
async fn shared_lazy_surface_enforces_current_visibility_and_grants_without_upstream_discovery() {
    let fixture = MysqlRows::start_results(|sql| {
        assert!(sql.contains("'ConnectorConnection'") && sql.contains("user_id = ?"));
        let row = sql_row("unused", json!({}));
        (row, vec![])
    })
    .await;
    let mut allowed = super::tests::app("reports__archive", "lazy");
    allowed.auth_type = "none".into();
    let mut hidden = super::tests::app("hidden", "lazy");
    hidden.auth_type = "none".into();
    hidden.visibility = "roles".into();
    hidden.allowed_roles = vec!["admin".into()];
    let pending = super::tests::app("pending", "lazy");
    let mut disabled = allowed.clone();
    disabled.slug = "disabled".into();
    disabled.enabled = false;
    let apps = [allowed, hidden, pending, disabled];
    let tools = deferred_tools_for_user(&fixture.mysql, &apps, &user(), None).await;
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["name"], "_wegent_discover__reports__archive");
    assert_eq!(tools[1]["name"], "_wegent_call__reports__archive");
    assert!(
        deferred_tools_for_user(&fixture.mysql, &apps, &user(), Some("reports"))
            .await
            .is_empty()
    );
}

#[test]
fn discovery_keeps_the_raw_name_even_when_it_resembles_a_qualified_name() {
    let raw = "reports__archive__lookup";
    let mut tools =
        vec![json!({"name": wegent_protocol::connector::qualify_tool("reports__archive", raw)})];
    add_upstream_names(&mut tools);
    assert_eq!(tools[0]["rawToolName"], raw);
}
