//! Account-owned personal assistant definitions and atomic first-time initialization.
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlError, MysqlResult, MysqlTransaction};
use serde::{Deserialize, Serialize};
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

#[derive(Deserialize)]
#[serde(untagged)]
enum AccountChange {
    Definitions(DefinitionChange),
    StopIntent(StopIntentUpdate),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopIntentUpdate {
    stop_intent: StopIntentChange,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopIntentChange {
    device_id: String,
    operation: StopIntentOperation,
    request_id: String,
    expected_request_id: Option<String>,
    expected_version: Option<i64>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StopIntentOperation {
    Mark,
    Clear,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StopIntentState {
    request_id: String,
    pending: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_version: Option<i64>,
}

type StopIntentStates = BTreeMap<String, StopIntentState>;

impl StopIntentChange {
    fn valid(&self) -> bool {
        !self.device_id.trim().is_empty()
            && self.device_id.len() <= 255
            && valid_stop_request_id(&self.request_id)
            && match self.operation {
                StopIntentOperation::Mark => {
                    self.expected_request_id
                        .as_deref()
                        .is_none_or(valid_stop_request_id)
                        && self.expected_version.is_none_or(|version| version >= 0)
                }
                StopIntentOperation::Clear => {
                    self.expected_request_id.is_none() && self.expected_version.is_none()
                }
            }
    }
}

fn valid_stop_request_id(request_id: &str) -> bool {
    !request_id.is_empty()
        && request_id.len() <= 128
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn stop_intent_states(spec: &Value) -> MysqlResult<StopIntentStates> {
    match spec.get("stopIntentStates") {
        Some(value) => {
            serde_json::from_value(value.clone()).map_err(|_| MysqlError::InvalidQuery {
                reason: "Invalid personal assistant stop intent state".into(),
            })
        }
        None => Ok(BTreeMap::new()),
    }
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
    let mut result = json!({"assistant":{"defaultBotRef":spec["defaultBotRef"],"revision":revision,"definitions":definitions,"retiredRoleIds":retired}});
    let states = stop_intent_states(spec)?;
    if !states.is_empty() {
        let generations: BTreeMap<_, _> = states
            .iter()
            .map(|(device, state)| (device, &state.request_id))
            .collect();
        result["assistant"]["stopIntentGenerations"] = json!(generations);
    }
    let pending: Vec<_> = states
        .into_iter()
        .filter(|(_, state)| state.pending)
        .map(|(device, state)| {
            let mut intent = json!({"deviceId":device,"requestId":state.request_id});
            if let Some(version) = state.expected_version {
                intent["expectedVersion"] = json!(version);
            }
            intent
        })
        .collect();
    if !pending.is_empty() {
        result["assistant"]["stopIntents"] = json!(pending);
    }
    Ok(result)
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
    read_account(&state.mysql, i64::from(user.id))
        .await
        .map_err(internal)
}

async fn read_account(mysql: &brz_mysql::MysqlService, user: i64) -> MysqlResult<Value> {
    // Device lifecycle decisions need current stop intents, including marks
    // committed by another client before this request. Read from the writer.
    mysql
        .with_transaction(async |tx| view(&tx.fetch_all(SELECT, (user, NAMESPACE)).await?))
        .await
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
async fn update(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: AccountChange,
) -> Result<Value, FastApiError> {
    let user = i64::from(user.id);
    match body {
        AccountChange::Definitions(change) => update_definition(state, user, change).await,
        AccountChange::StopIntent(change) => {
            update_stop_intent(state, user, change.stop_intent).await
        }
    }
}

async fn update_definition(
    state: &AppState,
    user: i64,
    body: DefinitionChange,
) -> Result<Value, FastApiError> {
    if !body.desired.valid() {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid assistant instructions",
        ));
    }
    let outcome = replace_definitions(&state.mysql, user, body)
        .await
        .map_err(internal)?;
    outcome.ok_or_else(|| {
        FastApiError::detail(
            StatusCode::CONFLICT,
            "Assistant definition changed. Reload and try again.",
        )
    })
}

#[derive(Debug, PartialEq, Eq)]
enum StopIntentOutcome {
    Updated(Value),
    DeviceNotFound,
    Conflict,
    AssistantNotFound,
}

async fn update_stop_intent(
    state: &AppState,
    user: i64,
    body: StopIntentChange,
) -> Result<Value, FastApiError> {
    if !body.valid() {
        return Err(FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid assistant stop intent",
        ));
    }
    match set_stop_intent(&state.mysql, user, body)
        .await
        .map_err(internal)?
    {
        StopIntentOutcome::Updated(view) => Ok(view),
        StopIntentOutcome::DeviceNotFound => Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Device not found or not accessible",
        )),
        StopIntentOutcome::AssistantNotFound => Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Personal assistant is not initialized",
        )),
        StopIntentOutcome::Conflict => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Assistant stop intent changed. Reload and try again.",
        )),
    }
}

