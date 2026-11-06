use super::*;
use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value};

fn text(value: &str) -> Value {
    Value::Text(value.to_owned())
}

fn shell(id: i64, owner: i64, namespace: &str) -> Row {
    vec![
        ("kinds_id", Value::I64(id)),
        ("kinds_user_id", Value::I64(owner)),
        ("kinds_kind", text("Shell")),
        ("kinds_name", text("code-go")),
        ("kinds_namespace", text(namespace)),
        ("kinds_json", text(r#"{"spec":{"shellType":"Codex"}}"#)),
        ("kinds_is_active", Value::I8(1)),
        ("kinds_created_at", Value::Null),
        ("kinds_updated_at", Value::Null),
    ]
}

fn scoped(owner: i64, name: &str, namespace: &str, kind: Row) -> Row {
    let mut row = vec![
        ("requested_owner_id", Value::I64(owner)),
        ("requested_name", text(name)),
        ("requested_namespace", text(namespace)),
    ];
    row.extend(kind);
    row
}

fn referenced(target_type: &str, target_id: &str, kind: Row) -> Row {
    let mut row = vec![
        ("resource_members_entity_type", text(target_type)),
        ("resource_members_entity_id", text(target_id)),
    ];
    row.extend(kind);
    row
}

fn public(name: &str, kind: Row) -> Row {
    let mut row = vec![("anon_1_name", text(name))];
    row.extend(kind);
    row
}

fn result(schema: Row, rows: Vec<Row>) -> (Row, Vec<Row>) {
    (schema, rows)
}

fn key(owner: i64, name: &str, namespace: &str) -> ShellKey {
    (owner, name.to_owned(), namespace.to_owned())
}

fn is_scoped(sql: &str) -> bool {
    sql.starts_with("SELECT anon_1.owner_id")
}

fn is_namespace_target(sql: &str) -> bool {
    sql.starts_with("SELECT anon_1.name AS requested_namespace")
}

fn is_reference(sql: &str) -> bool {
    sql.contains("FROM resource_members INNER JOIN kinds")
}

fn assert_reference_policy(sql: &str) {
    assert!(sql.contains("resource_members.status = 'approved'"));
    assert!(sql.contains("resource_members.resource_type = 'Shell'"));
    assert!(sql.contains("kinds.user_id != 0"));
    assert!(sql.contains("kinds.is_active IS true"));
    assert!(sql.ends_with("ORDER BY kinds.id"));
}

#[tokio::test]
async fn many_owners_share_one_public_lookup_in_three_queries() {
    // Fixed query count for both one and many owners; the protocol fixture
    // exercises the actual resolver/SDK, not a real MySQL collation engine.
    for count in [1, 12] {
        let fixture = MysqlRows::start_results(|sql| {
            if is_scoped(sql) {
                assert!(sql.contains("kinds.user_id = anon_1.owner_id"));
                return result(
                    scoped(1, "CODE-GO", "default", shell(1, 1, "default")),
                    vec![],
                );
            }
            if is_reference(sql) {
                assert_reference_policy(sql);
                return result(referenced("user", "1", shell(1, 1, "source")), vec![]);
            }
            assert!(sql.contains("kinds.user_id = 0"));
            // A collation match returns the requested bytes, not Kind.name.
            result(
                public("CODE-GO", shell(90, 0, "default")),
                vec![
                    public("CODE-GO", shell(90, 0, "default")),
                    public("CODE-GO", shell(91, 0, "default")),
                ],
            )
        })
        .await;
        let registry = EntityResolvers::<brz_redis::RedisService>::public(fixture.mysql.clone());
        let refs: Vec<_> = (1..=count)
            .map(|owner| key(owner, "CODE-GO", "default"))
            .collect();

        let resolved = resolve_shells(&fixture.mysql, &registry, None, &refs)
            .await
            .unwrap();

        assert_eq!(resolved.len(), count as usize);
        let first = &resolved[&refs[0]];
        for requested in &refs {
            assert_eq!(resolved[requested].id, 90);
            assert!(Arc::ptr_eq(first, &resolved[requested]));
        }
        let queries = fixture.queries();
        assert_eq!(queries.len(), 3, "{queries:#?}");
        assert_eq!(
            queries[0].matches("SELECT ? AS owner_id").count(),
            count as usize
        );
        assert_eq!(queries[2].matches("SELECT ? AS name").count(), 1);
    }
}

#[tokio::test]
async fn private_and_user_references_do_not_cross_owner_boundaries() {
    let fixture = MysqlRows::start_results(|sql| {
        if is_scoped(sql) {
            assert!(sql.contains("kinds.namespace = anon_1.namespace"));
            assert!(sql.contains("kinds.user_id = anon_1.owner_id"));
            return result(
                scoped(11, "code-go", "default", shell(1, 11, "default")),
                vec![
                    scoped(11, "code-go", "default", shell(1, 11, "default")),
                    scoped(12, "code-go", "default", shell(2, 12, "default")),
                ],
            );
        }
        assert!(is_reference(sql));
        assert_reference_policy(sql);
        // Only the unresolved owner's user target is queried.
        assert!(sql.contains("resource_members.entity_id IN (?)"));
        result(
            referenced("user", "13", shell(3, 99, "source")),
            vec![
                referenced("user", "13", shell(3, 99, "source")),
                referenced("user", "14", shell(4, 99, "source")),
            ],
        )
    })
    .await;
    let registry = EntityResolvers::<brz_redis::RedisService>::public(fixture.mysql.clone());
    let refs = [
        key(11, "code-go", "default"),
        key(12, "code-go", "default"),
        key(13, "code-go", "default"),
    ];

    let resolved = resolve_shells(&fixture.mysql, &registry, None, &refs)
        .await
        .unwrap();

    for (index, requested) in refs.iter().enumerate() {
        assert_eq!(resolved[requested].id, index as i64 + 1);
    }
    assert_eq!(resolved[&refs[2]].namespace, "source");
    assert_eq!(resolved[&refs[2]].user_id, 99);
    assert!(!resolved.contains_key(&key(14, "code-go", "default")));
    assert_eq!(fixture.queries().len(), 2);
}

fn no_membership(sql: &str) -> (Row, Vec<Row>) {
    if sql.starts_with("SELECT namespace.name AS namespace_name") {
        return result(vec![("namespace_name", text("target"))], vec![]);
    }
    if sql.contains("AS resource_id,") {
        return result(
            vec![("resource_id", Value::I64(20)), ("role", text("Developer"))],
            vec![],
        );
    }
    assert!(
        sql.contains("resource_members.resource_type = 'Namespace'"),
        "{sql}"
    );
    result(
        vec![
            ("resource_members_resource_id", Value::I64(20)),
            ("resource_members_entity_id", text("20")),
            ("resource_members_role", text("Developer")),
        ],
        vec![],
    )
}

#[tokio::test]
async fn namespace_references_share_scope_but_match_source_names_exactly() {
    let fixture = MysqlRows::start_results(|sql| {
        if is_scoped(sql) {
            assert!(sql.contains("kinds.user_id = anon_1.owner_id"));
            return result(
                scoped(11, "code-go", "target", shell(1, 11, "target")),
                vec![],
            );
        }
        if is_namespace_target(sql) {
            assert_eq!(sql.matches("SELECT ? AS name").count(), 1);
            let row = vec![
                ("requested_namespace", text("target")),
                ("namespace_id", Value::I64(20)),
            ];
            return result(row.clone(), vec![row]);
        }
        if is_reference(sql) {
            assert_reference_policy(sql);
            assert!(sql.contains("resource_members.entity_id IN (?)"));
            return result(
                referenced("namespace", "20", shell(2, 99, "source")),
                vec![
                    referenced("namespace", "20", shell(2, 99, "source")),
                    referenced("namespace", "21", shell(3, 99, "elsewhere")),
                ],
            );
        }
        if sql.starts_with("SELECT anon_1.name AS anon_1_name") {
            return result(
                public("CODE-GO", shell(90, 0, "default")),
                vec![public("CODE-GO", shell(90, 0, "default"))],
            );
        }
        no_membership(sql)
    })
    .await;
    let registry = EntityResolvers::<brz_redis::RedisService>::public(fixture.mysql.clone());
    let refs = [
        key(11, "code-go", "target"),
        key(12, "code-go", "target"),
        key(13, "CODE-GO", "target"),
    ];

    let resolved = resolve_shells(&fixture.mysql, &registry, None, &refs)
        .await
        .unwrap();

    assert_eq!(resolved[&refs[0]].id, 2);
    assert_eq!(resolved[&refs[0]].namespace, "source");
    assert!(Arc::ptr_eq(&resolved[&refs[0]], &resolved[&refs[1]]));
    // A case-variant reference must miss the exact-name lookup and resolve
    // through public SQL instead; another namespace's reference never leaks.
    assert_eq!(resolved[&refs[2]].id, 90);
    let queries = fixture.queries();
    assert_eq!(
        queries
            .iter()
            .filter(|sql| is_namespace_target(sql))
            .count(),
        1
    );
    assert_eq!(queries.iter().filter(|sql| is_reference(sql)).count(), 1);
    assert_eq!(queries.iter().filter(|sql| is_scoped(sql)).count(), 1);
}

#[tokio::test]
async fn group_rows_are_shared_only_after_each_owners_authorization() {
    for authorized in [false, true] {
        let fixture = MysqlRows::start_results(move |sql| {
            if is_scoped(sql) {
                let owner_only = sql.contains("kinds.user_id = anon_1.owner_id");
                if !owner_only {
                    assert!(
                        authorized,
                        "unauthorized users must not trigger a group read"
                    );
                    assert_eq!(sql.matches("SELECT ? AS owner_id").count(), 1);
                }
                return result(
                    scoped(0, "CODE-GO", "target", shell(3, 99, "target")),
                    if owner_only {
                        vec![]
                    } else {
                        let first = scoped(0, "CODE-GO", "target", shell(3, 99, "target"));
                        let mut discarded = first.clone();
                        discarded
                            .iter_mut()
                            .find(|(name, _)| *name == "kinds_json")
                            .unwrap()
                            .1 = text("invalid JSON must not be decoded for a discarded row");
                        vec![first, discarded]
                    },
                );
            }
            if is_namespace_target(sql) {
                let row = vec![
                    ("requested_namespace", text("target")),
                    ("namespace_id", Value::I64(20)),
                ];
                return result(row.clone(), vec![row]);
            }
            if is_reference(sql) {
                assert_reference_policy(sql);
                return result(
                    referenced("namespace", "20", shell(2, 99, "source")),
                    vec![],
                );
            }
            if sql.starts_with("SELECT anon_1.name AS anon_1_name") {
                assert!(!authorized);
                return result(
                    public("CODE-GO", shell(90, 0, "default")),
                    vec![public("CODE-GO", shell(90, 0, "default"))],
                );
            }
            if !authorized {
                return no_membership(sql);
            }
            if sql.starts_with("SELECT namespace.name AS namespace_name") {
                let row = vec![("namespace_name", text("target"))];
                return result(row.clone(), vec![row]);
            }
            if sql.contains("AS resource_id,") {
                let row = vec![("resource_id", Value::I64(20)), ("role", text("Developer"))];
                return result(row.clone(), vec![row]);
            }
            if sql.contains("FROM namespace") {
                let row = vec![
                    ("namespace_id", Value::I64(20)),
                    ("namespace_name", text("target")),
                ];
                return result(row.clone(), vec![row]);
            }
            no_membership(sql)
        })
        .await;
        let registry = EntityResolvers::<brz_redis::RedisService>::public(fixture.mysql.clone());
        let refs = [key(11, "CODE-GO", "target"), key(12, "CODE-GO", "target")];

        let resolved = resolve_shells(&fixture.mysql, &registry, None, &refs)
            .await
            .unwrap();

        assert_eq!(resolved[&refs[0]].id, if authorized { 3 } else { 90 });
        assert!(Arc::ptr_eq(&resolved[&refs[0]], &resolved[&refs[1]]));
        let queries = fixture.queries();
        assert_eq!(
            queries
                .iter()
                .filter(|sql| sql.starts_with("SELECT namespace.name AS namespace_name"))
                .count(),
            1,
            "active namespaces must be shared across owners"
        );
        assert_eq!(
            queries.iter().filter(|sql| is_scoped(sql)).count(),
            if authorized { 2 } else { 1 }
        );
        // Each owner goes through the existing membership policy, even
        // though their authorized group Shell candidate query is shared.
        assert_eq!(
            queries
                .iter()
                .filter(|sql| sql.contains("AS resource_id,"))
                .count(),
            2
        );
    }
}

#[tokio::test]
async fn empty_shell_batch_does_not_query_mysql() {
    let fixture = MysqlRows::start_results(|sql| panic!("unexpected query: {sql}")).await;
    let registry = EntityResolvers::<brz_redis::RedisService>::public(fixture.mysql.clone());
    assert!(
        resolve_shells(&fixture.mysql, &registry, None, &[])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(fixture.queries().is_empty());
}
