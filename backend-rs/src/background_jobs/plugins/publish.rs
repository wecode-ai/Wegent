// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Publication preserves review policy, immutable versions and administrator copy.

use super::{
    Upstream,
    package::{self, Package},
    storage::Storage,
};
use crate::AppState;
use anyhow::{Result, bail};
use brz_mysql::{FromMysqlRow, Json, MysqlError, MysqlResult, MysqlTransaction};
use brz_redis::Redis;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};

#[derive(FromMysqlRow)]
struct Plugin {
    id: i64,
    latest_release_id: i64,
    name: String,
    display_name: String,
    summary: String,
    description_md: String,
    category: String,
}
#[derive(FromMysqlRow)]
struct Release {
    id: i64,
    version: String,
    storage_key: String,
    sha256: String,
    status: String,
    scan_status: String,
    scan_report_json: Json<Value>,
    manifest_json: Json<Value>,
    interface_json: Json<Value>,
}
const RELEASE: &str = "id,version,storage_key,sha256,status,scan_status,scan_report_json,manifest_json,interface_json";
fn invalid(error: impl std::fmt::Display) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: error.to_string(),
    }
}

pub async fn store(state: &Arc<AppState>, upstream: &Upstream, parsed: &Package) -> Result<()> {
    let storage = Storage::new()?;
    let digest = format!("{:x}", Sha256::digest(&parsed.bytes));
    let mut created = None;
    let outcome=state.mysql.with_transaction(async|tx|{
        let current:Option<Upstream>=tx.fetch_optional(format!("SELECT {} FROM plugin_upstreams WHERE id=? AND sync_enabled=1 FOR UPDATE",super::COLUMNS),(upstream.id,)).await?;
        let current=current.ok_or(MysqlError::RowNotFound)?;
        if current.upstream_url!=upstream.upstream_url||current.remote_plugin_id!=upstream.remote_plugin_id||current.plugin_id!=upstream.plugin_id{return Err(invalid("Upstream configuration changed during download"))}
        let plugin:Plugin=tx.fetch_one("SELECT id,latest_release_id,name,display_name,summary,description_md,category FROM plugins WHERE id=? FOR UPDATE",(current.plugin_id,)).await?;
        let latest:Option<Release>=if plugin.latest_release_id!=0{tx.fetch_optional(format!("SELECT {RELEASE} FROM plugin_releases WHERE id=?"),(plugin.latest_release_id,)).await?}else{None};
        let existing:Option<Release>=tx.fetch_optional(format!("SELECT {RELEASE} FROM plugin_releases WHERE plugin_id=? AND version=? FOR UPDATE"),(plugin.id,parsed.version.as_str())).await?;
        let newer=latest.as_ref().map(|latest|newer(parsed.version.as_str(),&latest.version)).transpose().map_err(invalid)?.unwrap_or(true);
        let mut promoted=None;
        if let Some(existing)=existing{
            if existing.sha256!=digest{
                let old=storage.get(&existing.storage_key).await.map_err(invalid)?;let next=parsed.bytes.clone();
                let equivalent=tokio::task::spawn_blocking(move||package::equivalent(&old,&next)).await.map_err(invalid)?.map_err(invalid)?;
                if !equivalent{return Err(invalid("Upstream version changed content without a version bump"))}
            }
            if current.sync_policy=="auto_after_scan"&&newer&&existing.status=="processing"{
                let updated=tx.execute("UPDATE plugin_submissions SET status='approved',review_note='Automatically published after scan policy change',reviewed_at=NOW() WHERE plugin_id=? AND release_id=? AND status='pending'",(plugin.id,existing.id)).await?;
                if updated.rows_affected==0{return Err(invalid("Pending mirrored release has no review submission"))}
                finalize(tx,&plugin,&existing,latest.as_ref()).await?;promoted=Some((existing.id,existing.version));
            }
        }else if newer{
            let report=json!({"components":parsed.components,"listing":{"name":parsed.name,"displayName":parsed.display,"summary":parsed.description.chars().take(500).collect::<String>(),"descriptionMd":parsed.description},"checks":["zip_paths","manifest","checksum","package_size","expanded_size","sensitive_files"],"provenance":{"kind":"upstream","provider":current.provider,"marketplace":current.marketplace_name,"remotePluginId":current.remote_plugin_id,"upstreamUrl":current.upstream_url}});
            let mut report=report;for(key,value)in parsed.scan.as_object().expect("scan object"){report[key]=value.clone();}
            let insert=tx.execute("INSERT INTO plugin_releases(plugin_id,version,manifest_json,interface_json,storage_key,sha256,size_bytes,status,scan_status,scan_report_json,created_by_user_id,publication_revision_id,source_commit_sha,created_at,published_at) VALUES(?,?,?,?,'pending',?,?,'processing','passed',?,0,0,'',NOW(),'1970-01-01 00:00:00')",(plugin.id,parsed.version.as_str(),Json(&parsed.manifest),Json(&parsed.interface),digest.as_str(),parsed.bytes.len() as i64,Json(&report))).await?;
            let id=insert.last_insert_id as i64;let key=format!("plugins/{}/{id}/{digest}.zip",plugin.id);
            if storage.put(&key,&parsed.bytes).await.map_err(invalid)?{created=Some(key.clone());}
            tx.execute("UPDATE plugin_releases SET storage_key=? WHERE id=?",(key.as_str(),id)).await?;
            let release=Release{id,version:parsed.version.clone(),storage_key:key,sha256:digest.clone(),status:"processing".into(),scan_status:"passed".into(),scan_report_json:Json(report),manifest_json:Json(parsed.manifest.clone()),interface_json:Json(parsed.interface.clone())};
            if current.sync_policy=="review_required"{
                tx.execute("INSERT INTO plugin_submissions(plugin_id,release_id,submitter_user_id,purpose,status,reviewer_user_id,review_note,submitted_at,reviewed_at) VALUES(?,?,0,'marketplace_publish','pending',0,'',NOW(),'1970-01-01 00:00:00')",(plugin.id,id)).await?;
                tx.execute("UPDATE plugins SET status=IF(status IN ('published','unpublished'),status,'pending_review'),updated_at=NOW() WHERE id=?",(plugin.id,)).await?;
            }else{finalize(tx,&plugin,&release,latest.as_ref()).await?;promoted=Some((id,parsed.version.clone()));}
        }
        tx.execute("UPDATE plugin_upstreams SET last_checked_at=NOW(),last_seen_version=?,last_synced_at=NOW(),last_error='' WHERE id=?",(parsed.version.as_str(),current.id)).await?;
        Ok(promoted)
    }).await;
    match outcome {
        Ok(Some((id, version))) => {
            if let Err(_error) = notify(state, upstream.plugin_id, id, &version).await {
                tracing::warn!(
                    plugin_id = upstream.plugin_id,
                    release_id = id,
                    "Plugin release notification failed after publication"
                );
            }
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(error) => {
            if let Some(key) = created
                && storage.delete(&key).await.is_err()
            {
                tracing::warn!(
                    upstream_id = upstream.id,
                    "Plugin rollback object deletion failed"
                );
            }
            Err(error.into())
        }
    }
}

fn newer(candidate: &str, current: &str) -> Result<bool> {
    Ok(candidate.parse::<pep440_rs::Version>()? > current.parse::<pep440_rs::Version>()?)
}

fn listing(release: &Release) -> (String, String) {
    let listing = &release.scan_report_json.0["listing"];
    let description = listing["descriptionMd"]
        .as_str()
        .filter(|v| !v.is_empty())
        .or_else(|| release.manifest_json.0["description"].as_str())
        .unwrap_or("");
    let summary = listing["summary"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| description.chars().take(500).collect());
    (summary, description.chars().take(8192).collect())
}
async fn finalize<T: MysqlTransaction>(
    tx: &mut T,
    plugin: &Plugin,
    release: &Release,
    previous: Option<&Release>,
) -> MysqlResult<()> {
    if release.scan_status != "passed" || release.status == "rejected" {
        return Err(invalid("Release has not passed package scanning"));
    }
    tx.execute("UPDATE plugin_releases SET status='ready',published_at=IF(published_at='1970-01-01 00:00:00',NOW(),published_at) WHERE id=?",(release.id,)).await?;
    if previous.is_some_and(|current| {
        !newer(&release.version, &current.version).unwrap_or(release.id >= current.id)
    }) {
        tx.execute("UPDATE plugins SET status=IF(status='unpublished',status,'published'),published_at=IF(published_at='1970-01-01 00:00:00',NOW(),published_at),updated_at=NOW() WHERE id=?",(plugin.id,)).await?;
        return Ok(());
    }
    let report = &release.scan_report_json.0["listing"];
    let interface = &release.interface_json.0;
    let (name, display) = (
        report["name"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or_else(|| release.manifest_json.0["name"].as_str())
            .unwrap_or(&plugin.name),
        report["displayName"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or_else(|| interface["displayName"].as_str())
            .unwrap_or(&plugin.display_name),
    );
    let (summary, description) = listing(release);
    let old = previous.map(listing);
    let summary = if old.as_ref().is_none_or(|old| plugin.summary == old.0) {
        &summary
    } else {
        &plugin.summary
    };
    let description = if old
        .as_ref()
        .is_none_or(|old| plugin.description_md == old.1)
    {
        &description
    } else {
        &plugin.description_md
    };
    let category = interface["category"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or(&plugin.category);
    tx.execute("UPDATE plugins SET name=?,display_name=?,summary=?,description_md=?,interface_json=?,category=?,latest_release_id=?,status=IF(status='unpublished',status,'published'),published_at=IF(published_at='1970-01-01 00:00:00',NOW(),published_at),updated_at=NOW() WHERE id=?",(name,display,summary.as_str(),description.as_str(),Json(interface),category,release.id,plugin.id)).await?;
    Ok(())
}

#[derive(FromMysqlRow)]
struct Install {
    user_id: i64,
    json: Json<Value>,
}
async fn notify(state: &AppState, plugin: i64, release: i64, version: &str) -> Result<()> {
    let current:Option<(i64,)>=state.mysql.fetch_optional("SELECT r.id FROM plugin_releases r JOIN plugins p ON p.id=r.plugin_id WHERE p.id=? AND r.id=? AND p.latest_release_id=r.id AND r.status='ready' AND r.scan_status='passed'",(plugin,release)).await?;
    if current.is_none() {
        return Ok(());
    }
    let Some(redis) = &state.redis else {
        bail!("Plugin release notification requires Redis")
    };
    let rows:Vec<Install>=state.mysql.fetch_all("SELECT user_id,json FROM kinds WHERE kind='InstalledPlugin' AND namespace='default' AND is_active=1",()).await?;
    let users = rows
        .into_iter()
        .filter(|row| {
            let spec = &row.json.0["spec"];
            spec["source"]["type"] == "marketplace"
                && spec["pluginId"].as_i64() == Some(plugin)
                && spec["releaseId"].as_i64() != Some(release)
                && spec["updatePolicy"] == "auto"
        })
        .map(|row| row.user_id)
        .collect::<BTreeSet<_>>();
    for user in users {
        let data = json!([{"pluginId":plugin,"releaseId":release,"version":version}]).to_string();
        let message = crate::socketio_emit::emit_message(
            "plugin:release_available",
            &data,
            "/chat",
            &format!("wework:user:{user}"),
        );
        redis.publish("socketio", message).await?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_follow_python_packaging_order() {
        assert!(newer("1.0", "1.0rc1").unwrap());
        assert!(!newer("1.0rc2", "1.0").unwrap());
        assert!(newer("1.0.post1", "1.0").unwrap());
        assert!(!newer("1.0.0", "1.0").unwrap());
    }

    #[test]
    fn invalid_latest_version_cannot_promote_an_upstream() {
        assert!(newer("2.0.0", "invalid-latest-version").is_err());
    }
}
