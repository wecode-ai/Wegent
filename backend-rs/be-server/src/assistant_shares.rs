//! Account-owned assistant definitions and recipient-specific use grants.
use std::collections::BTreeSet;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlTransaction};
use serde::{Deserialize, Serialize};
use wegent_protocol::assistant_share::{
    AssistantShareDefinition as Definition, AssistantShareSnapshot, VersionedShareDefinition,
};

use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PublishShare {
    recipient_user_id: i32,
    allow_copy: bool,
    root: Definition,
    #[serde(default)]
    assistants: Vec<Definition>,
}

#[derive(FromMysqlRow)]
struct UserRow {
    id: i32,
}

#[derive(FromMysqlRow)]
struct GrantState {
    active: bool,
}

#[derive(FromMysqlRow)]
struct DefinitionRow {
    definition: Json<Definition>,
    revision: u64,
    allow_copy: bool,
    direct_enabled: bool,
}

#[derive(Serialize)]
struct SharePreview {
    owner_user_id: i32,
    definition: Definition,
    revision: u64,
    allow_copy: bool,
    direct_enabled: bool,
}

fn valid_id(id: &str) -> bool {
    id == "@primary"
        || (!id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte)))
}

fn valid_definition(definition: &Definition) -> bool {
    let (_, id) = definition.key();
    if !valid_id(id) {
        return false;
    }
    match definition {
        Definition::Assistant(assistant) => !assistant.name.trim().is_empty(),
        Definition::Team(team) => {
            id != "@primary"
                && !team.name.trim().is_empty()
                && team.members.len() <= 101
                && team.members.contains_key(&team.lead_id)
                && (team.lead_id == "@primary" || !team.members.contains_key("@primary"))
                && team.members.keys().all(|id| valid_id(id))
        }
    }
}

impl PublishShare {
    fn valid(&self, owner: i32) -> bool {
        if self.recipient_user_id <= 0
            || self.recipient_user_id == owner
            || !valid_definition(&self.root)
        {
            return false;
        }
        match &self.root {
            Definition::Assistant(_) => self.assistants.is_empty(),
            Definition::Team(team) => {
                self.assistants.len() == team.members.len()
                    && self.assistants.iter().all(|definition| {
                        matches!(definition, Definition::Assistant(_))
                            && valid_definition(definition)
                    })
                    && self
                        .assistants
                        .iter()
                        .map(|definition| definition.key().1)
                        .collect::<BTreeSet<_>>()
                        == team.members.keys().map(String::as_str).collect()
            }
        }
    }
}

#[derive(FromMysqlRow, Serialize)]
struct ShareListEntry {
    owner_user_id: i32,
    owner_name: String,
    recipient_user_id: i32,
    recipient_name: String,
    resource_kind: String,
    source_id: String,
    name: String,
    revision: u64,
    allow_copy: bool,
    direct_enabled: bool,
    revoked: bool,
    derived: bool,
}

#[derive(Serialize)]
struct ShareList {
    received: Vec<ShareListEntry>,
    sent: Vec<ShareListEntry>,
}

const SHARE_LIST_SELECT: &str = "SELECT g.owner_user_id,owner.user_name AS owner_name,g.recipient_user_id,recipient.user_name AS recipient_name,CAST(g.resource_kind AS CHAR) AS resource_kind,CONVERT(g.source_id USING utf8mb4) AS source_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(d.definition,'$.definition.name')) AS CHAR) AS name,d.revision,g.allow_copy,g.direct_enabled,g.revoked_at IS NOT NULL AS revoked,FALSE AS derived FROM assistant_share_grants g JOIN assistant_share_definitions d USING (owner_user_id,resource_kind,source_id) JOIN users owner ON owner.id=g.owner_user_id JOIN users recipient ON recipient.id=g.recipient_user_id";

