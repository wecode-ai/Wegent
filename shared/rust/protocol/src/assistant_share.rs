//! Portable assistant configuration. Running an assistant requires a separate account context.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const ASSISTANT_SHARE_DEFINITION_METHOD: &str = "runtime.stand_in.share.definition";
pub const ASSISTANT_SHARE_DEFINITION_SCOPE: &str = "assistant-share-definition";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantDefinition {
    pub id: String,
    pub name: String,
    pub prompt: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssistantTeamDefinition {
    pub id: String,
    pub name: String,
    pub lead_id: String,
    pub members: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "definition", rename_all = "snake_case")]
pub enum AssistantShareDefinition {
    Assistant(AssistantDefinition),
    Team(AssistantTeamDefinition),
}

impl AssistantShareDefinition {
    pub fn key(&self) -> (&'static str, &str) {
        match self {
            Self::Assistant(assistant) => ("assistant", &assistant.id),
            Self::Team(team) => ("team", &team.id),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct VersionedShareDefinition {
    pub definition: AssistantShareDefinition,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AssistantShareSnapshot {
    pub owner_user_id: i32,
    pub root: VersionedShareDefinition,
    pub assistants: Vec<VersionedShareDefinition>,
}
