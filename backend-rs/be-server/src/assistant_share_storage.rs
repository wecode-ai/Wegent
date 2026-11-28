//! Published definitions and scoped memberships stored in the existing schema.
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use wegent_protocol::assistant_share::{
    AssistantShareDefinition as Definition, VersionedShareDefinition,
};

pub(super) const PUBLICATIONS: &str = "(SELECT id,user_id AS owner_user_id,namespace AS resource_kind,name AS source_id,JSON_EXTRACT(json,'$.definition') AS definition,CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.revision')) AS UNSIGNED) AS revision FROM kinds WHERE kind='PersonalAssistantPublication' AND is_active=true AND namespace IN ('assistant','team'))";

pub(super) const SHARE: &str = "PersonalAssistantShare";
pub(super) const COPY: &str = "PersonalAssistantShareCopy";
pub(super) const DIRECT: &str = "PersonalAssistantShareDirect";
pub(super) const RECEIPT: &str = "PersonalAssistantCopyReceipt";

pub(super) const GRANTS: &str = "(SELECT g.resource_id,g.entity_id,g.user_id AS recipient_user_id,g.status,g.updated_at,
    c.id IS NOT NULL AS allow_copy,u.id IS NOT NULL AS direct_enabled
    FROM resource_members g
    LEFT JOIN resource_members c ON c.resource_type='PersonalAssistantShareCopy' AND c.resource_id=g.resource_id AND c.entity_type=g.entity_type AND c.entity_id=g.entity_id AND c.status='approved'
    LEFT JOIN resource_members u ON u.resource_type='PersonalAssistantShareDirect' AND u.resource_id=g.resource_id AND u.entity_type=g.entity_type AND u.entity_id=g.entity_id AND u.status='approved'
    WHERE g.resource_type='PersonalAssistantShare' AND g.entity_type='user')";

pub(super) const RECEIPTS: &str = "(SELECT resource_id,entity_id,user_id AS recipient_user_id FROM resource_members WHERE resource_type='PersonalAssistantCopyReceipt' AND entity_type='user' AND status='approved')";

pub(super) fn team_copy_access(recipient: &str, require_receipt: bool) -> String {
    // Assistant receipts can arrive before the enclosing team's receipt.
    // Reading updates requires both receipts and a current team grant.
    let receipt = if require_receipt {
        format!("JOIN {RECEIPTS} tr ON tr.resource_id=t.id AND tr.entity_id=tg.entity_id")
    } else {
        String::new()
    };
    format!("EXISTS (SELECT 1 FROM {PUBLICATIONS} t JOIN {GRANTS} tg ON tg.resource_id=t.id
        {receipt} WHERE t.owner_user_id=d.owner_user_id AND t.resource_kind='team' AND tg.entity_id={recipient}
        AND tg.status='approved' AND tg.allow_copy AND JSON_CONTAINS(JSON_KEYS(JSON_EXTRACT(t.definition,'$.definition.members')),JSON_QUOTE(d.source_id)))")
}

pub(super) fn active_definition() -> String {
    format!("(EXISTS (SELECT 1 FROM {GRANTS} g WHERE g.resource_id=d.id AND g.status='approved')
        OR (d.resource_kind='team' AND EXISTS (SELECT 1 FROM resource_members b JOIN kinds g ON g.id=CAST(b.entity_id AS UNSIGNED) AND g.kind='CollaborationGroup' JOIN resource_members p ON p.resource_type='CollaborationGroup' AND p.resource_id=g.id AND p.entity_type='project' AND p.status='approved' WHERE b.resource_type='PersonalTeamProjectBinding' AND b.resource_id=d.id AND b.entity_type='collaboration_group' AND b.status='approved' AND g.is_active=TRUE))
        OR (d.resource_kind='assistant' AND EXISTS (SELECT 1 FROM {PUBLICATIONS} t JOIN {GRANTS} tg ON tg.resource_id=t.id
        WHERE t.owner_user_id=d.owner_user_id AND t.resource_kind='team' AND tg.status='approved'
        AND JSON_CONTAINS(JSON_KEYS(JSON_EXTRACT(t.definition,'$.definition.members')),JSON_QUOTE(d.source_id)))))")
}

#[derive(FromMysqlRow)]
pub(super) struct Publication {
    pub id: i32,
    pub definition: Json<Definition>,
    pub revision: u64,
}

pub(super) async fn lock_publisher(
    tx: &mut impl MysqlTransaction,
    owner: i32,
) -> MysqlResult<bool> {
    // The kinds index is not unique. Serialize the publisher's mutations on
    // their existing account row before looking up or creating a publication.
    let owner: Option<(i32,)> = tx
        .fetch_optional("SELECT id FROM users WHERE id=? FOR UPDATE", (owner,))
        .await?;
    Ok(owner.is_some())
}

pub(super) async fn publication(
    tx: &mut impl MysqlTransaction,
    owner: i32,
    kind: &str,
    source: &str,
) -> MysqlResult<Option<Publication>> {
    tx.fetch_optional(
        format!("SELECT d.id,d.definition,d.revision FROM {PUBLICATIONS} d WHERE d.owner_user_id=? AND d.resource_kind=? AND d.source_id=? AND BINARY d.source_id=BINARY ?"),
        (owner,kind,source,source),
    ).await
}

pub(super) async fn insert_publication(
    tx: &mut impl MysqlTransaction,
    owner: i32,
    definition: &Definition,
) -> MysqlResult<i32> {
    let (kind, source) = definition.key();
    let document = VersionedShareDefinition {
        definition: definition.clone(),
        revision: 1,
    };
    let result = tx.execute(
        "INSERT INTO kinds(user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (?,'PersonalAssistantPublication',?,?,?,true,NOW(),NOW())",
        (owner,kind,source,Json(document)),
    ).await?;
    Ok(result.last_insert_id as i32)
}

pub(super) async fn update_publication(
    tx: &mut impl MysqlTransaction,
    old: &Publication,
    definition: &Definition,
) -> MysqlResult<()> {
    let document = VersionedShareDefinition {
        definition: definition.clone(),
        revision: old.revision + 1,
    };
    tx.execute(
        "UPDATE kinds SET json=?,updated_at=NOW() WHERE id=?",
        (Json(document), old.id),
    )
    .await?;
    if let Definition::Team(team) = definition {
        super::project_binding::refresh(tx, old.id, team, old.revision + 1).await?;
    }
    Ok(())
}

pub(super) async fn approve(
    tx: &mut impl MysqlTransaction,
    capability: &str,
    publication: i32,
    owner: i32,
    recipient: i32,
) -> MysqlResult<()> {
    tx.execute(
        "INSERT INTO resource_members(resource_type,resource_id,entity_type,entity_id,user_id,status,invited_by_user_id,requested_at,created_at,updated_at)
         VALUES (?,?,'user',?,?,'approved',?,NOW(),NOW(),NOW())
         ON DUPLICATE KEY UPDATE status='approved',updated_at=NOW()",
        (capability,publication,recipient.to_string(),recipient,owner),
    ).await?;
    Ok(())
}

pub(super) async fn remove(
    tx: &mut impl MysqlTransaction,
    capability: &str,
    publication: i32,
    recipient: i32,
) -> MysqlResult<()> {
    tx.execute(
        "DELETE FROM resource_members WHERE resource_type=? AND resource_id=? AND entity_type='user' AND entity_id=?",
        (capability,publication,recipient.to_string()),
    ).await?;
    Ok(())
}
