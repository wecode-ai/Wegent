// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use brz_json::OpaqueJson;
use brz_mysql::Json;
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution};

#[derive(Default)]
struct BatchTransaction {
    reads: Vec<(String, Option<i64>)>,
    writes: Vec<String>,
    payloads: Vec<Value>,
    rows_affected: Option<u64>,
}

impl MysqlTransaction for BatchTransaction {
    async fn execute<S, A>(&mut self, sql: S, args: A) -> MysqlResult<MysqlExecution>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
    {
        let rows_affected = self
            .rows_affected
            .expect("an empty batch has no installation writes");
        assert_eq!(args.len(), 5);
        self.writes.push(sql.as_ref().to_string());
        let payload = args.first_route_value().unwrap().as_str().unwrap();
        self.payloads.push(serde_json::from_str(payload).unwrap());
        Ok(MysqlExecution {
            rows_affected,
            last_insert_id: 0,
        })
    }

    async fn fetch_optional<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Option<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_optional")
    }

    async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        panic!("unexpected fetch_one")
    }

    async fn fetch_all<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.reads.push((
            sql.as_ref().to_string(),
            args.first_route_value()
                .and_then(|value| value.as_i64().ok()),
        ));
        Ok(Vec::new())
    }

    fn fetch<'a, S, A, T>(
        &'a mut self,
        _: S,
        _: A,
    ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
    where
        S: AsRef<str> + Send + 'a,
        A: MysqlArgs + Send + 'a,
        T: FromMysqlRow + Send + 'a,
    {
        futures_util::stream::once(async { panic!("unexpected streaming query") })
    }
}

#[tokio::test]
async fn installation_snapshot_is_scoped_and_uses_no_locking_read() {
    let mut transaction = BatchTransaction::default();
    list_installed_kinds(&mut transaction, 2095).await.unwrap();
    assert_eq!(transaction.reads.len(), 1);
    let (sql, user_id) = &transaction.reads[0];
    assert_eq!(*user_id, Some(2095));
    for scope in [
        "kinds.user_id = ?",
        "kinds.kind = 'InstalledPlugin'",
        "kinds.namespace = 'default'",
        "kinds.is_active IS true",
        "ORDER BY kinds.id ASC",
    ] {
        assert!(sql.contains(scope), "missing installation scope: {scope}");
    }
    assert!(!sql.contains("FOR UPDATE"));
}

#[tokio::test]
async fn no_eligible_installations_skip_catalog_and_permission_dependencies() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let registry = EntityResolvers::public(
        brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").unwrap(),
    );
    let catalog = load_auto_update_catalog(
        &mysql,
        None::<&brz_redis::RedisService>,
        &registry,
        2095,
        &[],
    )
    .await
    .unwrap();
    assert!(catalog.is_none());
    assert!(mysql.queries().is_empty());
    assert!(mysql.writes().is_empty());
}

fn installed_with_revision(revision: Option<Value>) -> InstalledKindRow {
    let mut spec = serde_json::json!({"enabled": false});
    if let Some(revision) = revision {
        spec["revision"] = revision;
    }
    InstalledKindRow {
        id: 42,
        user_id: 2095,
        kind: "InstalledPlugin".to_string(),
        name: "demo".to_string(),
        namespace: "default".to_string(),
        json: Json(OpaqueJson::from_serializable(
            serde_json::json!({"spec": spec}),
        )),
        is_active: true,
        created_at: chrono::Utc::now().naive_utc(),
        updated_at: chrono::Utc::now().naive_utc(),
    }
}

#[tokio::test]
async fn installation_cas_rejects_a_concurrent_change() {
    let mut transaction = BatchTransaction {
        rows_affected: Some(0),
        ..Default::default()
    };
    let error = advance_installation(
        &mut transaction,
        &installed_with_revision(Some(Value::from(6))),
        serde_json::json!({"spec": {"releaseId": 2, "enabled": false}}),
        2095,
    )
    .await
    .unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_conflict")
    );
    assert_eq!(transaction.payloads[0]["spec"]["revision"], 7);
    assert!(
        transaction.writes[0].contains("COALESCE(JSON_EXTRACT(json, '$.spec.revision'), 0) = ?")
    );
    assert!(!transaction.writes[0].contains("FOR UPDATE"));
}

