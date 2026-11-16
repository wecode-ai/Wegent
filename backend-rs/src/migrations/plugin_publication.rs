//! c2f8d4a6b901: retain catalog identities and import safe legacy submissions.

use super::rows::{insert, query, select, string, update};
use brz_mysql::{MysqlError, MysqlResult, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Ddl {
    upgrade: Vec<String>,
    downgrade: Vec<String>,
}

async fn pending(tx: &mut impl MysqlTransaction) -> MysqlResult<Vec<Value>> {
    let rows=query(tx,"SELECT JSON_OBJECT('submission_id',s.id,'plugin_id',s.plugin_id,'release_id',s.release_id,'submitter_user_id',s.submitter_user_id,'review_note',s.review_note,'submitted_at',s.submitted_at,'slug',p.slug,'previous_visibility',p.visibility,'previous_owner_user_id',p.owner_user_id,'version',r.version,'manifest_json',r.manifest_json,'storage_key',r.storage_key,'sha256',r.sha256,'size_bytes',r.size_bytes) AS data FROM plugin_submissions s JOIN plugins p ON p.id=s.plugin_id JOIN plugin_releases r ON r.id=s.release_id WHERE s.purpose='marketplace_publish' AND s.status='pending' AND p.visibility='workspace' AND p.status<>'published' AND p.latest_release_id=0 ORDER BY s.id",()).await?;
    let mut counts = BTreeMap::new();
    for row in &rows {
        *counts.entry(string(&row["plugin_id"])).or_insert(0) += 1;
    }
    Ok(rows
        .into_iter()
        .filter(|r| {
            counts[&string(&r["plugin_id"])] == 1
                && r["sha256"]
                    .as_str()
                    .is_some_and(|s| s.chars().count() == 64)
                && r["storage_key"].as_str().is_some_and(|s| !s.is_empty())
                && r["version"].as_str().is_some_and(|s| !s.is_empty())
        })
        .collect())
}

async fn assert_unique(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    let filter = if down {
        "SELECT JSON_OBJECT('slug',slug,'count',COUNT(*)) AS data FROM plugins GROUP BY slug HAVING COUNT(*)>1"
    } else {
        "SELECT JSON_OBJECT('namespace',catalog_namespace,'slug',slug,'count',COUNT(*)) AS data FROM plugins GROUP BY catalog_namespace,slug HAVING COUNT(*)>1"
    };
    let duplicates = query(tx, filter, ()).await?;
    if !duplicates.is_empty() {
        return Err(MysqlError::InvalidQuery {
            reason: format!(
                "plugin catalog identity conflicts; refusing {}: {}",
                if down { "downgrade" } else { "upgrade" },
                json!(duplicates)
            ),
        });
    }
    Ok(())
}

async fn mark_releases(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    let rows = if down {
        select(
            tx,
            "plugin_releases",
            &["id", "scan_report_json"],
            "1=1",
            (),
        )
        .await?
    } else {
        query(tx,"SELECT JSON_OBJECT('id',r.id,'scan_report_json',r.scan_report_json) AS data FROM plugin_releases r JOIN plugins p ON p.id=r.plugin_id WHERE p.catalog_namespace='enterprise' AND p.status='published' AND r.status='ready'",()).await?
    };
    for row in rows {
        let mut report = row
            .get("scan_report_json")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!({}));
        if down {
            if report["provenance"] != json!({"kind":"legacy_direct_publish"}) {
                continue;
            }
            report.as_object_mut().unwrap().remove("provenance");
        } else {
            if report.get("provenance").is_some() {
                continue;
            }
            report["provenance"] = json!({"kind":"legacy_direct_publish"});
        }
        update(
            tx,
            "plugin_releases",
            &row["id"],
            &json!({"scan_report_json":report}),
        )
        .await?;
    }
    Ok(())
}

