//! Native execution and OAuth leases retain the existing account state machine.
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Execution {
    installed_plugin_id: i64,
    connector_slug: String,
    account_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Lifecycle {
    installed_plugin_id: i64,
    connector_slug: String,
    action: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finish {
    connection_id: String,
    operation_id: String,
    succeeded: bool,
    #[serde(default = "yes")]
    attempted: bool,
    account_id: Option<String>,
    credential: Option<String>,
}
fn yes() -> bool {
    true
}

async fn resolve(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    data: &Value,
) -> MysqlResult<(Package, Row, String)> {
    let input: Execution = parse(data)?;
    let package = package(
        tx,
        p,
        input.installed_plugin_id,
        &input.connector_slug,
        false,
    )
    .await?;
    let mut candidates: Vec<_> = rows(tx, p.user_id, "ConnectorConnection")
        .await?
        .into_iter()
        .filter(|r| {
            let s = &r.json["spec"];
            s["installedPluginId"] == input.installed_plugin_id
                && s["connectorSlug"] == input.connector_slug
                && s["status"] == "connected"
                && granted(s, p)
                && input
                    .account_id
                    .as_ref()
                    .is_none_or(|a| s["accountId"] == *a)
        })
        .collect();
    if candidates.is_empty() {
        return Err(fail("plugin_auth_device_not_granted"));
    }
    if candidates.len() != 1 {
        return Err(fail("plugin_auth_account_selection_required"));
    }
    let row = candidates.pop().expect("one connection");
    validate_connection(&package, &row.json["spec"])?;
    let raw = credentials::decrypt(
        &row.json["spec"]["credential"],
        &credentials::context(p.user_id, &row.json["spec"]),
    )?;
    Ok((package, row, raw))
}

pub(super) async fn exchange(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    operation: &str,
    data: &Value,
) -> MysqlResult<Value> {
    match operation {
        "plugin.auth.local_lifecycle" => lifecycle(tx, p, data).await,
        "plugin.auth.oauth.revocations" => pending_revocations(tx, p, data).await,
        "plugin.auth.oauth.revoke_begin" => revoke_begin(tx, p, data).await,
        "plugin.auth.oauth.revoke_finish" => revoke_finish(tx, p, data).await,
        "plugin.auth.oauth.finish" => refresh_finish(tx, p, data).await,
        "plugin.auth.read" => read(tx, p, data).await,
        "plugin.auth.execute" | "plugin.auth.oauth.begin" => {
            let (package, row, raw) = resolve(tx, p, data).await?;
            if operation == "plugin.auth.execute" {
                return Ok(
                    json!({"package":package.metadata()?,"credential":credentials::business(raw,&row.json["spec"]["credentialType"])?}),
                );
            }
            refresh_begin(tx, p, &package, &row, raw).await
        }
        _ => Err(invalid()),
    }
}

async fn read(tx: &mut impl MysqlTransaction, p: &Principal, data: &Value) -> MysqlResult<Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Read {
        connection_id: String,
        installed_plugin_id: i64,
        expected_revision: i64,
    }
    let input: Read = parse(data)?;
    let row = get(
        tx,
        p.user_id,
        "ConnectorConnection",
        &input.connection_id,
        true,
    )
    .await?
    .ok_or_else(|| fail("plugin_auth_connection_not_found"))?;
    let s = &row.json["spec"];
    require_connected(s)?;
    if !granted(s, p) || s["installedPluginId"] != input.installed_plugin_id {
        return Err(fail("plugin_auth_device_not_granted"));
    }
    if revision(s)? != input.expected_revision {
        return Err(fail("plugin_auth_revision_conflict"));
    }
    let pkg = package(
        tx,
        p,
        input.installed_plugin_id,
        text(s, "connectorSlug")?,
        false,
    )
    .await?;
    validate_connection(&pkg, s)?;
    Ok(
        json!({"credential":credentials::decrypt(&s["credential"],&credentials::context(p.user_id,s))?}),
    )
}

async fn refresh_begin(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    package: &Package,
    row: &Row,
    raw: String,
) -> MysqlResult<Value> {
    let mut spec = row.json["spec"].clone();
    no_transfer(
        tx,
        p,
        &package.source(),
        &package.slug,
        text(&spec, "accountId")?,
    )
    .await?;
    if spec["credentialType"] != "oauth2"
        || !package.definition["oauth2"]
            .as_array()
            .is_some_and(|v| v.contains(&json!("refresh")))
    {
        return Err(fail("plugin_auth_operation_unsupported"));
    }
    let payload = credentials::token_payload(&raw)?;
    if !credentials::expired(&payload) {
        return Ok(json!({"state":"ready"}));
    }
    if payload["refresh_token"].as_str().is_none_or(str::is_empty) {
        return Err(fail("plugin_auth_reconnect_required"));
    }
    let old = &spec["oauthRefresh"];
    if old["state"] == "in_flight" && old["expiresAt"].as_i64().unwrap_or(0) > now() {
        return Err(fail("plugin_auth_refresh_in_progress"));
    }
    if matches!(old["state"].as_str(), Some("in_flight" | "uncertain")) {
        return Err(fail("plugin_auth_reconnect_required"));
    }
    let id = nonce()?;
    spec["oauthRefresh"] =
        json!({"id":id,"state":"in_flight","localPrincipal":p.thumbprint,"expiresAt":now()+90});
    save(
        tx,
        p.user_id,
        "ConnectorConnection",
        &row.name,
        Some(row),
        spec,
        true,
    )
    .await?;
    Ok(
        json!({"state":"claimed","operation_id":id,"connection_id":row.name,"package":package.metadata()?,"credential":raw}),
    )
}

async fn refresh_finish(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    data: &Value,
) -> MysqlResult<Value> {
    let input: Finish = parse(data)?;
    if input.succeeded
        && (!input.attempted || input.credential.is_none() || input.account_id.is_none())
        || !input.succeeded && (input.credential.is_some() || input.account_id.is_some())
    {
        return Err(invalid());
    }
    let row = get(
        tx,
        p.user_id,
        "ConnectorConnection",
        &input.connection_id,
        true,
    )
    .await?
    .ok_or_else(|| fail("plugin_auth_connection_not_found"))?;
    let mut spec = row.json["spec"].clone();
    let op = spec["oauthRefresh"].clone();
    if op["id"] != input.operation_id || op["localPrincipal"] != p.thumbprint {
        return Err(fail("plugin_auth_operation_mismatch"));
    }
    if op["state"] == "finished" {
        return Ok(json!({"state":"finished"}));
    }
    let mut revoke = spec["oauthRevocation"].clone();
    let revoking = spec["status"] == "disconnected"
        && matches!(revoke["state"].as_str(), Some("pending" | "attention"))
        && revoke["refreshOperation"] == input.operation_id;
    if !revoking {
        require_connected(&spec)?;
        if !granted(&spec, p) {
            return Err(fail("plugin_auth_device_not_granted"));
        }
        let pkg = package(
            tx,
            p,
            spec["installedPluginId"].as_i64().ok_or_else(invalid)?,
            text(&spec, "connectorSlug")?,
            false,
        )
        .await?;
        validate_connection(&pkg, &spec)?;
    }
    if op["state"] != "in_flight" || !revoking && op["expiresAt"].as_i64().unwrap_or(0) <= now() {
        return Err(fail("plugin_auth_reconnect_required"));
    }
    if input.succeeded {
        let raw = input.credential.as_deref().expect("validated result");
        let payload = credentials::token_payload(raw)?;
        if spec["accountId"] != input.account_id.as_deref().unwrap_or_default()
            || credentials::expired(&payload)
            || payload.get("expires_at").is_none()
            || payload["refresh_token"].as_str().is_none_or(str::is_empty)
        {
            return Err(fail("plugin_auth_invalid_refresh_result"));
        }
        let encrypted = credentials::encrypt(raw, &credentials::context(p.user_id, &spec))?;
        if revoking {
            revoke["credential"] = encrypted;
        } else {
            spec["credential"] = encrypted;
        }
    }
    if revoking {
        let known = input.succeeded || !input.attempted;
        revoke["state"] = json!(if known { "pending" } else { "attention" });
        revoke["waitUntil"] = json!(0);
        revoke["refreshOperation"] = if known {
            Value::Null
        } else {
            json!(input.operation_id)
        };
        spec["oauthRevocation"] = revoke;
    }
    spec["oauthRefresh"]["state"] = json!(if input.succeeded {
        "finished"
    } else if input.attempted {
        "uncertain"
    } else {
        "cancelled"
    });
    let state = spec["oauthRefresh"]["state"].clone();
    save(
        tx,
        p.user_id,
        "ConnectorConnection",
        &row.name,
        Some(&row),
        spec,
        true,
    )
    .await?;
    Ok(json!({"state":state}))
}

async fn lifecycle(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    data: &Value,
) -> MysqlResult<Value> {
    let input: Lifecycle = parse(data)?;
    let pkg = package(
        tx,
        p,
        input.installed_plugin_id,
        &input.connector_slug,
        input.action == "logout",
    )
    .await?;
    let old = local_policy(tx, p, &pkg).await?;
    let mut policy = old
        .as_ref()
        .map(|r| r.json["spec"].clone())
        .unwrap_or(json!({"enabled":true}));
    let connections: Vec<_> = rows(tx, p.user_id, "ConnectorConnection")
        .await?
        .into_iter()
        .filter(|r| {
            r.json["spec"]["sourceIdentity"] == pkg.source()
                && r.json["spec"]["connectorSlug"] == pkg.slug
        })
        .collect();
    match input.action.as_str() {
        "status" => {
            if policy["enabled"] == false {
                return Ok(json!({"status":"need_login"}));
            }
            for row in &connections {
                let spec = &row.json["spec"];
                if spec["status"] == "connected" && granted(spec, p) {
                    validate_connection(&pkg, spec)?;
                    return Ok(
                        json!({"status":if spec["oauthRefresh"]["state"]=="uncertain"{"need_login"}else{"ok"}}),
                    );
                }
            }
            Ok(json!({"status":if connections.is_empty(){Value::Null}else{json!("need_login")}}))
        }
        "login" => {
            policy["enabled"] = json!(true);
            if !policy["pendingNativeLogins"].is_object() {
                policy["pendingNativeLogins"] = json!({});
            }
            policy["pendingNativeLogins"][&p.thumbprint] = json!(nonce()?);
            save(
                tx,
                p.user_id,
                "ConnectorLocalAuthPolicy",
                &policy_name(&pkg),
                old.as_ref(),
                policy,
                true,
            )
            .await?;
            Ok(json!({"status":"ok"}))
        }
        "logout" => {
            for transfer in rows(tx, p.user_id, "ConnectorTransfer").await? {
                if transfer.json["spec"]["source_identity"] == pkg.source()
                    && transfer.json["spec"]["connector_slug"] == pkg.slug
                {
                    return Err(fail("plugin_auth_transfer_pending"));
                }
            }
            policy["enabled"] = json!(false);
            policy["pendingLogins"] = json!({});
            policy["pendingNativeLogins"] = json!({});
            save(
                tx,
                p.user_id,
                "ConnectorLocalAuthPolicy",
                &policy_name(&pkg),
                old.as_ref(),
                policy,
                true,
            )
            .await?;
            for intent in rows(tx, p.user_id, "ConnectorMigration").await? {
                if intent.json["spec"]["source_identity"] == pkg.source()
                    && intent.json["spec"]["connector_slug"] == pkg.slug
                {
                    save(
                        tx,
                        p.user_id,
                        "ConnectorMigration",
                        &intent.name,
                        Some(&intent),
                        intent.json["spec"].clone(),
                        false,
                    )
                    .await?;
                }
            }
            for row in connections {
                disconnect(tx, p, &row).await?;
            }
            Ok(json!({"status":"ok"}))
        }
        _ => Err(invalid()),
    }
}

async fn disconnect(tx: &mut impl MysqlTransaction, p: &Principal, row: &Row) -> MysqlResult<()> {
    let mut s = row.json["spec"].clone();
    if s["status"] == "connected" && s["credentialType"] == "oauth2" {
        if s["authDefinition"]["oauth2"]
            .as_array()
            .is_some_and(|v| v.contains(&json!("revoke")))
        {
            let refresh = &s["oauthRefresh"];
            s["oauthRevocation"] = json!({"state":if refresh["state"]=="uncertain"{"attention"}else{"pending"},"credential":s["credential"],"devices":s["deviceGrants"],"localPrincipals":s["localGrants"],"attempts":0,"nextAttemptAt":now(),"refreshOperation":if matches!(refresh["state"].as_str(),Some("in_flight"|"uncertain")){refresh["id"].clone()}else{Value::Null},"waitUntil":if refresh["state"]=="in_flight"{refresh["expiresAt"].clone()}else{json!(0)}});
        } else {
            s["oauthRevocation"] = json!({"state":"unsupported"});
        }
    }
    s["status"] = json!("disconnected");
    s["credential"] = Value::Null;
    s["deviceGrants"] = json!({});
    s["localGrants"] = json!({});
    save(
        tx,
        p.user_id,
        "ConnectorConnection",
        &row.name,
        Some(row),
        s,
        true,
    )
    .await
}

fn revoke_due(spec: &Value, p: &Principal) -> bool {
    let job = &spec["oauthRevocation"];
    spec["status"] == "disconnected"
        && job["localPrincipals"][&p.thumbprint] == true
        && job["waitUntil"].as_i64().unwrap_or(0) <= now()
        && (job["state"] == "pending" && job["nextAttemptAt"].as_i64().unwrap_or(0) <= now()
            || job["state"] == "in_flight" && job["leaseExpiresAt"].as_i64().unwrap_or(0) <= now())
}
async fn pending_revocations(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    data: &Value,
) -> MysqlResult<Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Query {
        #[serde(default)]
        after_id: i64,
    }
    let q: Query = parse(data)?;
    if q.after_id < 0 {
        return Err(invalid());
    }
    let mut result = vec![];
    let mut cursor = Value::Null;
    for row in rows(tx, p.user_id, "ConnectorConnection").await? {
        if row.id <= q.after_id || !revoke_due(&row.json["spec"], p) {
            continue;
        }
        let s = &row.json["spec"];
        let metadata = match package(
            tx,
            p,
            s["installedPluginId"].as_i64().ok_or_else(invalid)?,
            text(s, "connectorSlug")?,
            false,
        )
        .await
        {
            Ok(pkg) if validate_connection(&pkg, s).is_ok() => pkg.metadata().ok(),
            _ => None,
        };
        result.push(json!({"connection_id":row.name,"package":metadata}));
        if result.len() == 10 {
            cursor = json!(row.id);
            break;
        }
    }
    Ok(json!({"revocations":result,"next_cursor":cursor}))
}
async fn revoke_begin(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    data: &Value,
) -> MysqlResult<Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Begin {
        connection_id: String,
    }
    let input: Begin = parse(data)?;
    let row = get(
        tx,
        p.user_id,
        "ConnectorConnection",
        &input.connection_id,
        true,
    )
    .await?
    .ok_or_else(|| fail("plugin_auth_connection_not_found"))?;
    let mut s = row.json["spec"].clone();
    if !revoke_due(&s, p) {
        return Ok(json!({"state":"unavailable"}));
    }
    let pkg = package(
        tx,
        p,
        s["installedPluginId"].as_i64().ok_or_else(invalid)?,
        text(&s, "connectorSlug")?,
        false,
    )
    .await;
    let pkg = match pkg {
        Ok(pkg) if validate_connection(&pkg, &s).is_ok() && pkg.metadata().is_ok() => pkg,
        _ => {
            s["oauthRevocation"]["state"] = json!("attention");
            save(
                tx,
                p.user_id,
                "ConnectorConnection",
                &row.name,
                Some(&row),
                s,
                true,
            )
            .await?;
            return Ok(json!({"state":"unavailable"}));
        }
    };
    let raw = credentials::decrypt(
        &s["oauthRevocation"]["credential"],
        &credentials::context(p.user_id, &s),
    )?;
    let id = nonce()?;
    s["oauthRevocation"]["state"] = json!("in_flight");
    s["oauthRevocation"]["operationId"] = json!(id);
    s["oauthRevocation"]["localPrincipal"] = json!(p.thumbprint);
    s["oauthRevocation"]["leaseExpiresAt"] = json!(now() + 90);
    save(
        tx,
        p.user_id,
        "ConnectorConnection",
        &row.name,
        Some(&row),
        s,
        true,
    )
    .await?;
    Ok(
        json!({"state":"claimed","connection_id":row.name,"operation_id":id,"package":pkg.metadata()?,"credential":raw}),
    )
}
async fn revoke_finish(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    data: &Value,
) -> MysqlResult<Value> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Finish {
        connection_id: String,
        operation_id: String,
        succeeded: bool,
    }
    let input: Finish = parse(data)?;
    let row = get(
        tx,
        p.user_id,
        "ConnectorConnection",
        &input.connection_id,
        true,
    )
    .await?
    .ok_or_else(|| fail("plugin_auth_connection_not_found"))?;
    let mut s = row.json["spec"].clone();
    let mut job = s["oauthRevocation"].clone();
    if job["operationId"] != input.operation_id || job["localPrincipal"] != p.thumbprint {
        return Err(fail("plugin_auth_operation_mismatch"));
    }
    if job["state"] == "revoked" {
        return Ok(json!({"state":"revoked"}));
    }
    if job["state"] != "in_flight" {
        return Err(fail("plugin_auth_operation_mismatch"));
    }
    if input.succeeded {
        job = json!({"state":"revoked","operationId":input.operation_id,"localPrincipal":p.thumbprint});
    } else {
        let attempts = job["attempts"].as_u64().unwrap_or(0) + 1;
        job["attempts"] = json!(attempts);
        job["state"] = json!(if attempts >= 5 {
            "attention"
        } else {
            "pending"
        });
        job["nextAttemptAt"] = json!(now() + 600.min(15i64 * 2i64.pow(attempts.min(6) as u32)));
    }
    let result = json!({"state":job["state"]});
    s["oauthRevocation"] = job;
    save(
        tx,
        p.user_id,
        "ConnectorConnection",
        &row.name,
        Some(&row),
        s,
        true,
    )
    .await?;
    Ok(result)
}
