//! Reconcile committed personal settings with the owner's active publications.
use super::stand_in::settings_error;
use super::*;
use crate::task_runtime::personal_stand_in::assistant_share_definition;
use std::collections::HashSet;
use wegent_protocol::assistant_share::AssistantShareDefinition;

#[derive(serde::Deserialize)]
struct ShareSource {
    kind: String,
    source: String,
    revision: u64,
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn flush_assistant_shares(&self) -> Result<(), AppIpcError> {
        let Some(connection) = self.backend_connection_snapshot()?.filter(|connection| {
            !connection.backend_url.is_empty() && !connection.auth_token.is_empty()
        }) else {
            return Ok(());
        };
        let user = Self::connected_runtime_user(&connection).await?;
        let backend = connection.backend_url.as_str();
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for receipt in store
            .pending_assistant_share_copy_receipts(user, backend)
            .map_err(settings_error)?
        {
            Self::runtime_http_on(
                &connection,
                reqwest::Method::POST,
                &format!(
                    "/v1/assistant-shares/{}/{}/{}/copied",
                    receipt.owner, receipt.kind, receipt.source
                ),
                Some(&json!({"revision":receipt.revision})),
            )
            .await?;
            store
                .acknowledge_assistant_share_copy_receipt(user, backend, &receipt)
                .map_err(settings_error)?;
        }
        let Some(settings) = store
            .pending_assistant_share_sync(user, backend)
            .map_err(settings_error)?
        else {
            return Ok(());
        };
        let sources = Self::runtime_http_on(
            &connection,
            reqwest::Method::GET,
            "/v1/assistant-shares/owner-sync",
            None,
        )
        .await?;
        let sources: Vec<ShareSource> = serde_json::from_value(sources)
            .map_err(|_| AppIpcError::new("server_error", "Invalid assistant share sources"))?;
        let version = settings["version"]
            .as_u64()
            .ok_or_else(|| AppIpcError::new("server_error", "Invalid assistant share revision"))?;
        let published: HashSet<String> = sources
            .iter()
            .filter(|source| source.kind == "assistant")
            .map(|source| source.source.clone())
            .collect();
        // Reconcile the settings captured for this backend,
        // then acknowledge only the marker that was actually observed.
        for source in sources {
            if source.kind == "assistant"
                && source.source == "@primary"
                && !settings["primary"].is_object()
            {
                continue;
            }
            let Some(root) = assistant_share_definition(&settings, &source.kind, &source.source)
            else {
                continue;
            };
            let assistants =
                published_team_members(&connection, user, &settings, &root, &published).await?;
            Self::runtime_http_on(
                &connection,
                reqwest::Method::PUT,
                "/v1/assistant-shares/owner-sync",
                Some(&json!({"root":root,"assistants":assistants,"expected_revision":source.revision})),
            )
            .await?;
        }
        store
            .acknowledge_assistant_share_sync(user, backend, version)
            .map_err(settings_error)
    }
}

async fn published_team_members(
    connection: &ConnectionConfig,
    user: i64,
    settings: &Value,
    root: &AssistantShareDefinition,
    published: &HashSet<String>,
) -> Result<Vec<AssistantShareDefinition>, AppIpcError> {
    let AssistantShareDefinition::Team(team) = root else {
        return Ok(Vec::new());
    };
    let routes = crate::task_runtime::personal_stand_in::stand_in_team(settings, &team.id)
        .map(|team| team.member_routes)
        .unwrap_or_default();
    let mut definitions = Vec::new();
    let mut remote = Vec::new();
    for id in team.members.keys().filter(|id| !published.contains(*id)) {
        if let Some(route) = routes.get(id) {
            remote.push((id, route.execution_device_id.as_str()));
        } else if let Some(definition) = assistant_share_definition(settings, "assistant", id) {
            definitions.push(definition);
        }
    }
    if remote.is_empty() {
        return Ok(definitions);
    }
    let relay = super::stand_in_role_delegation::connect_role_relay(connection).await?;
    let result = async {
        for (id, device) in remote {
            definitions.push(relay.assistant_share_definition(device, user, id).await?);
        }
        Ok(definitions)
    }
    .await;
    relay.close().await;
    result
}
