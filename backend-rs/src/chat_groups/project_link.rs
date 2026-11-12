//! Project classification is optional and never provides group read authority.
use super::{error, internal, reject, repository};
use crate::{http_compat::FastApiError, loop_tasks::auth::FlexibleUser, state::AppState};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn link_id(thread: &str) -> String {
    let bytes = Sha256::digest(format!("thread-project:{thread}"));
    (u64::from_be_bytes(bytes[..8].try_into().expect("SHA-256 prefix")) & i64::MAX as u64)
        .to_string()
}
#[derive(FromMysqlRow)]
struct Link {
    project_id: String,
}

#[brz_http_server::get("/api/v1/loop-items/:item_id/project-link")]
async fn get(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
) -> Result<Value, FastApiError> {
    let (thread, _) = repository::thread(&state.mysql, item_id, user.id).await?;
    let link:Option<Link> = state.mysql.fetch_optional("SELECT parent_id AS project_id FROM loop_items WHERE loop_item_id=? AND resource_type='thread_project_link' AND status='active' AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))",(item_id,)).await.map_err(internal)?;
    let Some(link) = link else {
        return Ok(json!({"project":null,"restricted":false,"thread_version":thread.version}));
    };
    let project_id = link
        .project_id
        .parse()
        .map_err(|_| error(500, "Invalid persisted project classification"))?;
    let project = crate::cloud_projects::authorized_project(&state.mysql, project_id, user.id)
        .await
        .map_err(internal)?;
    Ok(match project {
        Some((project, _)) => {
            json!({"project":{"id":link.project_id,"name":project.name},"restricted":false,"thread_version":thread.version})
        }
        None => json!({"project":null,"restricted":true,"thread_version":thread.version}),
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    version: i64,
    project_id: Option<String>,
}

#[brz_http_server::put("/api/v1/loop-items/:item_id/project-link")]
async fn change(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] user: FlexibleUser,
    body: Value,
) -> Result<Value, FastApiError> {
    let input: Change =
        serde_json::from_value(body).map_err(|_| error(422, "Invalid project classification"))?;
    if input.version < 1 {
        return Err(error(422, "Invalid Thread version"));
    }
    let (_, group) = repository::thread(&state.mysql, item_id, user.id).await?;
    let target = input
        .project_id
        .as_ref()
        .map(|id| {
            id.parse::<i64>()
                .map_err(|_| error(422, "Invalid project identity"))
        })
        .transpose()?;
    let target_id = target.map(|id| id.to_string());
    state.mysql.with_transaction(async |tx| {
        let group=repository::lock_access(tx,&group.id,user.id).await?;
        if !group.can_write() { return Err(reject(403,"Thread editing is unavailable")) }
        let thread = repository::lock_thread(tx,item_id,&group.id).await?;
        if thread.version != input.version { return Err(reject(409,"Thread changed; refresh and try again")) }
        let key=link_id(item_id);
        #[derive(FromMysqlRow)] struct StoredLink { resource_type:String, loop_item_id:Option<String>, parent_id:Option<String>, status:Option<String> }
        let existing:Option<StoredLink>=tx.fetch_optional("SELECT resource_type,loop_item_id,parent_id,status FROM loop_items WHERE id=? FOR UPDATE",(key.as_str(),)).await?;
        let current = if let Some(existing)=existing {
            if existing.resource_type!="thread_project_link" || existing.loop_item_id.as_deref()!=Some(item_id) { return Err(reject(409,"Project link identity collision")) }
            if existing.status.as_deref()==Some("active") { existing.parent_id } else { None }
        } else { None };
        let mut projects=std::collections::BTreeSet::new();
        if let Some(target)=target { projects.insert(target); }
        if let Some(source)=&current { projects.insert(source.parse::<i64>().map_err(|_|reject(500,"Invalid persisted project classification"))?); }
        super::project_authority::lock_project_edits(tx,&projects,user.id).await?;
        if current==target_id { return Ok(()) }
        let changed=tx.execute("UPDATE loop_items SET metadata=JSON_REMOVE(COALESCE(metadata,JSON_OBJECT()),'$.milestone_id'),version=version+1,updated_at=UTC_TIMESTAMP() WHERE id=? AND version=?",(item_id,input.version)).await?;
        if changed.rows_affected!=1 { return Err(reject(409,"Thread changed; refresh and try again")) }
        if let Some(project) = &target_id {
            let required=crate::loop_node_storage::required_columns(tx).await?;
            let sql=crate::loop_node_storage::insert_sql(&["id","resource_type","project_space","parent_id","loop_item_id","status","metadata","sort_order","next_item_number","assignee_agent_id","version","created_at","updated_at"],&["?","'thread_project_link'","'default'","?","?","'active'","?","0","1","''","1","UTC_TIMESTAMP()","UTC_TIMESTAMP()"],&required);
            tx.execute(format!("{sql} ON DUPLICATE KEY UPDATE parent_id=VALUES(parent_id),status='active',version=version+1,updated_at=UTC_TIMESTAMP()"),(key.as_str(),project.as_str(),item_id,Json(json!({})))).await?;
        } else {
            tx.execute("UPDATE loop_items SET status='removed',version=version+1,updated_at=UTC_TIMESTAMP() WHERE id=? AND resource_type='thread_project_link' AND loop_item_id=?",(key.as_str(),item_id)).await?;
        }
        Ok(())
    }).await.map_err(internal)?;
    get(state, item_id, user).await
}
