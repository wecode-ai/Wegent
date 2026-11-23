use super::*;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct ResourceInvitation {
    pub kind: String,
    pub id: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub(super) struct ResourceParticipant {
    pub kind: String,
    pub id: i64,
    pub name: String,
    pub instructions: String,
    pub team_id: Option<i64>,
    pub human_ids: Vec<i32>,
    pub group_snapshot: Option<Value>,
}

#[derive(FromMysqlRow)]
struct Resource {
    name: String,
    definition: Json<Value>,
}

// Invitations retain explicit identities, never live membership or credential grants.
pub(super) async fn resolve<T: MysqlTransaction>(
    tx: &mut T,
    user: i32,
    invitations: &[ResourceInvitation],
) -> brz_mysql::MysqlResult<Option<Vec<ResourceParticipant>>> {
    let mut result = Vec::new();
    for invitation in invitations {
        let row: Option<Resource> = if invitation.kind == "agent" {
            tx.fetch_optional("SELECT name,`json` AS definition FROM kinds WHERE id=? AND kind='Team' AND user_id=? AND is_active=true FOR UPDATE",(invitation.id,user)).await?
        } else {
            tx.fetch_optional("SELECT k.name,k.`json` AS definition FROM kinds k WHERE k.id=? AND k.kind='CollaborationGroup' AND k.is_active=true AND EXISTS (SELECT 1 FROM resource_members grant_row JOIN kinds w ON CAST(grant_row.entity_id AS BINARY)=CAST(CAST(w.id AS CHAR) AS BINARY) AND w.kind='CollaborationWorkspace' AND w.is_active=true WHERE grant_row.resource_id=k.id AND grant_row.resource_type='CollaborationGroup' AND grant_row.entity_type='workspace' AND grant_row.status='approved' AND (w.user_id=? OR EXISTS (SELECT 1 FROM resource_members m WHERE m.resource_type='Workspace' AND m.resource_id=w.id AND m.entity_type='user' AND CAST(m.entity_id AS BINARY)=CAST(CAST(? AS CHAR) AS BINARY) AND m.status='approved' AND m.role IN ('Owner','Maintainer','Developer','Reporter','Viewer')))) FOR UPDATE",(invitation.id,user,user)).await?
        };
        let Some(row) = row else { return Ok(None) };
        let spec = &row.definition.0["spec"];
        let mut participant = ResourceParticipant {
            kind: invitation.kind.clone(),
            id: invitation.id,
            name: row.name,
            instructions: String::new(),
            team_id: None,
            human_ids: Vec::new(),
            group_snapshot: None,
        };
        if invitation.kind == "agent" {
            participant.team_id = Some(invitation.id);
        } else {
            participant.instructions = spec["instructions"].as_str().unwrap_or_default().into();
            let leader = &spec["leader"];
            participant.group_snapshot = Some(
                json!({"id":invitation.id.to_string(),"name":participant.name,"leader":leader,"members":spec["members"],"stages":spec["stages"],"instructions":spec["instructions"],"coordination_mode":"manager"}),
            );
            if leader["kind"] == "agent" {
                participant.team_id = leader["id"].as_str().and_then(|id| id.parse().ok());
            }
            for member in spec["members"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(std::iter::once(leader))
            {
                if member["kind"] == "human"
                    && let Some(id) = member["id"].as_str().and_then(|id| id.parse().ok())
                {
                    participant.human_ids.push(id);
                }
            }
        }
        result.push(participant);
    }
    Ok(Some(result))
}

pub(super) fn references(resources: &[ResourceParticipant]) -> Vec<ResourceInvitation> {
    resources
        .iter()
        .map(|r| ResourceInvitation {
            kind: r.kind.clone(),
            id: r.id,
        })
        .collect()
}