fn apply_stop_intent(
    states: &mut StopIntentStates,
    device_id: String,
    change: StopIntentChange,
) -> Result<bool, ()> {
    let current = states.get_mut(&device_id);
    match (change.operation, current) {
        // The current request is idempotent even after it was cleared. Keep
        // its tombstone as the expected generation for a fresh stop request.
        (StopIntentOperation::Mark, Some(state)) if state.request_id == change.request_id => {
            if state.expected_version == change.expected_version {
                Ok(false)
            } else {
                Err(())
            }
        }
        (StopIntentOperation::Mark, current) => {
            if current.as_ref().map(|state| state.request_id.as_str())
                != change.expected_request_id.as_deref()
            {
                return Err(());
            }
            if let Some(state) = current.filter(|state| state.pending) {
                // An explicit new confirmation can replace an unresolved generation
                // only with a newer observed profile, never with an unknown or older one.
                if change.expected_version.is_none()
                    || state.expected_version == change.expected_version
                {
                    return Ok(false);
                }
                if state.expected_version > change.expected_version {
                    return Err(());
                }
            }
            states.insert(
                device_id,
                StopIntentState {
                    request_id: change.request_id,
                    pending: true,
                    expected_version: change.expected_version,
                },
            );
            Ok(true)
        }
        (StopIntentOperation::Clear, Some(state)) if state.request_id != change.request_id => {
            Err(())
        }
        (StopIntentOperation::Clear, Some(state)) => {
            Ok(std::mem::replace(&mut state.pending, false))
        }
        (StopIntentOperation::Clear, None) => Ok(false),
    }
}