#[tokio::test]
async fn legacy_installation_cas_adds_revision_without_changing_preferences() {
    let mut transaction = BatchTransaction {
        rows_affected: Some(1),
        ..Default::default()
    };
    advance_installation(
        &mut transaction,
        &installed_with_revision(None),
        serde_json::json!({"spec": {"releaseId": 2, "enabled": false}}),
        2095,
    )
    .await
    .unwrap();
    assert_eq!(
        transaction.payloads[0],
        serde_json::json!({
            "spec": {"releaseId": 2, "enabled": false, "revision": 1}
        })
    );
}

#[test]
fn marketplace_name_matches_source_mapping() {
    assert_eq!(
        marketplace_name_for_visibility("personal"),
        "wework-personal"
    );
    assert_eq!(marketplace_name_for_visibility("public"), "wework");
    assert_eq!(marketplace_name_for_visibility("workspace"), "wegent");
    assert_eq!(marketplace_name_for_visibility(""), "wegent");
}

#[test]
fn kind_name_matches_source_digest() {
    // sha256("enterprise:example-agent")[:10].
    let digest = Sha256::digest(b"enterprise:example-agent");
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let expected = format!("example-agent-{}", &hex[..10]);
    assert_eq!(kind_name("enterprise", "example-agent"), expected);
}

#[test]
fn component_states_uses_source_prefixes() {
    let components = serde_json::json!({
        "skills": [{"name": "demo"}, {"name": ""}, {}],
        "mcps": [{"name": "srv"}],
    });
    let states = component_states(&components);
    assert_eq!(states["skill:demo"], Value::Bool(true));
    assert_eq!(states["mcp:srv"], Value::Bool(true));
    assert!(states.get("skill:").is_none());
}

#[test]
fn empty_batch_serializes_source_shape() {
    let body = serde_json::to_string(&PluginAutoUpdateBatchResponse::empty()).unwrap();
    assert_eq!(
        body,
        r#"{"updated":[],"updatedCount":0,"remainingCount":0}"#
    );
}

#[test]
fn eligible_rows_require_marketplace_auto_and_integer_ids() {
    let make = |spec: Value| InstalledKindRow {
        id: 1,
        user_id: 157,
        kind: "InstalledPlugin".to_string(),
        name: "n".to_string(),
        namespace: "default".to_string(),
        json: Json(OpaqueJson::from_serializable(
            serde_json::json!({ "spec": spec }),
        )),
        is_active: true,
        created_at: chrono::Utc::now().naive_utc(),
        updated_at: chrono::Utc::now().naive_utc(),
    };
    let eligible = make(serde_json::json!({
        "source": {"type": "marketplace"},
        "updatePolicy": "auto",
        "pluginId": 17,
        "releaseId": 129,
    }));
    let manual = make(serde_json::json!({
        "source": {"type": "marketplace"},
        "updatePolicy": "manual",
        "pluginId": 17,
        "releaseId": 129,
    }));
    let upload = make(serde_json::json!({
        "source": {"type": "upload"},
        "updatePolicy": "auto",
        "pluginId": 17,
        "releaseId": 129,
    }));
    let string_id = make(serde_json::json!({
        "source": {"type": "marketplace"},
        "updatePolicy": "auto",
        "pluginId": "17",
        "releaseId": 129,
    }));
    let rows = vec![eligible, manual, upload, string_id];
    let selected = eligible_rows(&rows);
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].plugin_id, 17);
    assert_eq!(selected[0].release_id, 129);
}

#[tokio::test]
async fn missing_redis_rejects_before_reading_or_writing_installations() {
    let registry = EntityResolvers::public(
        brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").unwrap(),
    );
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let error = auto_update_batch(&mysql, None::<&brz_redis::RedisService>, &registry, 2095)
        .await
        .unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_unavailable")
    );
    assert!(mysql.queries().is_empty());
    assert!(mysql.writes().is_empty());
}