// A copied team member can be updated while a current copied-team grant
// includes it. This does not create a direct-use grant for the member.
const TEAM_MEMBER_COPY_ACCESS: &str = "EXISTS (SELECT 1 FROM assistant_share_grants grant_row JOIN assistant_share_definitions team USING(owner_user_id,resource_kind,source_id) WHERE grant_row.owner_user_id=c.owner_user_id AND grant_row.recipient_user_id=c.recipient_user_id AND grant_row.resource_kind='team' AND grant_row.allow_copy=true AND grant_row.revoked_at IS NULL AND JSON_CONTAINS(JSON_KEYS(JSON_EXTRACT(team.definition,'$.definition.members')),JSON_QUOTE(c.source_id)))";
const DERIVED_COPY_ROWS: &str = "SELECT c.owner_user_id,owner.user_name AS owner_name,c.recipient_user_id,recipient.user_name AS recipient_name,'assistant' AS resource_kind,CONVERT(c.source_id USING utf8mb4) AS source_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(d.definition,'$.definition.name')) AS CHAR) AS name,d.revision,TRUE AS allow_copy,FALSE AS direct_enabled,FALSE AS revoked,TRUE AS derived FROM assistant_team_member_copies c JOIN assistant_share_definitions d ON d.owner_user_id=c.owner_user_id AND d.resource_kind='assistant' AND d.source_id=c.source_id JOIN users owner ON owner.id=c.owner_user_id JOIN users recipient ON recipient.id=c.recipient_user_id";

