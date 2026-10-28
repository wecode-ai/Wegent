//! Serialize generation starts on the complete KB identity; seed incremental snapshots.
use super::super::model::{SUBSCRIPTION_COLUMNS, Subscription};
use super::{Strategy, Wiki, repository::Revision};
use crate::AppState;
use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Value, json};
#[derive(FromMysqlRow)]
struct Generation {
    id: i64,
    source_snapshot: Json<Value>,
    ext: Json<Value>,
    updated_at: NaiveDateTime,
    completed_at: NaiveDateTime,
}
#[derive(Default)]
pub(super) struct Published {
    pub id: i64,
    pub commit: String,
    pub count: Option<u64>,
}
pub(super) async fn published(app: &AppState, wiki: &Wiki) -> Result<Published> {
    let id = wiki.json.0["spec"]["publishedGenerationId"]
        .as_i64()
        .unwrap_or(0);
    if id <= 0 {
        return Ok(Published::default());
    }
    let row:Option<Generation>=app.mysql.fetch_optional("SELECT id,source_snapshot,ext,updated_at,completed_at FROM wiki_generations WHERE id=? AND kind_id=?",(id,wiki.id)).await?;
    Ok(row
        .map(|g| Published {
            id,
            commit: g.source_snapshot.0["commit"].as_str().unwrap_or("").into(),
            count: g.source_snapshot.0["trackedFileCount"]
                .as_u64()
                .filter(|v| *v > 0),
        })
        .unwrap_or_default())
}
pub(super) async fn in_flight(app: &AppState, wiki: i64) -> Result<bool> {
    let now = Utc::now().naive_utc();
    let rows:Vec<Generation>=app.mysql.fetch_all("SELECT id,source_snapshot,ext,updated_at,completed_at FROM wiki_generations WHERE kind_id=? AND status IN ('PENDING','RUNNING')",(wiki,)).await?;
    Ok(rows.iter().any(|g| !stale(g, now)))
}
fn stale(g: &Generation, now: NaiveDateTime) -> bool {
    let timeout = g.ext.0["backgroundExecutionTimeoutSeconds"]
        .as_i64()
        .filter(|v| *v > 0)
        .unwrap_or(6 * 3600);
    g.updated_at < now - chrono::Duration::seconds(timeout)
}
pub(super) async fn mode(
    app: &AppState,
    wiki: &Wiki,
    previous: &Published,
    revision: &Revision,
) -> Result<(String, String)> {
    let full:Option<Generation>=app.mysql.fetch_optional("SELECT id,source_snapshot,ext,updated_at,completed_at FROM wiki_generations WHERE kind_id=? AND LOWER(generation_type)='full' AND status='COMPLETED' ORDER BY completed_at DESC LIMIT 1",(wiki.id,)).await?;
    let (incrementals, age) = if let Some(full) = full {
        let count:brz_mysql::MysqlRow=app.mysql.fetch_one("SELECT COUNT(*) FROM wiki_generations WHERE kind_id=? AND LOWER(generation_type)='incremental' AND status='COMPLETED' AND completed_at>?",(wiki.id,full.completed_at)).await?;
        (
            count.get_at::<u64>(0)?,
            Some(
                ((Utc::now().naive_utc() - full.completed_at).num_seconds() as f64 / 86400.)
                    .max(0.),
            ),
        )
    } else {
        (0, None)
    };
    Ok(decide(
        &previous.commit,
        &revision.head,
        revision.changed.as_deref(),
        revision.count.or(previous.count),
        !previous.commit.is_empty() && previous.count.is_none(),
        incrementals,
        age,
    ))
}
fn decide(
    previous: &str,
    head: &str,
    changed: Option<&[String]>,
    count: Option<u64>,
    require_count: bool,
    incrementals: u64,
    age: Option<f64>,
) -> (String, String) {
    let (mode, reason) = if previous.is_empty() {
        ("full", "first run for this repository".into())
    } else if previous == head {
        ("skip", "repository unchanged since last run".into())
    } else if let Some(changed) = changed {
        if changed.is_empty() {
            ("skip", "no documented files changed".into())
        } else if require_count && count.is_none_or(|c| c == 0) {
            (
                "full",
                "repository file count is unavailable, rebuilding to stay correct".into(),
            )
        } else if let Some(count) = count.filter(|c| *c > 0)
            && changed.len() as f64 / count as f64 > 0.25
        {
            (
                "full",
                format!(
                    "{:.0}% of files changed ({} of {count} tracked files), over the limit of 25%",
                    changed.len() as f64 / count as f64 * 100.,
                    changed.len()
                ),
            )
        } else if incrementals >= 10 {
            (
                "full",
                format!("{incrementals} incremental runs since the last full rebuild"),
            )
        } else if age.is_some_and(|age| age >= 30.) {
            (
                "full",
                format!("{:.0} days since the last full rebuild", age.unwrap()),
            )
        } else {
            (
                "incremental",
                format!("{} files changed since last run", changed.len()),
            )
        }
    } else {
        (
            "full",
            "extent of changes unknown, rebuilding to stay correct".into(),
        )
    };
    (mode.into(), reason)
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn start(
    app: &AppState,
    wiki: &Wiki,
    plan: &Subscription,
    execution: i64,
    runner: i64,
    strategy: &Strategy,
    mode: &str,
    reason: &str,
    revision: &Revision,
    previous: &Published,
) -> Result<Option<i64>> {
    let now = Utc::now().naive_utc();
    Ok(app.mysql.with_transaction(async|tx|{let live:Option<Wiki>=tx.fetch_optional("SELECT id,user_id,name,namespace,json,is_active FROM kinds WHERE id=? AND kind='KnowledgeBase' AND user_id=? AND name=? AND namespace=? AND is_active=1 FOR UPDATE",(wiki.id,wiki.user_id,wiki.name.as_str(),wiki.namespace.as_str())).await?;let current_plan:Option<Subscription>=tx.fetch_optional(format!("SELECT {SUBSCRIPTION_COLUMNS} FROM kinds WHERE id=? AND kind='Subscription' FOR UPDATE"),(plan.id,)).await?;let (Some(live),Some(current_plan))=(live,current_plan)else{return Ok(None)};if current_plan.is_active==0||current_plan.json.0["_internal"]["enabled"]!=true||!super::references(&current_plan,&live){return Ok(None)}
        // Never launch credentials/configuration prepared for an obsolete source or runner.
        if live.json.0["spec"]!=wiki.json.0["spec"]{return Err(brz_mysql::MysqlError::InvalidQuery{reason:"Code Wiki configuration changed during generation admission".into()})}
        let rows:Vec<Generation>=tx.fetch_all("SELECT id,source_snapshot,ext,updated_at,completed_at FROM wiki_generations WHERE kind_id=? AND status IN ('PENDING','RUNNING') FOR UPDATE",(wiki.id,)).await?;for row in rows {if !stale(&row,now){return Ok(None)}let mut ext=row.ext.0;ext.as_object_mut().map(|v|v.entry("failureCode").or_insert(json!("worker_abandoned")));tx.execute("UPDATE wiki_generations SET status='FAILED',ext=?,completed_at=?,updated_at=? WHERE id=? AND status IN ('PENDING','RUNNING')",(Json(ext),now,now,row.id)).await?;}
        let registry:Option<brz_mysql::MysqlRow>=tx.fetch_optional("SELECT id FROM wiki_projects WHERE kind_id=? AND is_active=1 ORDER BY id LIMIT 1",(wiki.id,)).await?;let registry=registry.ok_or_else(||brz_mysql::MysqlError::InvalidQuery{reason:"Code Wiki has no repository registry row".into()})?.get_at::<i64>(0)?;
        let mut ext=json!({"runModeReason":reason,"backgroundExecutionId":execution,"backgroundExecutionTimeoutSeconds":plan.json.0["spec"]["timeoutSeconds"].as_u64().unwrap_or(6*3600),"generationStrategy":{"id":strategy.id,"revision":1,"teamRef":{"name":strategy.team.name,"namespace":strategy.team.namespace}}});if mode=="full"&&strategy.review{ext["qualityReview"]=json!({"required":true,"policy":"plan_only","handoffs":[],"checkpoints":[]});}
        let inserted=tx.execute("INSERT INTO wiki_generations (project_id,kind_id,user_id,task_id,team_id,generation_type,source_snapshot,status,ext,created_at,updated_at,completed_at) VALUES (?,?,?,0,?,?,?,'RUNNING',?,?,?,'1970-01-01 00:00:00')",(registry,wiki.id,runner,strategy.team.id,mode.to_ascii_uppercase(),Json(json!({"commit":revision.head})),Json(ext),now,now)).await?;let id=inserted.last_insert_id as i64;
        if mode=="incremental"&&previous.id>0{tx.execute("INSERT INTO wiki_contents (generation_id,type,title,content,parent_id,ext,created_at,updated_at) SELECT ?,type,title,content,0,ext,?,? FROM wiki_contents WHERE generation_id=?",(id,now,now,previous.id)).await?;}
        Ok(Some(id))}).await?)
}
pub(super) async fn pages(app: &AppState, id: i64) -> Result<Vec<String>> {
    let rows: Vec<brz_mysql::MysqlRow> = app
        .mysql
        .fetch_all(
            "SELECT title,ext FROM wiki_contents WHERE generation_id=? ORDER BY id",
            (id,),
        )
        .await?;
    rows.iter()
        .map(|r| {
            let ext = r.get_at::<Json<Value>>(1)?.0;
            Ok(ext["path"].as_str().map(str::to_owned).unwrap_or_default())
        })
        .collect()
}
pub(crate) async fn fail<M: Mysql>(mysql: &M, id: i64, code: &str, error: &str) -> Result<()> {
    mysql.with_transaction(async|tx|{let row:Option<brz_mysql::MysqlRow>=tx.fetch_optional("SELECT ext FROM wiki_generations WHERE id=? AND status IN ('PENDING','RUNNING') FOR UPDATE",(id,)).await?;if let Some(row)=row{let mut ext=row.get_at::<Json<Value>>(0)?.0;if !ext.is_object(){ext=json!({})}ext["failureCode"]=json!(code);if !error.is_empty(){ext["errorMessage"]=json!(error)}tx.execute("UPDATE wiki_generations SET status='FAILED',ext=?,completed_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP() WHERE id=? AND status IN ('PENDING','RUNNING')",(Json(ext),id)).await?;}Ok(())}).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_diff_never_seeds_partial_snapshot() {
        assert_eq!(
            decide("old", "new", None, Some(100), false, 0, None).0,
            "full"
        );
        assert_eq!(decide("old", "old", None, None, true, 0, None).0, "skip");
        let files = vec!["a".into()];
        assert_eq!(
            decide("old", "new", Some(&files), None, true, 0, None).0,
            "full"
        );
        assert_eq!(
            decide("old", "new", Some(&files), Some(100), false, 0, None).0,
            "incremental"
        );
        assert_eq!(
            decide("old", "new", Some(&files), Some(100), false, 10, None).0,
            "full"
        );
    }
}