fn auto_installation(plugin_id: i64) -> InstalledKindRow {
    let mut row = installed_with_revision(Some(Value::from(0)));
    row.id = 100 + plugin_id;
    row.name = format!("plugin-{plugin_id}");
    row.json = Json(OpaqueJson::from_serializable(serde_json::json!({
        "spec": {
            "source": {"type": "marketplace"},
            "pluginId": plugin_id,
            "releaseId": plugin_id * 10 + 1,
            "updatePolicy": "auto",
            "enabled": false,
            "componentStates": {"skill:old": false},
            "revision": 0,
        }
    })));
    row
}

fn plugin_row(id: i64) -> PluginRow {
    PluginRow {
        id,
        catalog_namespace: "enterprise".into(),
        slug: format!("plugin-{id}"),
        name: format!("plugin-{id}"),
        display_name: "Plugin".into(),
        summary: "summary".into(),
        description_md: String::new(),
        listing_type: "plugin".into(),
        source_type: "native".into(),
        source_provider: "wework".into(),
        owner_user_id: 42,
        origin_plugin_id: 0,
        category: String::new(),
        keywords_json: Json(OpaqueJson::from_serializable(serde_json::json!([]))),
        interface_json: Json(OpaqueJson::from_serializable(serde_json::json!({}))),
        visibility: "public".into(),
        allow_copy: false,
        status: "published".into(),
        latest_release_id: id * 10 + 2,
        featured_rank: 0,
        created_at: chrono::NaiveDateTime::default(),
        updated_at: chrono::NaiveDateTime::default(),
        published_at: chrono::NaiveDateTime::default(),
    }
}

fn release_row(id: i64, plugin_id: i64) -> PluginReleaseRow {
    PluginReleaseRow {
        id,
        plugin_id,
        version: "2.0.0".into(),
        manifest_json: Json(OpaqueJson::from_serializable(serde_json::json!({}))),
        interface_json: Json(OpaqueJson::from_serializable(serde_json::json!({}))),
        release_notes: String::new(),
        storage_key: format!("plugin-{plugin_id}/{id}.zip"),
        sha256: "abc".into(),
        size_bytes: 64,
        status: "ready".into(),
        scan_status: "passed".into(),
        scan_report_json: Json(OpaqueJson::from_serializable(serde_json::json!({
            "components": {"skills": [{"name": "new"}]}
        }))),
        created_by_user_id: 42,
        publication_revision_id: 0,
        source_commit_sha: String::new(),
        created_at: chrono::NaiveDateTime::default(),
        published_at: chrono::NaiveDateTime::default(),
    }
}

fn catalog_for(plugin_ids: &[i64]) -> AutoUpdateCatalog {
    let mut catalog = AutoUpdateCatalog {
        plugins_by_id: HashMap::new(),
        releases_by_id: HashMap::new(),
        grants_by_plugin_id: HashMap::new(),
        access_context: None,
    };
    for &plugin_id in plugin_ids {
        catalog
            .plugins_by_id
            .insert(plugin_id, plugin_row(plugin_id));
        for release_id in [plugin_id * 10 + 1, plugin_id * 10 + 2] {
            catalog
                .releases_by_id
                .insert(release_id, release_row(release_id, plugin_id));
        }
    }
    catalog
}

#[test]
fn candidate_selection_requires_access_and_a_valid_new_release() {
    for (case, expected) in [
        ("ready", true),
        ("private_without_access", false),
        ("private_owner", true),
        ("workspace", true),
        ("unpublished", false),
        ("no_latest_release", false),
        ("already_current", false),
        ("missing_plugin", false),
        ("missing_release", false),
        ("current_release_wrong_plugin", false),
        ("latest_release_wrong_plugin", false),
        ("latest_release_not_ready", false),
        ("latest_release_not_scanned", false),
    ] {
        let installed = [auto_installation(1)];
        let eligible = eligible_rows(&installed);
        let mut catalog = catalog_for(&[1]);
        let plugin = catalog.plugins_by_id.get_mut(&1).unwrap();
        match case {
            "private_without_access" => plugin.visibility = "personal".into(),
            "private_owner" => {
                plugin.visibility = "personal".into();
                plugin.owner_user_id = 2095;
            }
            "workspace" => plugin.visibility = "workspace".into(),
            "unpublished" => plugin.status = "draft".into(),
            "no_latest_release" => plugin.latest_release_id = 0,
            "already_current" => plugin.latest_release_id = 11,
            "missing_plugin" => {
                catalog.plugins_by_id.clear();
            }
            "missing_release" => {
                catalog.releases_by_id.remove(&12);
            }
            "current_release_wrong_plugin" => {
                catalog.releases_by_id.get_mut(&11).unwrap().plugin_id = 2;
            }
            "latest_release_wrong_plugin" => {
                catalog.releases_by_id.get_mut(&12).unwrap().plugin_id = 2;
            }
            "latest_release_not_ready" => {
                catalog.releases_by_id.get_mut(&12).unwrap().status = "pending".into();
            }
            "latest_release_not_scanned" => {
                catalog.releases_by_id.get_mut(&12).unwrap().scan_status = "failed".into();
            }
            "ready" => {}
            _ => unreachable!(),
        }
        let selected = candidates(
            &eligible,
            &catalog.plugins_by_id,
            &catalog.releases_by_id,
            2095,
            &catalog.grants_by_plugin_id,
            catalog.access_context.as_ref(),
        );
        assert_eq!(!selected.is_empty(), expected, "{case}");
    }
}

