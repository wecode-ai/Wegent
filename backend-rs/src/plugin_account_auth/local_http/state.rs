//! Account-scoped plugin state; shares the existing write lease and revisions.

mod enrollment;
mod operations;

use super::{credentials, fail, session::Principal, *};
use brz_mysql::{FromMysqlRow, MysqlTransaction};
use serde::de::DeserializeOwned;

#[derive(FromMysqlRow)]
struct Row {
    id: i64,
    name: String,
    json: Value,
    is_active: bool,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn nonce() -> MysqlResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|_| fail("plugin_auth_exchange_failed"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn invalid() -> MysqlError {
    fail("plugin_auth_invalid_request")
}
fn parse<T: DeserializeOwned>(data: &Value) -> MysqlResult<T> {
    serde_json::from_value(data.clone()).map_err(|_| invalid())
}
fn text<'a>(data: &'a Value, key: &str) -> MysqlResult<&'a str> {
    data[key]
        .as_str()
        .filter(|v| !v.is_empty() && v.len() <= 256)
        .ok_or_else(invalid)
}
fn connector(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-".contains(&b))
}
fn revision(spec: &Value) -> MysqlResult<i64> {
    match spec.get("revision") {
        None => Ok(0),
        Some(v) => v
            .as_i64()
            .filter(|v| *v >= 0 && *v < i64::MAX)
            .ok_or_else(invalid),
    }
}

async fn rows(tx: &mut impl MysqlTransaction, user: i64, kind: &str) -> MysqlResult<Vec<Row>> {
    tx.fetch_all("SELECT id,name,json,is_active FROM kinds WHERE user_id=? AND kind=? AND namespace='plugin-auth' AND is_active=1 ORDER BY id", (user,kind)).await
}
async fn all_rows(tx: &mut impl MysqlTransaction, user: i64, kind: &str) -> MysqlResult<Vec<Row>> {
    tx.fetch_all("SELECT id,name,json,is_active FROM kinds WHERE user_id=? AND kind=? AND namespace='plugin-auth' ORDER BY id",(user,kind)).await
}
async fn get(
    tx: &mut impl MysqlTransaction,
    user: i64,
    kind: &str,
    name: &str,
    active: bool,
) -> MysqlResult<Option<Row>> {
    let mut found: Vec<Row> = tx.fetch_all("SELECT id,name,json,is_active FROM kinds WHERE user_id=? AND kind=? AND namespace='plugin-auth' AND name=? LIMIT 2",(user,kind,name)).await?;
    if found.len() > 1 {
        return Err(fail("plugin_auth_revision_conflict"));
    }
    Ok(found.pop().filter(|r| !active || r.is_active))
}
async fn save(
    tx: &mut impl MysqlTransaction,
    user: i64,
    kind: &str,
    name: &str,
    old: Option<&Row>,
    mut spec: Value,
    active: bool,
) -> MysqlResult<()> {
    let old_revision = old
        .map(|r| revision(&r.json["spec"]))
        .transpose()?
        .unwrap_or(0);
    spec["revision"] = json!(old_revision + 1);
    let document = json!({"spec":spec});
    if let Some(row) = old {
        let updated = tx.execute("UPDATE kinds SET json=?,is_active=?,name=?,updated_at=NOW() WHERE id=? AND user_id=? AND kind=? AND namespace='plugin-auth' AND name=? AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(json,'$.spec.revision')) AS SIGNED),0)=?",(document,active,name,row.id,user,kind,row.name.as_str(),old_revision)).await?;
        if updated.rows_affected != 1 {
            return Err(fail("plugin_auth_revision_conflict"));
        }
    } else {
        tx.execute("INSERT INTO kinds (user_id,kind,namespace,name,json,is_active,created_at,updated_at) VALUES (?,?,'plugin-auth',?,?,?,NOW(),NOW())",(user,kind,name,document,active)).await?;
    }
    Ok(())
}

