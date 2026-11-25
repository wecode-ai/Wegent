//! Account-owned personal assistant definitions and atomic first-time initialization.
use std::collections::{BTreeSet, HashMap, HashSet};

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlError, MysqlResult, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    attachments::upload::Param, auth::SessionUser, http_compat::FastApiError, state::AppState,
};

const NAMESPACE: &str = "personal-assistant";
const ACCOUNT_KIND: &str = "PersonalAssistantSettings";
const DEFAULT_NAME: &str = "primary";
const SELECT: &str = "SELECT kind,name,json AS document FROM kinds WHERE user_id=? AND namespace=? AND kind IN ('PersonalAssistantSettings','Bot','Ghost') AND is_active=true";

#[derive(FromMysqlRow)]
struct Row {
    kind: String,
    name: String,
    document: Json<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Definition {
    execution_device_id: Option<String>,
    role_id: String,
    name: String,
    prompt: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Initialize {
    definitions: Vec<Definition>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DefinitionChange {
    revision: String,
    desired: Initialize,
}

impl Initialize {
    fn valid(&self) -> bool {
        let mut ids = HashSet::new();
        self.definitions.len() <= 101
            && self
                .definitions
                .iter()
                .map(|definition| definition.prompt.len())
                .sum::<usize>()
                <= 2 * 1024 * 1024
            && self.definitions.iter().all(|definition| {
                let id = definition.role_id.as_str();
                ids.insert(id)
                    && (id == "@primary"
                        || (!id.is_empty()
                            && id.len() <= 64
                            && id.bytes().all(|byte| {
                                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
                            })))
                    && definition
                        .execution_device_id
                        .as_ref()
                        .is_none_or(|id| !id.is_empty() && id.len() <= 255)
                    && definition.name.chars().count() <= 255
                    && definition.prompt.len() <= 256 * 1024
            })
            && ids.contains("@primary")
    }
}

fn internal(error: MysqlError) -> FastApiError {
    tracing::error!(%error, "Personal assistant account storage failed");
    FastApiError::internal()
}

fn view(rows: &[Row]) -> MysqlResult<Value> {
    let resources: HashMap<_, _> = rows
        .iter()
        .map(|row| ((row.kind.as_str(), row.name.as_str()), &row.document.0))
        .collect();
    let Some(account) = resources.get(&(ACCOUNT_KIND, DEFAULT_NAME)) else {
        return Ok(json!({"assistant":null}));
    };
    let spec = &account["spec"];
    let identities = spec["identities"]
        .as_array()
        .ok_or(MysqlError::RowNotFound)?;
    let definitions = identities
        .iter()
        .map(|identity| {
            let name = identity["botRef"]["name"]
                .as_str()
                .ok_or(MysqlError::RowNotFound)?;
            let bot = resources
                .get(&("Bot", name))
                .ok_or(MysqlError::RowNotFound)?;
            let ghost_name = bot["spec"]["ghostRef"]["name"]
                .as_str()
                .ok_or(MysqlError::RowNotFound)?;
            let ghost = resources
                .get(&("Ghost", ghost_name))
                .ok_or(MysqlError::RowNotFound)?;
            Ok(json!({"roleId":identity["roleId"],"bot":bot,"ghost":ghost}))
        })
        .collect::<MysqlResult<Vec<_>>>()?;
    let retired = spec["retiredRoleIds"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let revision = crate::hex_sha256(json!([definitions, retired]).to_string().as_bytes());
    Ok(
        json!({"assistant":{"defaultBotRef":spec["defaultBotRef"],"revision":revision,"definitions":definitions,"retiredRoleIds":retired}}),
    )
}

fn resource(kind: &str, name: &str, display_name: &str, spec: Value) -> Value {
    json!({
        "apiVersion":"agent.wecode.io/v1",
        "kind":kind,
        "metadata":{"name":name,"namespace":NAMESPACE,"displayName":display_name},
        "spec":spec,
        "status":{"state":"Available"}
    })
}

fn definition_documents(definition: Definition) -> (Value, Value, Value) {
    let name = if definition.role_id == "@primary" {
        DEFAULT_NAME.to_string()
    } else {
        // Kind names are compared case-insensitively by MySQL.
        crate::hex_sha256(definition.role_id.as_bytes())
    };
    let reference = json!({"name":name,"namespace":NAMESPACE});
    let ghost = resource(
        "Ghost",
        &name,
        &definition.name,
        json!({"systemPrompt":definition.prompt}),
    );
    let mut bot = resource(
        "Bot",
        &name,
        &definition.name,
        json!({
            "ghostRef":reference,"shellRef":{"name":"Codex","namespace":"default"},
            "execution_policy":{"mode":"user_select"},"model_policy":{"mode":"user_select"}
        }),
    );
    if let Some(device) = definition.execution_device_id {
        bot["spec"]["execution_policy"] = json!({"mode":"fixed","environment_id":device});
    }
    (
        json!({"roleId":definition.role_id,"botRef":reference}),
        bot,
        ghost,
    )
}

async fn create_definitions(
    tx: &mut impl MysqlTransaction,
    user: i64,
    request: Initialize,
) -> MysqlResult<()> {
    let mut identities = Vec::with_capacity(request.definitions.len());
    let mut records = Vec::with_capacity(2 * request.definitions.len() + 1);
    for definition in request.definitions {
        let (identity, bot, ghost) = definition_documents(definition);
        records.extend([ghost, bot]);
        identities.push(identity);
    }
    let account = resource(
        ACCOUNT_KIND,
        DEFAULT_NAME,
        "",
        json!({
            "defaultBotRef":{"name":DEFAULT_NAME,"namespace":NAMESPACE},
            "identities":identities
        }),
    );
    records.push(account);
    insert_documents(tx, user, records).await
}

async fn insert_documents(
    tx: &mut impl MysqlTransaction,
    user: i64,
    records: Vec<Value>,
) -> MysqlResult<()> {
    let placeholders = vec!["(?,?,?,?,?,true,NOW(),NOW())"; records.len()].join(",");
    let params: Vec<Param> = records
        .into_iter()
        .flat_map(|document| {
            [
                Param::Int(user),
                Param::Text(document["kind"].as_str().unwrap_or_default().to_string()),
                Param::Text(
                    document["metadata"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                ),
                Param::Text(NAMESPACE.to_string()),
                Param::Text(document.to_string()),
            ]
        })
        .collect();
    tx.execute(
        format!("INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES {placeholders}"),
        params,
    ).await?;
    Ok(())
}

#[brz_http_server::get("/api/v1/personal-assistant")]
async fn get(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<Value, FastApiError> {
    let rows = state
        .mysql
        .fetch_all(SELECT, (i64::from(user.id), NAMESPACE))
        .await
        .map_err(internal)?;
    view(&rows).map_err(internal)
}

#[brz_http_server::post("/api/v1/personal-assistant")]
async fn initialize(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: Initialize,
) -> Result<Value, FastApiError> {
    if !body.valid() {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid personal assistant definitions",
        ));
    }
    initialize_for(&state.mysql, i64::from(user.id), body)
        .await
        .map_err(internal)
}

async fn initialize_for(
    mysql: &brz_mysql::MysqlService,
    user: i64,
    body: Initialize,
) -> MysqlResult<Value> {
    mysql
        .with_transaction(async |tx| {
            // Acquire the existing user row before the first consistent read. Concurrent
            // initializers see the winner's commit without locking an empty Kind index range.
            let _: (i64,) = tx
                .fetch_optional(
                    "SELECT id FROM users WHERE id=? AND is_active=true FOR UPDATE",
                    (user,),
                )
                .await?
                .ok_or(MysqlError::RowNotFound)?;
            let current = view(&tx.fetch_all(SELECT, (user, NAMESPACE)).await?)?;
            if !current["assistant"].is_null() {
                return Ok(current);
            }
            create_definitions(tx, user, body).await?;
            view(&tx.fetch_all(SELECT, (user, NAMESPACE)).await?)
        })
        .await
}

#[brz_http_server::patch("/api/v1/personal-assistant")]
async fn update_definition(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: DefinitionChange,
) -> Result<Value, FastApiError> {
    if !body.desired.valid() {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid assistant instructions",
        ));
    }
    let outcome = replace_definitions(&state.mysql, i64::from(user.id), body)
        .await
        .map_err(internal)?;
    outcome.ok_or_else(|| {
        FastApiError::detail(
            StatusCode::CONFLICT,
            "Assistant definition changed. Reload and try again.",
        )
    })
}

async fn replace_definitions(
    mysql: &brz_mysql::MysqlService,
    user: i64,
    body: DefinitionChange,
) -> MysqlResult<Option<Value>> {
    mysql.with_transaction(async |tx| {
        let _: (i64,) = tx.fetch_optional("SELECT id FROM users WHERE id=? AND is_active=true FOR UPDATE", (user,))
            .await?.ok_or(MysqlError::RowNotFound)?;
        let mut rows: Vec<Row> = tx.fetch_all(SELECT, (user, NAMESPACE)).await?;
        let current = view(&rows)?;
        if current["assistant"]["revision"] != body.revision {
            return Ok(None);
        }
        let existing = current["assistant"]["definitions"].as_array().ok_or(MysqlError::RowNotFound)?;
        let mut previous: HashMap<_, _> = existing.iter()
            .filter_map(|entry| Some((entry["roleId"].as_str()?, entry)))
            .collect();
        let mut identities = Vec::with_capacity(body.desired.definitions.len());
        let mut additions = Vec::new();
        let mut retired: BTreeSet<String> = current["assistant"]["retiredRoleIds"]
            .as_array().into_iter().flatten().filter_map(|id| id.as_str().map(str::to_owned)).collect();
        for desired in body.desired.definitions {
            retired.remove(&desired.role_id);
            if let Some(entry) = previous.remove(desired.role_id.as_str()) {
                let mut bot = entry["bot"].clone();
                let mut ghost = entry["ghost"].clone();
                if let Some(device) = desired.execution_device_id {
                    bot["spec"]["execution_policy"] = json!({"mode":"fixed","environment_id":device});
                }
                bot["metadata"]["displayName"] = json!(desired.name);
                ghost["metadata"]["displayName"] = bot["metadata"]["displayName"].clone();
                ghost["spec"]["systemPrompt"] = json!(desired.prompt);
                if bot != entry["bot"] {
                    update_document(tx, user, &bot).await?;
                }
                if ghost != entry["ghost"] {
                    update_document(tx, user, &ghost).await?;
                }
                identities.push(json!({
                    "roleId":desired.role_id,
                    "botRef":{"name":bot["metadata"]["name"],"namespace":NAMESPACE}
                }));
            } else {
                let (identity, bot, ghost) = definition_documents(desired);
                identities.push(identity);
                additions.extend([ghost, bot]);
            }
        }
        for entry in previous.into_values() {
            let role_id = entry["roleId"].as_str().ok_or(MysqlError::RowNotFound)?;
            retired.insert(role_id.to_string());
            for resource in ["bot", "ghost"] {
                let document = &entry[resource];
                let (kind, name) = document_key(document)?;
                tx.execute(
                    "UPDATE kinds SET is_active=false,updated_at=NOW() WHERE user_id=? AND kind=? AND namespace=? AND name=? AND is_active=true",
                    (user,kind,NAMESPACE,name)
                ).await?;
            }
        }
        if !additions.is_empty() {
            insert_documents(tx, user, additions).await?;
        }
        let account = rows.iter_mut().find(|row| row.kind == ACCOUNT_KIND && row.name == DEFAULT_NAME)
            .ok_or(MysqlError::RowNotFound)?;
        account.document.0["spec"]["identities"] = json!(identities);
        account.document.0["spec"]["retiredRoleIds"] = json!(retired);
        update_document(tx, user, &account.document.0).await?;
        view(&tx.fetch_all(SELECT, (user, NAMESPACE)).await?).map(Some)
    }).await
}

fn document_key(document: &Value) -> MysqlResult<(&str, &str)> {
    let kind = document["kind"].as_str().ok_or(MysqlError::RowNotFound)?;
    let name = document["metadata"]["name"]
        .as_str()
        .ok_or(MysqlError::RowNotFound)?;
    Ok((kind, name))
}

async fn update_document(
    tx: &mut impl MysqlTransaction,
    user: i64,
    document: &Value,
) -> MysqlResult<()> {
    let (kind, name) = document_key(document)?;
    tx.execute(
        "UPDATE kinds SET json=?,updated_at=NOW() WHERE user_id=? AND kind=? AND namespace=? AND name=? AND is_active=true",
        (Json(document),user,kind,NAMESPACE,name)
    ).await?;
    Ok(())
}

#[cfg(test)]
pub(crate) async fn verify_concurrent_initialization(
    mysql: &brz_mysql::MysqlService,
) -> anyhow::Result<()> {
    let user: i64 = 912045;
    mysql.execute(
        "INSERT INTO users (id,user_name,password_hash,role,auth_source,preferences,is_active) VALUES (?,'personal-assistant-test','fixture','user','local','{}',true)",
        (user,),
    ).await?;
    let request = |prompt: &str| Initialize {
        definitions: vec![
            Definition {
                execution_device_id: None,
                role_id: "@primary".into(),
                name: "Assistant".into(),
                prompt: prompt.into(),
            },
            Definition {
                execution_device_id: None,
                role_id: "support".into(),
                name: "Support".into(),
                prompt: "Help".into(),
            },
        ],
    };
    let (first, second) = tokio::try_join!(
        initialize_for(mysql, user, request("first")),
        initialize_for(mysql, user, request("second")),
    )?;
    assert_eq!(first, second);
    assert_eq!(
        first["assistant"]["definitions"].as_array().unwrap().len(),
        2
    );
    let rows: Vec<Row> = mysql.fetch_all(SELECT, (user, NAMESPACE)).await?;
    assert_eq!(rows.len(), 5);
    assert_eq!(view(&rows)?, first);
    let revision = first["assistant"]["revision"].as_str().unwrap();
    let changes = || {
        let mut desired = request("updated on the second device");
        desired.definitions[0].execution_device_id = Some("device-2".into());
        desired.definitions[1].role_id = "operations".into();
        DefinitionChange {
            revision: revision.to_owned(),
            desired,
        }
    };
    let updated = replace_definitions(mysql, user, changes()).await?.unwrap();
    assert_eq!(
        updated["assistant"]["definitions"][0]["bot"]["spec"]["execution_policy"],
        json!({"mode":"fixed","environment_id":"device-2"})
    );
    assert_eq!(updated["assistant"]["retiredRoleIds"], json!(["support"]));
    assert_eq!(
        updated["assistant"]["definitions"][1]["roleId"],
        "operations"
    );
    assert_eq!(
        updated["assistant"]["definitions"][0]["ghost"]["spec"]["systemPrompt"],
        "updated on the second device"
    );
    assert!(replace_definitions(mysql, user, changes()).await?.is_none());
    let rows: Vec<Row> = mysql.fetch_all(SELECT, (user, NAMESPACE)).await?;
    assert_eq!(view(&rows)?, updated);
    Ok(())
}