#[brz_http_server::get("/api/v1/assistant-shares")]
async fn list_shares(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<ShareList, FastApiError> {
    let id = user.0.id;
    let mut received: Vec<ShareListEntry> = state
        .mysql
        .fetch_all(
            format!("{SHARE_LIST_SELECT} WHERE g.recipient_user_id=? ORDER BY g.updated_at DESC"),
            (id,),
        )
        .await
        .map_err(internal)?;
    let derived: Vec<ShareListEntry> = state
        .mysql
        .fetch_all(
            format!(
                "{DERIVED_COPY_ROWS} WHERE c.recipient_user_id=? AND {TEAM_MEMBER_COPY_ACCESS}"
            ),
            (id,),
        )
        .await
        .map_err(internal)?;
    let mut indexed = received
        .iter()
        .enumerate()
        .map(|(index, row)| {
            (
                (
                    row.owner_user_id,
                    row.resource_kind.clone(),
                    row.source_id.clone(),
                ),
                index,
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    for row in derived {
        let key = (
            row.owner_user_id,
            row.resource_kind.clone(),
            row.source_id.clone(),
        );
        if let Some(index) = indexed.get(&key).copied() {
            if received[index].revoked {
                received[index] = row;
            } else {
                received[index].allow_copy = true;
            }
        } else {
            indexed.insert(key, received.len());
            received.push(row);
        }
    }
    let sent = state
        .mysql
        .fetch_all(
            format!("{SHARE_LIST_SELECT} WHERE g.owner_user_id=? ORDER BY g.updated_at DESC"),
            (id,),
        )
        .await
        .map_err(internal)?;
    Ok(ShareList { received, sent })
}

#[brz_http_server::post("/api/v1/assistant-shares")]
async fn publish_share(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: PublishShare,
) -> Result<SharePreview, FastApiError> {
    let owner = user.0.id;
    if !body.valid(owner) {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid assistant share",
        ));
    }
    let (kind, source) = body.root.key();
    let recipient = body.recipient_user_id;
    use crate::background_jobs::project::notifications;
    let result = state.mysql.with_transaction(async |tx| {
        let active: Option<UserRow> = tx
            .fetch_optional("SELECT id FROM users WHERE id=? AND is_active=true FOR UPDATE", (recipient,))
            .await?;
        let Some(recipient) = active.map(|row| row.id) else { return Ok(None); };
        // Resolve member definitions before writing the grant. All writes commit together.
        let mut definitions = body.assistants.iter().chain([&body.root]).collect::<Vec<_>>();
        definitions.sort_unstable_by(|left, right| left.key().cmp(&right.key()));
        let mut notices = Vec::new();
        for definition in definitions {
            let (kind, source) = definition.key();
            let write = tx.execute("INSERT INTO assistant_share_definitions (owner_user_id,resource_kind,source_id,definition) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE revision=revision+IF(definition=VALUES(definition),0,1),updated_at=IF(definition=VALUES(definition),updated_at,CURRENT_TIMESTAMP(6)),definition=VALUES(definition)", (owner,kind,source,Json(definition))).await?;
            if write.rows_affected == 2 {
                notices.extend(definition_update_notices(tx, owner, definition).await?);
            }
        }
        let prior: Option<GrantState> = tx.fetch_optional(
            "SELECT revoked_at IS NULL AS active FROM assistant_share_grants WHERE owner_user_id=? AND resource_kind=? AND source_id=? AND recipient_user_id=? FOR UPDATE",
            (owner,kind,source,recipient),
        ).await?;
        tx.execute("INSERT INTO assistant_share_grants (owner_user_id,resource_kind,source_id,recipient_user_id,allow_copy) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE allow_copy=VALUES(allow_copy),revoked_at=NULL,updated_at=CURRENT_TIMESTAMP(6)", (owner,kind,source,recipient,body.allow_copy)).await?;
        if !prior.is_some_and(|row| row.active) {
            let name = match &body.root {
                Definition::Assistant(assistant) => &assistant.name,
                Definition::Team(team) => &team.name,
            };
            notices.push(notifications::create_on(
                tx, i64::from(recipient), i64::from(owner), "assistant_share",
                "有人分享了助理或团队", name,
                serde_json::json!({"ownerUserId":owner, "kind":kind, "sourceId":source}),
            ).await?)
        }
        Ok(Some(notices))
    }).await.map_err(internal)?;
    for notification in result.ok_or_else(missing)? {
        notifications::deliver(state, notification).await;
    }
    preview(&state.mysql, owner, kind, source, recipient).await
}

#[brz_http_server::get("/api/v1/assistant-shares/:owner/:kind/:source")]
async fn get_share(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    owner: i32,
    kind: &str,
    source: &str,
) -> Result<SharePreview, FastApiError> {
    preview(&state.mysql, owner, kind, source, user.0.id).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectUse {
    enabled: bool,
}

#[brz_http_server::patch("/api/v1/assistant-shares/:owner/:kind/:source")]
async fn set_direct_use(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    owner: i32,
    kind: &str,
    source: &str,
    body: DirectUse,
) -> Result<SharePreview, FastApiError> {
    let recipient = user.0.id;
    state.mysql.execute(
        "UPDATE assistant_share_grants SET direct_enabled=?,updated_at=CURRENT_TIMESTAMP(6) WHERE owner_user_id=? AND resource_kind=? AND source_id=? AND recipient_user_id=? AND revoked_at IS NULL",
        (body.enabled,owner,kind,source,recipient),
    ).await.map_err(internal)?;
    preview(&state.mysql, owner, kind, source, recipient).await
}

#[brz_http_server::delete("/api/v1/assistant-shares/:kind/:source/recipients/:recipient")]
async fn revoke_share(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    kind: &str,
    source: &str,
    recipient: i32,
) -> Result<serde_json::Value, FastApiError> {
    state.mysql.execute(
        "UPDATE assistant_share_grants SET revoked_at=CURRENT_TIMESTAMP(6),updated_at=CURRENT_TIMESTAMP(6),direct_enabled=FALSE WHERE owner_user_id=? AND resource_kind=? AND source_id=? AND recipient_user_id=? AND revoked_at IS NULL",
        (user.0.id,kind,source,recipient),
    ).await.map_err(internal)?;
    Ok(serde_json::json!({"revoked":true}))
}

async fn preview(
    mysql: &impl Mysql,
    owner: i32,
    kind: &str,
    source: &str,
    recipient: i32,
) -> Result<SharePreview, FastApiError> {
    let row: Option<DefinitionRow> = mysql.fetch_optional(
        "SELECT d.definition,d.revision,g.allow_copy,g.direct_enabled FROM assistant_share_grants g JOIN assistant_share_definitions d USING (owner_user_id,resource_kind,source_id) WHERE g.owner_user_id=? AND g.resource_kind=? AND g.source_id=? AND g.recipient_user_id=? AND g.revoked_at IS NULL",
        (owner,kind,source,recipient),
    ).await.map_err(internal)?;
    let row = row.ok_or_else(missing)?;
    Ok(SharePreview {
        owner_user_id: owner,
        definition: row.definition.0,
        revision: row.revision,
        allow_copy: row.allow_copy,
        direct_enabled: row.direct_enabled,
    })
}

#[derive(FromMysqlRow)]
struct MemberDefinitionRow {
    definition: Json<Definition>,
    revision: u64,
}

#[brz_http_server::get("/api/v1/assistant-shares/:owner/:kind/:source/snapshot/:mode")]
async fn get_snapshot(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    owner: i32,
    kind: &str,
    source: &str,
    mode: &str,
) -> Result<AssistantShareSnapshot, FastApiError> {
    let recipient = user.0.id;
    let snapshot = state.mysql.with_transaction(async |tx| {
        let root: Option<DefinitionRow> = tx.fetch_optional(
            "SELECT d.definition,d.revision,g.allow_copy,g.direct_enabled FROM assistant_share_grants g JOIN assistant_share_definitions d USING (owner_user_id,resource_kind,source_id) WHERE g.owner_user_id=? AND g.resource_kind=? AND g.source_id=? AND g.recipient_user_id=? AND g.revoked_at IS NULL",
            (owner,kind,source,recipient),
        ).await?;
        let root = match root.filter(|row| snapshot_allowed(row, mode)) {
            Some(root) => Some(root),
            None if kind == "assistant" && mode == "copy" => tx.fetch_optional(
                format!("SELECT d.definition,d.revision,TRUE AS allow_copy,FALSE AS direct_enabled FROM assistant_team_member_copies c JOIN assistant_share_definitions d ON d.owner_user_id=c.owner_user_id AND d.resource_kind='assistant' AND d.source_id=c.source_id WHERE c.owner_user_id=? AND c.source_id=? AND c.recipient_user_id=? AND {TEAM_MEMBER_COPY_ACCESS}"),
                (owner,source,recipient),
            ).await?,
            None => None,
        };
        let Some(root) = root else { return Ok(None); };
        let mut assistants = Vec::new();
        if let Definition::Team(team) = &root.definition.0 {
            for id in team.members.keys() {
                let assistant: Option<MemberDefinitionRow> = tx.fetch_optional(
                    "SELECT definition,revision FROM assistant_share_definitions WHERE owner_user_id=? AND resource_kind='assistant' AND source_id=?",
                    (owner,id.as_str()),
                ).await?;
                let Some(row) = assistant else { return Ok(None); };
                assistants.push(VersionedShareDefinition { definition: row.definition.0, revision: row.revision });
            }
        }
        Ok(Some(AssistantShareSnapshot {
            owner_user_id: owner,
            root: VersionedShareDefinition { definition: root.definition.0, revision: root.revision },
            assistants,
        }))
    }).await.map_err(internal)?;
    snapshot.ok_or_else(missing)
}

fn snapshot_allowed(row: &DefinitionRow, mode: &str) -> bool {
    match mode {
        "copy" => row.allow_copy,
        "direct" => row.direct_enabled,
        _ => false,
    }
}

#[derive(FromMysqlRow, Serialize)]
struct ShareSource {
    kind: String,
    source: String,
    revision: u64,
}

const ACTIVE_DEFINITION: &str = "(EXISTS (SELECT 1 FROM assistant_share_grants g WHERE g.owner_user_id=d.owner_user_id AND g.resource_kind=d.resource_kind AND g.source_id=d.source_id AND g.revoked_at IS NULL) OR (d.resource_kind='assistant' AND EXISTS (SELECT 1 FROM assistant_share_grants g JOIN assistant_share_definitions t USING(owner_user_id,resource_kind,source_id) WHERE g.owner_user_id=d.owner_user_id AND g.resource_kind='team' AND g.revoked_at IS NULL AND JSON_CONTAINS(JSON_KEYS(JSON_EXTRACT(t.definition,'$.definition.members')),JSON_QUOTE(d.source_id)))))";

#[brz_http_server::get("/api/v1/assistant-shares/owner-sync")]
async fn owned_share_sources(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<Vec<ShareSource>, FastApiError> {
    state.mysql.fetch_all(
        format!("SELECT CAST(d.resource_kind AS CHAR) AS kind,CONVERT(d.source_id USING utf8mb4) AS source,d.revision FROM assistant_share_definitions d WHERE d.owner_user_id=? AND {ACTIVE_DEFINITION}"),
        (user.0.id,),
    ).await.map_err(internal)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncDefinition {
    root: Definition,
    expected_revision: u64,
    #[serde(default)]
    assistants: Vec<Definition>,
}

#[brz_http_server::put("/api/v1/assistant-shares/owner-sync")]
async fn sync_definition(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: SyncDefinition,
) -> Result<serde_json::Value, FastApiError> {
    use crate::background_jobs::project::notifications;
    let owner = user.0.id;
    let (kind, source) = body.root.key();
    let valid_assistants = body.assistants.iter().all(|entry|
        matches!(entry, Definition::Assistant(_)) && valid_definition(entry)
            && matches!(&body.root, Definition::Team(team) if team.members.contains_key(entry.key().1)));
    if !valid_definition(&body.root) || !valid_assistants || body.assistants.len() > 101 {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid assistant definition",
        ));
    }
    let result = state.mysql.with_transaction(async |tx| {
        let old: Option<MemberDefinitionRow> = tx.fetch_optional(
            format!("SELECT d.definition,d.revision FROM assistant_share_definitions d WHERE d.owner_user_id=? AND d.resource_kind=? AND d.source_id=? AND {ACTIVE_DEFINITION} FOR UPDATE"),
            (owner,kind,source),
        ).await?;
        let Some(old) = old else { return Ok(SyncOutcome::Inactive); };
        if old.definition.0 == body.root {
            return Ok(SyncOutcome::Committed(Vec::new()));
        }
        if old.revision != body.expected_revision {
            return Ok(SyncOutcome::VersionConflict);
        }
        if let Definition::Team(team) = &body.root {
            let mut missing = Vec::new();
            for id in team.members.keys() {
                let exists: Option<(u64,)> = tx.fetch_optional(
                    "SELECT revision FROM assistant_share_definitions WHERE owner_user_id=? AND resource_kind='assistant' AND source_id=?",
                    (owner,id.as_str()),
                ).await?;
                if exists.is_some() { continue; }
                let Some(definition) = body.assistants.iter().find(|row| row.key().1 == id) else {
                    return Ok(SyncOutcome::MissingMember);
                };
                missing.push((id,definition));
            }
            for (id,definition) in missing {
                tx.execute("INSERT INTO assistant_share_definitions(owner_user_id,resource_kind,source_id,definition) VALUES (?,'assistant',?,?) ON DUPLICATE KEY UPDATE source_id=VALUES(source_id)", (owner,id.as_str(),Json(definition))).await?;
            }
        }
        tx.execute("UPDATE assistant_share_definitions SET definition=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP(6) WHERE owner_user_id=? AND resource_kind=? AND source_id=?", (Json(&body.root),owner,kind,source)).await?;
        let notices = definition_update_notices(tx, owner, &body.root).await?;
        Ok(SyncOutcome::Committed(notices))
    }).await.map_err(internal)?;
    match result {
        SyncOutcome::Inactive => Ok(serde_json::json!({"synced":false})),
        SyncOutcome::VersionConflict => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Assistant publication changed during synchronization",
        )),
        SyncOutcome::MissingMember => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "A shared team member has no published definition",
        )),
        SyncOutcome::Committed(notices) => {
            for notice in notices {
                notifications::deliver(state, notice).await;
            }
            Ok(serde_json::json!({"synced":true}))
        }
    }
}

