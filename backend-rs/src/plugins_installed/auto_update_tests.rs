// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use brz_json::OpaqueJson;
use brz_mysql::Json;
use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution};

#[derive(Default)]
struct BatchTransaction {
    reads: Vec<String>,
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

    async fn fetch_all<S, A, T>(&mut self, sql: S, _: A) -> MysqlResult<Vec<T>>
    where
        S: AsRef<str> + Send,
        A: MysqlArgs + Send,
        T: FromMysqlRow + Send,
    {
        self.reads.push(sql.as_ref().to_string());
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
async fn batch_apply_uses_only_its_pinned_transaction_and_preloaded_catalog() {
    // The apply interface receives no pool or resolver. It cannot acquire a
    // second connection while holding the pinned write transaction.
    let mut transaction = BatchTransaction::default();
    let response = apply_auto_update_batch(&mut transaction, None, 2095)
        .await
        .unwrap();
    assert_eq!(response.updated_count, 0);
    assert_eq!(response.remaining_count, 0);
    assert_eq!(transaction.reads.len(), 1);
    assert!(transaction.reads[0].contains("kinds.user_id = ?"));
    assert!(!transaction.reads[0].contains("FOR UPDATE"));
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
    // sha256("enterprise:weibo-miniapp-h5-develop-agent")[:10].
    let digest = Sha256::digest(b"enterprise:weibo-miniapp-h5-develop-agent");
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let expected = format!("weibo-miniapp-h5-develop-agent-{}", &hex[..10]);
    assert_eq!(
        kind_name("enterprise", "weibo-miniapp-h5-develop-agent"),
        expected
    );
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
    let registry = || {
        let mut registry = EntityResolvers::public(
            brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").unwrap(),
        );
        registry.register("org_department", NoopResolver);
        registry
    };
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let error = auto_update_batch(&mysql, None::<&brz_redis::RedisService>, &registry(), 2095)
        .await
        .unwrap_err();
    assert_eq!(
        http_error(error).detail_message(),
        Some("plugin_write_unavailable")
    );
    assert!(mysql.queries().is_empty());
    assert!(mysql.writes().is_empty());
}

/// A resolver that matches no bindings, so the full candidate pass with
/// eligible rows still finds no updatable candidate (public plugins are
/// accessible but their latest release already matches the recorded
/// fixtures' semantics is irrelevant here: the capture returns no rows at
/// all, so `_load_auto_update_catalog` yields nothing and the batch is
/// empty).
struct NoopResolver;

#[async_trait::async_trait]
impl<R: brz_redis::Redis> crate::permissions::EntityResolver<R> for NoopResolver {
    async fn match_bindings(
        &self,
        _: &crate::permissions::EntityResolvers<R>,
        _: Option<&R>,
        _: i64,
        _: &[String],
        _: crate::permissions::ResolutionPurpose,
    ) -> MysqlResult<Vec<String>> {
        Ok(Vec::new())
    }

    async fn get_resource_ids_by_entity(
        &self,
        _: &crate::permissions::EntityResolvers<R>,
        _: &brz_mysql::MysqlService,
        _: Option<&R>,
        _: i64,
        _: &str,
        _: &str,
    ) -> MysqlResult<Vec<i64>> {
        Ok(Vec::new())
    }
}
