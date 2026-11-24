// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use wegent_access::permissions::EntityResolvers;
use wegent_backend_test_support::mysql_rows::{MysqlRows, Row, Value as SqlValue};

fn fixture_row(sql: &str, owner_id: i64) -> Row {
    if sql.contains("FROM kinds") {
        return vec![
            ("kinds_id", SqlValue::I64(7)),
            ("kinds_user_id", SqlValue::I64(owner_id)),
            ("kinds_namespace", SqlValue::Text("default".into())),
            (
                "kinds_json",
                SqlValue::Text(json!({"spec": {"name": "Selected knowledge"}}).to_string()),
            ),
            ("kinds_created_at", SqlValue::DateTime),
            ("kinds_updated_at", SqlValue::DateTime),
        ];
    }
    if sql.contains("FROM users") {
        return vec![("users_role", SqlValue::Text("user".into()))];
    }
    vec![]
}

#[tokio::test]
async fn initial_binding_uses_the_current_users_knowledge_access() {
    for (owner_id, expected) in [(42, 1), (99, 0)] {
        let fixture = MysqlRows::start_results(move |sql| {
            let row = fixture_row(sql, owner_id);
            if row.is_empty() {
                (vec![("empty", SqlValue::I8(0))], vec![])
            } else {
                (row.clone(), vec![row])
            }
        })
        .await;
        let resolvers = EntityResolvers::public(fixture.mysql.clone());
        let acl = AclContextSource::new(&fixture.mysql, &resolvers, None);
        let refs = build_initial_task_knowledge_base_refs(
            &acl,
            (42, "current-user"),
            Some(7),
            "2026-11-13T16:58:05",
        )
        .await
        .unwrap();
        assert_eq!(refs.len(), expected);
        if expected == 1 {
            assert_eq!(
                refs,
                vec![json!({
                    "id": 7, "name": "Selected knowledge", "boundBy": "current-user",
                    "boundAt": "2026-11-13T16:58:05",
                })]
            );
        }
    }
}

#[tokio::test]
async fn initial_binding_uses_the_kind_name_when_the_spec_has_no_name() {
    let fixture = MysqlRows::start_results(|sql| {
        let row = if sql.starts_with("SELECT name FROM kinds") {
            vec![("name", SqlValue::Text("Stored knowledge name".into()))]
        } else {
            let mut row = fixture_row(sql, 42);
            if let Some((_, document)) = row.iter_mut().find(|(name, _)| *name == "kinds_json") {
                *document = SqlValue::Text(json!({"spec": {}}).to_string());
            }
            row
        };
        if row.is_empty() {
            (vec![("empty", SqlValue::I8(0))], vec![])
        } else {
            (row.clone(), vec![row])
        }
    })
    .await;
    let resolvers = EntityResolvers::public(fixture.mysql.clone());
    let acl = AclContextSource::new(&fixture.mysql, &resolvers, None);
    let refs = build_initial_task_knowledge_base_refs(&acl, (42, "user"), Some(7), "now")
        .await
        .unwrap();
    assert_eq!(refs[0]["name"], "Stored knowledge name");
}

#[tokio::test]
async fn absent_or_missing_initial_knowledge_base_has_no_binding() {
    let fixture = MysqlRows::start_results(|_| (vec![("empty", SqlValue::I8(0))], vec![])).await;
    let resolvers = EntityResolvers::public(fixture.mysql.clone());
    let acl = AclContextSource::new(&fixture.mysql, &resolvers, None);
    assert!(
        build_initial_task_knowledge_base_refs(&acl, (42, "user"), None, "now")
            .await
            .unwrap()
            .is_empty()
    );
    assert!(fixture.queries().is_empty());
    assert!(
        build_initial_task_knowledge_base_refs(&acl, (42, "user"), Some(7), "now")
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(fixture.queries().len(), 1);
}