async fn set_stop_intent(
    mysql: &brz_mysql::MysqlService,
    user: i64,
    body: StopIntentChange,
) -> MysqlResult<StopIntentOutcome> {
    mysql
        .with_transaction(async |tx| {
            // Serialize with account edits and device registration/deletion using
            // the same existing account owner row lock.
            let _: (i64,) = tx
                .fetch_optional(
                    "SELECT id FROM users WHERE id=? AND is_active=true FOR UPDATE",
                    (user,),
                )
                .await?
                .ok_or(MysqlError::RowNotFound)?;
            let Some(device) = crate::device_identity::resolve_device_for_binding_on(
                &mut &mut *tx,
                user,
                &body.device_id,
            )
            .await?
            else {
                return Ok(StopIntentOutcome::DeviceNotFound);
            };
            let device_id = crate::device_identity::record_route_id(&device);
            let mut rows: Vec<Row> = tx.fetch_all(SELECT, (user, NAMESPACE)).await?;
            let Some(account) = rows
                .iter_mut()
                .find(|row| row.kind == ACCOUNT_KIND && row.name == DEFAULT_NAME)
            else {
                return Ok(StopIntentOutcome::AssistantNotFound);
            };
            let mut states = stop_intent_states(&account.document.0["spec"])?;
            match apply_stop_intent(&mut states, device_id, body) {
                Err(()) => return Ok(StopIntentOutcome::Conflict),
                Ok(true) => {
                    account.document.0["spec"]["stopIntentStates"] = json!(states);
                    update_document(tx, user, &account.document.0).await?;
                }
                Ok(false) => {}
            }
            Ok(StopIntentOutcome::Updated(view(&rows)?))
        })
        .await
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
    let foreign = user + 1;
    mysql.execute(
        "INSERT INTO users (id,user_name,password_hash,role,auth_source,preferences,is_active) VALUES (?,'personal-assistant-foreign','fixture','user','local','{}',true)",
        (foreign,),
    ).await?;
    mysql.execute(
        "INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (?,'Device','device-2','default',JSON_OBJECT('spec',JSON_OBJECT('deviceType','cloud','deviceId','cloud-runtime')),true,NOW(),NOW()),(?,'Device','device-3','default',JSON_OBJECT('spec',JSON_OBJECT('deviceType','local','deviceId','device-3')),true,NOW(),NOW()),(?,'Device','foreign-device','default',JSON_OBJECT('spec',JSON_OBJECT('deviceType','local','deviceId','foreign-device')),true,NOW(),NOW())",
        (user,user,foreign),
    ).await?;
    let mark = |device: &str, request: &str, expected: Option<&str>| {
        set_stop_intent(
            mysql,
            user,
            stop_change(device, StopIntentOperation::Mark, request, expected),
        )
    };
    let clear = |device: &str, request: &str| {
        set_stop_intent(
            mysql,
            user,
            stop_change(device, StopIntentOperation::Clear, request, None),
        )
    };
    let (first_mark, concurrent) = tokio::try_join!(
        mark("device-2", "first", None),
        mark("cloud-runtime", "second", None)
    )?;
    let pending = match (first_mark, concurrent) {
        (StopIntentOutcome::Updated(view), StopIntentOutcome::Conflict)
        | (StopIntentOutcome::Conflict, StopIntentOutcome::Updated(view)) => view,
        other => {
            panic!("Concurrent first-generation marks must have exactly one winner: {other:?}")
        }
    };
    let request_id = pending["assistant"]["stopIntents"][0]["requestId"]
        .as_str()
        .unwrap();
    assert_eq!(
        pending["assistant"]["stopIntents"],
        json!([{"deviceId":"device-2","requestId":request_id}])
    );
    assert_eq!(
        pending["assistant"]["stopIntentGenerations"],
        json!({"device-2":request_id})
    );
    assert_eq!(pending["assistant"]["revision"], revision);
    assert_eq!(read_account(mysql, user).await?, pending);
    assert_eq!(
        mark("device-2", "join", Some(request_id)).await?,
        StopIntentOutcome::Updated(pending.clone())
    );
    assert_eq!(
        mark("foreign-device", "other", None).await?,
        StopIntentOutcome::DeviceNotFound
    );
    assert_eq!(
        set_stop_intent(
            mysql,
            foreign,
            stop_change("device-2", StopIntentOperation::Clear, request_id, None)
        )
        .await?,
        StopIntentOutcome::DeviceNotFound
    );
    let multiple = stop_intent_view(mark("device-3", "third", None).await?);
    assert_eq!(
        multiple["assistant"]["stopIntents"],
        json!([{"deviceId":"device-2","requestId":request_id},{"deviceId":"device-3","requestId":"third"}])
    );
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
    assert_eq!(
        updated["assistant"]["stopIntents"],
        multiple["assistant"]["stopIntents"]
    );
    assert_eq!(
        updated["assistant"]["stopIntentGenerations"],
        multiple["assistant"]["stopIntentGenerations"]
    );
    assert!(replace_definitions(mysql, user, changes()).await?.is_none());
    let rows: Vec<Row> = mysql.fetch_all(SELECT, (user, NAMESPACE)).await?;
    assert_eq!(view(&rows)?, updated);
    let cleared = stop_intent_view(clear("cloud-runtime", request_id).await?);
    assert_eq!(
        cleared["assistant"]["stopIntents"],
        json!([{"deviceId":"device-3","requestId":"third"}])
    );
    assert_eq!(
        cleared["assistant"]["stopIntentGenerations"],
        json!({"device-2":request_id,"device-3":"third"})
    );
    assert_eq!(
        cleared["assistant"]["revision"],
        updated["assistant"]["revision"]
    );
    assert_eq!(
        mark("device-2", request_id, None).await?,
        StopIntentOutcome::Updated(cleared.clone())
    );
    assert_eq!(
        mark("device-2", "delayed", None).await?,
        StopIntentOutcome::Conflict
    );
    assert_eq!(
        clear("device-2", request_id).await?,
        StopIntentOutcome::Updated(cleared)
    );
    let next = stop_intent_view(mark("device-2", "next", Some(request_id)).await?);
    assert_eq!(
        clear("device-2", request_id).await?,
        StopIntentOutcome::Conflict
    );
    let rows: Vec<Row> = mysql.fetch_all(SELECT, (user, NAMESPACE)).await?;
    assert_eq!(view(&rows)?, next);
    assert_eq!(
        next["assistant"]["stopIntents"],
        json!([{"deviceId":"device-2","requestId":"next"},{"deviceId":"device-3","requestId":"third"}])
    );
    stop_intent_view(clear("device-2", "next").await?);
    stop_intent_view(clear("device-3", "third").await?);
    let final_account = read_account(mysql, user).await?;
    assert!(final_account["assistant"].get("stopIntents").is_none());
    assert_eq!(
        final_account["assistant"]["stopIntentGenerations"],
        json!({"device-2":"next","device-3":"third"})
    );
    // A delayed first-generation replay and a delayed second-generation mark
    // cannot resurrect an intent after multiple generations have completed.
    assert_eq!(
        mark("device-2", request_id, None).await?,
        StopIntentOutcome::Conflict
    );
    assert_eq!(
        mark("device-2", "delayed-next", Some(request_id)).await?,
        StopIntentOutcome::Conflict
    );
    assert_eq!(
        mark("device-2", "next", Some(request_id)).await?,
        StopIntentOutcome::Updated(final_account.clone())
    );
    assert_eq!(read_account(mysql, user).await?, final_account);
    assert_eq!(
        final_account["assistant"]["revision"],
        updated["assistant"]["revision"]
    );
    Ok(())
}

