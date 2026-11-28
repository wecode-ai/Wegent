//! Account-owned assistant definitions and recipient-specific use grants.
use std::collections::{BTreeMap, BTreeSet};

#[path = "assistant_project_binding.rs"]
mod project_binding;
#[path = "assistant_share_storage.rs"]
mod storage;
use storage::{COPY, DIRECT, GRANTS, PUBLICATIONS, RECEIPT, RECEIPTS, SHARE};

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
    #[serde(default)]
    base_revisions: BTreeMap<String, u64>,
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
    publication_revisions: BTreeMap<String, u64>,
}

fn share_list_select() -> String {
    format!("SELECT d.owner_user_id,owner.user_name AS owner_name,g.recipient_user_id,recipient.user_name AS recipient_name,d.resource_kind,d.source_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(d.definition,'$.definition.name')) AS CHAR) AS name,d.revision,g.allow_copy,g.direct_enabled,g.status<>'approved' AS revoked,FALSE AS derived
        FROM {GRANTS} g JOIN {PUBLICATIONS} d ON d.id=g.resource_id
        JOIN users owner ON owner.id=d.owner_user_id JOIN users recipient ON recipient.id=g.recipient_user_id")
}

fn authorized_share() -> String {
    format!("SELECT d.definition,d.revision,g.allow_copy,g.direct_enabled FROM {PUBLICATIONS} d JOIN {GRANTS} g ON g.resource_id=d.id
        WHERE d.owner_user_id=? AND d.resource_kind=? AND d.source_id=? AND BINARY d.source_id=BINARY ? AND g.entity_id=? AND g.status='approved'")
}

#[brz_http_server::get("/api/v1/assistant-shares")]
async fn list_shares(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<ShareList, FastApiError> {
    let id = user.0.id;
    let select = share_list_select();
    let team_copy_access = storage::team_copy_access("c.entity_id", true);
    state.mysql.with_transaction(async |tx| {
        let mut received: Vec<ShareListEntry> = tx
            .fetch_all(
                format!("{select} WHERE g.entity_id=? ORDER BY g.updated_at DESC"),
                (id.to_string(),),
            )
             .await?;
        let derived: Vec<ShareListEntry> = tx
            .fetch_all(
                format!(
                    "SELECT d.owner_user_id,owner.user_name AS owner_name,c.recipient_user_id,recipient.user_name AS recipient_name,d.resource_kind,d.source_id,CAST(JSON_UNQUOTE(JSON_EXTRACT(d.definition,'$.definition.name')) AS CHAR) AS name,d.revision,TRUE AS allow_copy,FALSE AS direct_enabled,FALSE AS revoked,TRUE AS derived
                    FROM {RECEIPTS} c JOIN {PUBLICATIONS} d ON d.id=c.resource_id
                    JOIN users owner ON owner.id=d.owner_user_id JOIN users recipient ON recipient.id=c.recipient_user_id
                    WHERE c.entity_id=? AND d.resource_kind='assistant' AND {team_copy_access}"
                ),
                (id.to_string(),),
            )
             .await?;
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
        let sent = tx
            .fetch_all(
                format!("{select} WHERE d.owner_user_id=? ORDER BY g.updated_at DESC"),
                (id,),
            )
             .await?;
        let revisions: Vec<(String, u64)> = tx.fetch_all(
            format!("SELECT CONCAT(d.resource_kind, ':', d.source_id), d.revision FROM {PUBLICATIONS} d WHERE d.owner_user_id=?"),
            (id,),
        ).await?;
        Ok(ShareList {
            received,
            sent,
            publication_revisions: revisions.into_iter().collect(),
        })
    }).await.map_err(internal)
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
    let result =
        state
            .mysql
            .with_transaction(async |tx| {
                if !storage::lock_publisher(tx, owner).await? {
                    return Ok(PublishOutcome::Missing);
                }
                let active: Option<UserRow> = tx
                    .fetch_optional(
                        "SELECT id FROM users WHERE id=? AND is_active=true",
                        (recipient,),
                    )
                    .await?;
                let Some(recipient) = active.map(|row| row.id) else {
                    return Ok(PublishOutcome::Missing);
                };
                for definition in std::iter::once(&body.root).chain(&body.assistants) {
                    let (kind, source) = definition.key();
                    if let Some(current) = storage::publication(tx, owner, kind, source).await?
                        && &current.definition.0 != definition
                        && body.base_revisions.get(&format!("{kind}:{source}"))
                            != Some(&current.revision)
                    {
                        return Ok(PublishOutcome::Conflict);
                    }
                }
                // Publish members and the root in the same transaction as the grant.
                let mut notices = Vec::new();
                for member in &body.assistants {
                    publish_definition(tx, owner, member, &mut notices).await?;
                }
                let root = publish_definition(tx, owner, &body.root, &mut notices).await?;
                let prior = grant_state(tx, root, recipient).await?;
                storage::approve(tx, SHARE, root, owner, recipient).await?;
                if body.allow_copy {
                    storage::approve(tx, COPY, root, owner, recipient).await?;
                } else {
                    storage::remove(tx, COPY, root, recipient).await?;
                }
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
                let row: DefinitionRow = tx
                    .fetch_one(
                        authorized_share(),
                        (owner, kind, source, source, recipient.to_string()),
                    )
                    .await?;
                Ok(PublishOutcome::Published(row.into_preview(owner), notices))
            })
            .await
            .map_err(internal)?;
    let (preview, notices) = match result {
        PublishOutcome::Missing => return Err(missing()),
        PublishOutcome::Conflict => {
            return Err(FastApiError::detail(
                StatusCode::CONFLICT,
                "Assistant publication changed while preparing the share",
            ));
        }
        PublishOutcome::Published(preview, notices) => (preview, notices),
    };
    for notification in notices {
        notifications::deliver(state, notification).await;
    }
    Ok(preview)
}

enum PublishOutcome {
    Missing,
    Conflict,
    Published(
        SharePreview,
        Vec<crate::background_jobs::project::notifications::Pending>,
    ),
}

async fn publish_definition(
    tx: &mut impl MysqlTransaction,
    owner: i32,
    definition: &Definition,
    notices: &mut Vec<crate::background_jobs::project::notifications::Pending>,
) -> brz_mysql::MysqlResult<i32> {
    let (kind, source) = definition.key();
    let Some(old) = storage::publication(tx, owner, kind, source).await? else {
        return storage::insert_publication(tx, owner, definition).await;
    };
    if &old.definition.0 != definition {
        storage::update_publication(tx, &old, definition).await?;
        notices.extend(definition_update_notices(tx, owner, definition, old.id).await?);
    }
    Ok(old.id)
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
    let row: Option<DefinitionRow> = state
        .mysql
        .with_transaction(async |tx| {
            if !storage::lock_publisher(tx, owner).await? {
                return Ok(None);
            }
            if let Some(root) = storage::publication(tx, owner, kind, source).await?
                && grant_state(tx, root.id, recipient)
                    .await?
                    .is_some_and(|row| row.active)
            {
                if body.enabled {
                    storage::approve(tx, DIRECT, root.id, owner, recipient).await?;
                } else {
                    storage::remove(tx, DIRECT, root.id, recipient).await?;
                }
            }
            tx.fetch_optional(
                authorized_share(),
                (owner, kind, source, source, recipient.to_string()),
            )
            .await
        })
        .await
        .map_err(internal)?;
    row.map(|row| row.into_preview(owner)).ok_or_else(missing)
}

#[brz_http_server::delete("/api/v1/assistant-shares/:kind/:source/recipients/:recipient")]
async fn revoke_share(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    kind: &str,
    source: &str,
    recipient: i32,
) -> Result<serde_json::Value, FastApiError> {
    let owner = user.0.id;
    state.mysql.with_transaction(async |tx| {
        if !storage::lock_publisher(tx, owner).await? { return Ok(()); }
        if let Some(root) = storage::publication(tx, owner, kind, source).await? {
            tx.execute(
                "UPDATE resource_members SET status='revoked',updated_at=NOW() WHERE resource_type=? AND resource_id=? AND entity_type='user' AND entity_id=? AND status='approved'",
                (SHARE,root.id,recipient.to_string()),
            ).await?;
            storage::remove(tx, DIRECT, root.id, recipient).await?;
            storage::remove(tx, COPY, root.id, recipient).await?;
        }
        Ok(())
    }).await.map_err(internal)?;
    Ok(serde_json::json!({"revoked":true}))
}

async fn grant_state(
    tx: &mut impl MysqlTransaction,
    publication: i32,
    recipient: i32,
) -> brz_mysql::MysqlResult<Option<GrantState>> {
    tx.fetch_optional(
        "SELECT status='approved' AS active FROM resource_members WHERE resource_type=? AND resource_id=? AND entity_type='user' AND entity_id=?",
        (SHARE,publication,recipient.to_string()),
    ).await
}

async fn preview(
    mysql: &impl Mysql,
    owner: i32,
    kind: &str,
    source: &str,
    recipient: i32,
) -> Result<SharePreview, FastApiError> {
    let row: Option<DefinitionRow> = mysql
        .fetch_optional(
            authorized_share(),
            (owner, kind, source, source, recipient.to_string()),
        )
        .await
        .map_err(internal)?;
    row.map(|row| row.into_preview(owner)).ok_or_else(missing)
}

impl DefinitionRow {
    fn into_preview(self, owner: i32) -> SharePreview {
        SharePreview {
            owner_user_id: owner,
            definition: self.definition.0,
            revision: self.revision,
            allow_copy: self.allow_copy,
            direct_enabled: self.direct_enabled,
        }
    }
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
    let team_copy_access = storage::team_copy_access("c.entity_id", true);
    let snapshot = state.mysql.with_transaction(async |tx| {
        let root: Option<DefinitionRow> = tx.fetch_optional(
            authorized_share(),
            (owner,kind,source,source,recipient.to_string()),
        ).await?;
        let root = match root.filter(|row| snapshot_allowed(row, mode)) {
            Some(root) => Some(root),
            None if kind == "assistant" && mode == "copy" => tx.fetch_optional(
                format!("SELECT d.definition,d.revision,TRUE AS allow_copy,FALSE AS direct_enabled FROM {RECEIPTS} c JOIN {PUBLICATIONS} d ON d.id=c.resource_id
                    WHERE d.owner_user_id=? AND d.resource_kind='assistant' AND d.source_id=? AND BINARY d.source_id=BINARY ? AND c.entity_id=? AND {team_copy_access}"),
                (owner,source,source,recipient.to_string()),
            ).await?,
            None => None,
        };
        let Some(root) = root else { return Ok(None); };
        let mut assistants = Vec::new();
        if let Definition::Team(team) = &root.definition.0 {
            for id in team.members.keys() {
                let assistant = storage::publication(tx, owner, "assistant", id).await?;
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    roster_only: bool,
    kind: String,
    source: String,
    revision: u64,
}

#[brz_http_server::get("/api/v1/assistant-shares/owner-sync")]
async fn owned_share_sources(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<Vec<ShareSource>, FastApiError> {
    let active_definition = storage::active_definition();
    state.mysql.fetch_all(
        format!("SELECT d.resource_kind AS kind,d.source_id AS source,d.revision,(d.resource_kind='team' AND NOT EXISTS(SELECT 1 FROM resource_members g WHERE g.resource_type='{SHARE}' AND g.resource_id=d.id AND g.entity_type='user' AND g.status='approved')) AS roster_only FROM {PUBLICATIONS} d WHERE d.owner_user_id=? AND {active_definition}"),
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
        if !storage::lock_publisher(tx, owner).await? { return Ok(SyncOutcome::Inactive); }
        let old: Option<storage::Publication> = tx.fetch_optional(
            format!("SELECT d.id,d.definition,d.revision FROM {PUBLICATIONS} d WHERE d.owner_user_id=? AND d.resource_kind=? AND d.source_id=? AND BINARY d.source_id=BINARY ? AND {}", storage::active_definition()),
            (owner,kind,source,source),
        ).await?;
        let Some(old) = old else { return Ok(SyncOutcome::Inactive); };
        if old.definition.0 == body.root {
            return Ok(SyncOutcome::Committed(Vec::new()));
        }
        if old.revision != body.expected_revision {
            return Ok(SyncOutcome::VersionConflict);
        }
        if let Definition::Team(team) = &body.root {
            let active: Option<i64> = tx.fetch_optional("SELECT 1 FROM resource_members WHERE resource_type=? AND resource_id=? AND entity_type='user' AND status='approved' LIMIT 1",(SHARE,old.id)).await?;
            if active.is_none() {
                storage::update_publication(tx, &old, &body.root).await?;
                return Ok(SyncOutcome::Committed(Vec::new()));
            }
            let supplied: std::collections::BTreeSet<_> = body.assistants.iter().map(|row| row.key().1).collect();
            for id in team.members.keys() {
                if !supplied.contains(id.as_str()) && storage::publication(tx, owner, "assistant", id).await?.is_none() {
                    return Ok(SyncOutcome::MissingMember);
                }
            }
        }
        let mut notices = Vec::new();
        for member in &body.assistants {
            // Active assistants have their own revision-checked sync source.
            // A team payload can only seed a new or currently inactive publication.
            let (_, source) = member.key();
            let active: Option<(i32,)> = tx.fetch_optional(
                format!(
                    "SELECT d.id FROM {PUBLICATIONS} d WHERE d.owner_user_id=? AND d.resource_kind='assistant' AND d.source_id=? AND BINARY d.source_id=BINARY ? AND {}",
                    storage::active_definition()
                ),
                (owner, source, source),
            ).await?;
            if active.is_some() {
                continue;
            }
            publish_definition(tx, owner, member, &mut notices).await?;
        }
        storage::update_publication(tx, &old, &body.root).await?;
        notices.extend(definition_update_notices(tx, owner, &body.root, old.id).await?);
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
    publication: i32,
) -> brz_mysql::MysqlResult<Vec<crate::background_jobs::project::notifications::Pending>> {
    use crate::background_jobs::project::notifications;
    let (kind, source) = definition.key();
    let team_copy_access = storage::team_copy_access("c.entity_id", true);
    let recipients: Vec<(i32,)> = tx.fetch_all(
        format!("SELECT c.recipient_user_id FROM {RECEIPTS} c JOIN {PUBLICATIONS} d ON d.id=c.resource_id
            LEFT JOIN {GRANTS} g ON g.resource_id=c.resource_id AND g.entity_id=c.entity_id AND g.status='approved' AND g.allow_copy
            WHERE c.resource_id=? AND (g.resource_id IS NOT NULL OR (d.resource_kind='assistant' AND {team_copy_access}))"),
        (publication,),
    ).await?;
    let mut notices = Vec::new();
    for (recipient,) in recipients {
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
    let recipient = user.0.id;
    let team_copy_access = storage::team_copy_access("?", false);
    let accepted = state.mysql.with_transaction(async |tx| {
        if !storage::lock_publisher(tx, owner).await? { return Ok(false); }
        let allowed: Option<(i32,)> = tx.fetch_optional(
            format!("SELECT d.id FROM {PUBLICATIONS} d
                LEFT JOIN {GRANTS} g ON g.resource_id=d.id AND g.entity_id=? AND g.status='approved' AND g.allow_copy
                WHERE d.owner_user_id=? AND d.resource_kind=? AND d.source_id=? AND BINARY d.source_id=BINARY ? AND d.revision>=?
                AND (g.resource_id IS NOT NULL OR (d.resource_kind='assistant' AND {team_copy_access}))"),
            (recipient.to_string(),owner,kind,source,source,body.revision,recipient.to_string()),
        ).await?;
        if let Some((id,)) = allowed {
            storage::approve(tx, RECEIPT, id, owner, recipient).await?;
            return Ok(true);
        }
        Ok(false)
    }).await.map_err(internal)?;
    Ok(serde_json::json!({"accepted":accepted}))
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
        assert!(routes.matches(
            &http::Method::PUT,
            "/api/v1/cloud-projects/8201/personal-team-bindings/weekly"
        ));
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