async fn import_pending(tx: &mut impl MysqlTransaction, rows: Vec<Value>) -> MysqlResult<()> {
    let risk = json!({"externalNetworkAccess":false,"externalDomains":[],"executesCommands":false,"commandExamples":[],"readsOrWritesLocalFiles":false,"usesCredentials":false,"applicationPermissions":[],"additionalNotes":""});
    for row in rows {
        let time = row
            .get("submitted_at")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!("1970-01-01 00:00:00"));
        let request=insert(tx,"plugin_publication_requests",&json!({"source_plugin_id":row["plugin_id"],"submitter_user_id":row["submitter_user_id"],"current_revision":1,"aggregate_status":"changes_requested","risk_level":"none","submitted_at":time,"created_at":time,"updated_at":time})).await?;
        let revision=insert(tx,"plugin_publication_revisions",&json!({"request_id":request,"revision":1,"source_release_id":row["release_id"],"requested_version":row["version"],"snapshot_sha256":row["sha256"],"source_tree_sha256":"","storage_key":row["storage_key"],"staging_storage_key":"","filename":format!("{}-{}.zip",string(&row["slug"]),string(&row["version"])),"size_bytes":row["size_bytes"],"manifest_snapshot":row.get("manifest_json").filter(|v|!v.is_null()).cloned().unwrap_or(json!({})),"package_entries_json":[],"package_entry_count":0,"capabilities_json":[],"risk_declaration":risk,"release_notes":"","test_notes":"","source_updated_at":"1970-01-01 00:00:00","status":"changes_requested","created_by_user_id":row["submitter_user_id"],"completed_at":time,"created_at":time,"updated_at":time})).await?;
        update(
            tx,
            "plugin_publication_requests",
            &json!(request),
            &json!({"current_revision_id":revision}),
        )
        .await?;
        insert(tx,"plugin_publication_events",&json!({"revision_id":revision,"event_type":"migration.legacy_submission_imported","actor_type":"system","message":"Legacy pending submission imported; create a new revision with the current risk declaration","payload_json":{"submissionId":row["submission_id"],"previousReviewNote":row["review_note"].as_str().unwrap_or(""),"previousPluginVisibility":row["previous_visibility"],"previousPluginOwnerUserId":row["previous_owner_user_id"]},"external_event_id":format!("migration:plugin_submission:{}",string(&row["submission_id"])),"created_at":time})).await?;
        update(tx,"plugin_submissions",&row["submission_id"],&json!({"status":"cancelled","review_note":"Migrated to enterprise publication request"})).await?;
    }
    Ok(())
}

async fn restore_pending(tx: &mut impl MysqlTransaction) -> MysqlResult<()> {
    let rows=query(tx,"SELECT JSON_OBJECT('source_plugin_id',q.source_plugin_id,'payload_json',e.payload_json) AS data FROM plugin_publication_events e JOIN plugin_publication_revisions r ON r.id=e.revision_id JOIN plugin_publication_requests q ON q.id=r.request_id WHERE e.event_type='migration.legacy_submission_imported'",()).await?;
    for row in rows {
        let payload = &row["payload_json"];
        if payload["submissionId"].as_i64().unwrap_or(0) == 0 {
            continue;
        }
        update(tx,"plugin_submissions",&payload["submissionId"],&json!({"status":"pending","review_note":payload["previousReviewNote"].as_str().unwrap_or("")})).await?;
        update(tx,"plugins",&row["source_plugin_id"],&json!({"visibility":payload["previousPluginVisibility"].as_str().filter(|s|!s.is_empty()).unwrap_or("workspace"),"owner_user_id":payload["previousPluginOwnerUserId"].as_i64().unwrap_or(0)})).await?;
    }
    Ok(())
}

pub(super) async fn execute(tx: &mut impl MysqlTransaction, down: bool) -> MysqlResult<()> {
    let ddl: Ddl =
        serde_json::from_str(include_str!("../../migrations/plugin_publication_ddl.json"))
            .expect("checked-in plugin DDL");
    if down {
        // Check before mutation: the old global slug key cannot represent duplicates.
        assert_unique(tx, true).await?;
        restore_pending(tx).await?;
        mark_releases(tx, true).await?;
        for statement in &ddl.downgrade {
            tx.execute(statement, ()).await?;
        }
    } else {
        for statement in &ddl.upgrade[..2] {
            tx.execute(statement, ()).await?;
        }
        let rows = pending(tx).await?;
        for row in &rows {
            let owner = row["previous_owner_user_id"]
                .as_i64()
                .filter(|v| *v != 0)
                .unwrap_or_else(|| row["submitter_user_id"].as_i64().unwrap_or(0));
            update(
                tx,
                "plugins",
                &row["plugin_id"],
                &json!({"visibility":"personal","owner_user_id":owner}),
            )
            .await?;
        }
        tx.execute(&ddl.upgrade[2], ()).await?;
        assert_unique(tx, false).await?;
        mark_releases(tx, false).await?;
        for statement in &ddl.upgrade[3..] {
            tx.execute(statement, ()).await?;
        }
        import_pending(tx, rows).await?;
    }
    Ok(())
}