struct Package {
    row: crate::device_identity::DeviceKindRow,
    id: i64,
    spec: Value,
    definition: Value,
    slug: String,
}
impl Package {
    fn metadata(&self) -> MysqlResult<Value> {
        crate::plugin_account_auth::connections::package_metadata(
            &self.row,
            &self.slug,
            self.definition.clone(),
        )
        .map_err(credentials::failure)
    }
    fn source(&self) -> String {
        credentials::source(&self.spec)
    }
}
async fn package(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    id: i64,
    slug: &str,
    allow_disabled: bool,
) -> MysqlResult<Package> {
    if id <= 0 || !connector(slug) {
        return Err(invalid());
    }
    let row = crate::plugin_account_auth::connections::installed_plugin(tx, p.user_id, id)
        .await
        .map_err(credentials::failure)?;
    let spec = row.json["spec"].clone();
    if !allow_disabled && spec["enabled"] == false {
        return Err(fail("plugin_auth_plugin_disabled"));
    }
    let matches: Vec<_> = spec["components"]["connectors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["slug"] == slug)
        .collect();
    if matches.len() != 1
        || !matches[0]["accountAuth"].is_object()
        || spec["source"]["pluginKey"]
            .as_str()
            .is_none_or(str::is_empty)
    {
        return Err(fail("plugin_auth_not_supported"));
    }
    let definition = crate::plugin_account_auth::definition::parse(&matches[0]["accountAuth"])
        .map_err(|_| fail("plugin_auth_not_supported"))?;
    Ok(Package {
        row,
        id,
        spec,
        definition,
        slug: slug.into(),
    })
}
fn validate_connection(package: &Package, spec: &Value) -> MysqlResult<()> {
    if spec["installedPluginId"] != package.id
        || spec["sourceIdentity"] != package.source()
        || spec["authDefinition"] != package.definition
    {
        return Err(fail("plugin_auth_definition_changed"));
    }
    Ok(())
}
fn require_connected(spec: &Value) -> MysqlResult<()> {
    if spec["status"] != "connected" || !spec["credential"].is_object() {
        return Err(fail("plugin_auth_disconnected"));
    }
    Ok(())
}
fn granted(spec: &Value, p: &Principal) -> bool {
    spec["localGrants"][&p.thumbprint] == true
}
fn metadata(row: &Row) -> Value {
    let spec = &row.json["spec"];
    let mut ids: Vec<_> = spec["deviceGrants"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    ids.sort();
    json!({"id":row.name,"installed_plugin_id":spec["installedPluginId"],"plugin_key":spec["pluginKey"],"connector_slug":spec["connectorSlug"],"account_id":spec["accountId"],"account_label":spec["accountLabel"],"credential_type":spec["credentialType"],"status":spec["status"],"revision":spec["revision"],"device_ids":ids})
}
fn policy_name(package: &Package) -> String {
    crate::plugin_account_auth::local_lifecycle::policy_name(&package.source(), &package.slug)
}
async fn local_policy(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    package: &Package,
) -> MysqlResult<Option<Row>> {
    get(
        tx,
        p.user_id,
        "ConnectorLocalAuthPolicy",
        &policy_name(package),
        true,
    )
    .await
}
async fn enabled(tx: &mut impl MysqlTransaction, p: &Principal) -> MysqlResult<bool> {
    crate::plugin_account_auth::automation::enabled(tx, p.user_id)
        .await
        .map_err(fail)
}
async fn no_transfer(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    source: &str,
    slug: &str,
    account: &str,
) -> MysqlResult<()> {
    crate::plugin_account_auth::transfers::require_no_pending_transfer(
        tx,
        p.user_id,
        &json!({"source_identity":source,"connector_slug":slug}),
        account,
    )
    .await
    .map_err(credentials::failure)
}

pub(super) async fn exchange(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    operation: &str,
    data: &Value,
) -> MysqlResult<Value> {
    match operation {
        "plugin.auth.execute"
        | "plugin.auth.read"
        | "plugin.auth.oauth.begin"
        | "plugin.auth.oauth.finish"
        | "plugin.auth.oauth.revocations"
        | "plugin.auth.oauth.revoke_begin"
        | "plugin.auth.oauth.revoke_finish"
        | "plugin.auth.local_lifecycle" => operations::exchange(tx, p, operation, data).await,
        "plugin.auth.automatic"
        | "plugin.auth.prepare"
        | "plugin.auth.enroll"
        | "plugin.auth.transfer.stage"
        | "plugin.auth.transfer.prepare"
        | "plugin.auth.transfer.finish"
        | "plugin.auth.transfer.abort" => enrollment::exchange(tx, p, operation, data).await,
        _ => Err(fail("plugin_auth_invalid_operation")),
    }
}