#[cfg(test)]
fn stop_change(
    device: &str,
    operation: StopIntentOperation,
    request_id: &str,
    expected_request_id: Option<&str>,
) -> StopIntentChange {
    StopIntentChange {
        device_id: device.to_owned(),
        operation,
        request_id: request_id.to_owned(),
        expected_request_id: expected_request_id.map(str::to_owned),
        expected_version: None,
    }
}

#[cfg(test)]
fn stop_intent_view(outcome: StopIntentOutcome) -> Value {
    match outcome {
        StopIntentOutcome::Updated(view) => view,
        other => panic!("Stop intent update failed: {other:?}"),
    }
}

#[test]
fn stop_intent_patch_has_distinct_validated_shape() {
    let request = json!({"stopIntent":{"deviceId":"device-2","operation":"mark","requestId":"request-1","expectedRequestId":null}});
    let AccountChange::StopIntent(change) = serde_json::from_value(request.clone()).unwrap() else {
        panic!("Stop intent patch decoded as a definition change");
    };
    assert!(change.stop_intent.valid());
    let mut mixed = request.clone();
    mixed["revision"] = json!("revision");
    assert!(serde_json::from_value::<AccountChange>(mixed).is_err());
    let mut foreign = request;
    foreign["stopIntent"]["userId"] = json!(7);
    assert!(serde_json::from_value::<AccountChange>(foreign).is_err());
    let mut invalid = change.stop_intent;
    invalid.expected_request_id = Some(String::new());
    assert!(!invalid.valid());
    invalid.expected_request_id = None;
    invalid.request_id.clear();
    assert!(!invalid.valid());
}

#[test]
fn stop_generation_preserves_confirmed_profile_version_until_replaced() {
    let mut states = StopIntentStates::new();
    let device = "device-2".to_owned();
    let mark = |request, expected, version| StopIntentChange {
        expected_version: version,
        ..stop_change("device-2", StopIntentOperation::Mark, request, expected)
    };
    assert_eq!(
        apply_stop_intent(&mut states, device.clone(), mark("offline", None, None)),
        Ok(true)
    );
    assert_eq!(
        apply_stop_intent(&mut states, device.clone(), mark("offline", None, Some(4))),
        Err(())
    );
    assert_eq!(
        apply_stop_intent(
            &mut states,
            device.clone(),
            mark("confirmed", Some("offline"), Some(4))
        ),
        Ok(true)
    );
    assert_eq!(states[&device].expected_version, Some(4));
    assert_eq!(
        apply_stop_intent(
            &mut states,
            device.clone(),
            mark("delayed", Some("offline"), Some(5))
        ),
        Err(())
    );
    assert_eq!(
        apply_stop_intent(
            &mut states,
            device.clone(),
            mark("older", Some("confirmed"), Some(3))
        ),
        Err(())
    );
    assert_eq!(
        apply_stop_intent(
            &mut states,
            device.clone(),
            mark("retry", Some("confirmed"), Some(5))
        ),
        Ok(true)
    );
    assert_eq!(
        apply_stop_intent(
            &mut states,
            device.clone(),
            stop_change("device-2", StopIntentOperation::Clear, "confirmed", None)
        ),
        Err(())
    );
    assert_eq!(states[&device].request_id, "retry");
    assert_eq!(states[&device].expected_version, Some(5));
}