async fn definition_update_notices(
    tx: &mut impl MysqlTransaction,
    owner: i32,
    definition: &Definition,
) -> brz_mysql::MysqlResult<Vec<crate::background_jobs::project::notifications::Pending>> {
    use crate::background_jobs::project::notifications;
    let (kind, source) = definition.key();
    let explicit: Vec<(i32,)> = tx.fetch_all(
        "SELECT recipient_user_id FROM assistant_share_grants WHERE owner_user_id=? AND resource_kind=? AND source_id=? AND revoked_at IS NULL AND copied_revision IS NOT NULL AND allow_copy=true",
        (owner,kind,source),
    ).await?;
    let mut recipients: BTreeSet<i32> = explicit.into_iter().map(|(id,)| id).collect();
    if kind == "assistant" {
        let derived: Vec<(i32,)> = tx.fetch_all(
            format!("SELECT c.recipient_user_id FROM assistant_team_member_copies c WHERE c.owner_user_id=? AND c.source_id=? AND {TEAM_MEMBER_COPY_ACCESS}"),
            (owner,source),
        ).await?;
        recipients.extend(derived.into_iter().map(|(id,)| id));
    }
    let mut notices = Vec::new();
    for recipient in recipients {
        let pending: Option<(String,)> = tx.fetch_optional(
            "SELECT id FROM wework_notifications WHERE user_id=? AND actor_user_id=? AND kind='assistant_share_update' AND is_read=false AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.kind'))=? AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.sourceId'))=? LIMIT 1",
            (recipient,owner,kind,source),
        ).await?;
        if pending.is_some() {
            continue;
        }
        let (title, name) = match definition {
            Definition::Assistant(assistant) => ("你复制的助理有更新", &assistant.name),
            Definition::Team(team) => ("你复制的团队有更新", &team.name),
        };
        notices.push(
            notifications::create_on(
                tx,
                i64::from(recipient),
                i64::from(owner),
                "assistant_share_update",
                title,
                name,
                serde_json::json!({"ownerUserId":owner, "kind":kind, "sourceId":source}),
            )
            .await?,
        );
    }
    Ok(notices)
}