#[test]
fn advancing_a_release_preserves_runtime_preferences_and_legacy_defaults() {
    let plugin = plugin_row(1);
    let release = release_row(12, 1);
    for policy in ["auto", "manual", "invalid"] {
        let current = InstalledSpec {
            enabled: Some(Value::Bool(false)),
            component_states: Some(serde_json::json!({"skill:old": false})),
            update_policy: Some(policy.into()),
            ..Default::default()
        };
        let payload = installed_payload(&plugin, &release, &current);
        assert_eq!(payload["spec"]["enabled"], false);
        assert_eq!(
            payload["spec"]["componentStates"],
            current.component_states.unwrap()
        );
        assert_eq!(
            payload["spec"]["updatePolicy"],
            if policy == "manual" { "manual" } else { "auto" }
        );
        assert_eq!(payload["spec"]["releaseId"], 12);
        assert_eq!(payload["spec"]["version"], "2.0.0");
    }
    let payload = installed_payload(&plugin, &release, &InstalledSpec::default());
    assert_eq!(payload["spec"]["enabled"], true);
    assert_eq!(payload["spec"]["componentStates"], serde_json::json!({}));
    assert_eq!(payload["spec"]["updatePolicy"], "auto");
}

#[tokio::test]
async fn successive_bounded_batches_drain_candidates_without_repeating_updates() {
    let catalog = catalog_for(&[1, 2, 3]);
    let mut installed = vec![
        auto_installation(1),
        auto_installation(2),
        auto_installation(3),
    ];
    for remaining in [2, 1, 0] {
        let mut transaction = BatchTransaction {
            rows_affected: Some(1),
            ..Default::default()
        };
        let response = apply_auto_update_batch(&mut transaction, &catalog, &installed, 2095)
            .await
            .unwrap();
        assert_eq!(response.updated_count, 1);
        assert_eq!(response.updated.len(), 1);
        assert_eq!(response.remaining_count, remaining);
        assert_eq!(transaction.writes.len(), 1);
        assert!(transaction.reads.is_empty());
        let item = &response.updated[0];
        assert_eq!(item.to_release_id, item.plugin_id * 10 + 2);
        assert_eq!(item.from_release_id, item.plugin_id * 10 + 1);
        let payload = transaction.payloads.pop().unwrap();
        assert_eq!(payload["spec"]["revision"], 1);
        assert_eq!(payload["spec"]["enabled"], false);
        assert_eq!(
            payload["spec"]["componentStates"],
            serde_json::json!({"skill:old": false})
        );
        installed
            .iter_mut()
            .find(|row| row.id == item.installed_plugin_id)
            .unwrap()
            .json = Json(OpaqueJson::from_serializable(payload));
    }
    let mut transaction = BatchTransaction::default();
    let response = apply_auto_update_batch(&mut transaction, &catalog, &installed, 2095)
        .await
        .unwrap();
    assert_eq!(response.updated_count, 0);
    assert_eq!(response.remaining_count, 0);
    assert!(transaction.writes.is_empty());
    assert!(transaction.reads.is_empty());
}