enum SyncOutcome {
    Inactive,
    VersionConflict,
    MissingMember,
    Committed(Vec<crate::background_jobs::project::notifications::Pending>),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CopyReceipt {
    revision: u64,
}

#[brz_http_server::post("/api/v1/assistant-shares/:owner/:kind/:source/copied")]
async fn record_copy(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    owner: i32,
    kind: &str,
    source: &str,
    body: CopyReceipt,
) -> Result<serde_json::Value, FastApiError> {
    if !matches!(kind, "assistant" | "team") || !valid_id(source) || body.revision == 0 {
        return Err(missing());
    }
    state.mysql.execute(
        "UPDATE assistant_share_grants g JOIN assistant_share_definitions d USING (owner_user_id,resource_kind,source_id) SET g.copied_revision=GREATEST(COALESCE(g.copied_revision,0),?) WHERE g.owner_user_id=? AND g.resource_kind=? AND g.source_id=? AND g.recipient_user_id=? AND g.revoked_at IS NULL AND g.allow_copy=true AND d.revision>=?",
        (body.revision,owner,kind,source,user.0.id,body.revision),
    ).await.map_err(internal)?;
    if kind == "assistant" {
        let recipient = user.0.id;
        state.mysql.execute(
            format!("INSERT INTO assistant_team_member_copies(owner_user_id,source_id,recipient_user_id,copied_revision) SELECT c.owner_user_id,c.source_id,c.recipient_user_id,c.copied_revision FROM (SELECT ? AS owner_user_id,CAST(? AS CHAR CHARACTER SET ascii) COLLATE ascii_bin AS source_id,? AS recipient_user_id,? AS copied_revision) c JOIN assistant_share_definitions d ON d.owner_user_id=c.owner_user_id AND d.resource_kind='assistant' AND d.source_id=c.source_id WHERE d.revision>=c.copied_revision AND {TEAM_MEMBER_COPY_ACCESS} ON DUPLICATE KEY UPDATE copied_revision=GREATEST(assistant_team_member_copies.copied_revision,VALUES(copied_revision))"),
            (owner,source,recipient,body.revision),
        ).await.map_err(internal)?;
    }
    Ok(serde_json::json!({"accepted":true}))
}

fn missing() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Assistant share not found")
}

fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    #[cfg(test)]
    eprintln!("assistant share storage failed: {error}");
    tracing::error!(%error, "assistant share storage failed");
    FastApiError::internal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_route_inventory_selects_assistant_share_operations() {
        let config = crate::load_routes_config(std::path::Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../config/routes.toml"
        )))
        .unwrap();
        let routes = crate::RouteTable::compile(config).unwrap();
        assert!(routes.matches(&http::Method::POST, "/api/v1/assistant-shares"));
        assert!(routes.matches(&http::Method::GET, "/api/v1/assistant-shares/7/team/weekly"));
        assert!(routes.matches(
            &http::Method::PATCH,
            "/api/v1/assistant-shares/7/team/weekly"
        ));
        assert!(routes.matches(
            &http::Method::DELETE,
            "/api/v1/assistant-shares/team/weekly/recipients/8"
        ));
    }

    #[test]
    fn direct_use_and_copy_are_independently_authorized() {
        let definition = serde_json::from_value(serde_json::json!({
            "kind":"assistant","definition":{"id":"data","name":"Data","prompt":"Review metrics"}
        }))
        .unwrap();
        let row = DefinitionRow {
            definition: Json(definition),
            revision: 1,
            allow_copy: false,
            direct_enabled: true,
        };
        assert!(snapshot_allowed(&row, "direct"));
        assert!(!snapshot_allowed(&row, "copy"));
        assert!(!snapshot_allowed(&row, "unknown"));
    }

    #[test]
    fn a_team_share_requires_its_exact_member_definitions() {
        let mut request: PublishShare = serde_json::from_value(serde_json::json!({
            "recipient_user_id":8,"allow_copy":true,
            "root":{"kind":"team","definition":{"id":"weekly","name":"Reports","leadId":"data","members":{"data":"Verify metrics"}}},
            "assistants":[{"kind":"assistant","definition":{"id":"data","name":"Data","prompt":"Review metrics"}}]
        })).unwrap();
        assert!(request.valid(7));
        assert!(!request.valid(8));
        request.assistants.clear();
        assert!(!request.valid(7));
    }
}

#[cfg(test)]
#[path = "assistant_shares_mysql_tests.rs"]
pub(crate) mod mysql_tests;
