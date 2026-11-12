//! Reuse bounded enrollment slots and exclusive-transfer escrow in kinds.
use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    installed_plugin_id: i64,
    connector_slug: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Automatic {
    installed_plugin_ids: Vec<i64>,
    #[serde(default)]
    prepare_only: bool,
    targets: Option<Vec<Target>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Enrollment {
    migration_id: String,
    account_id: String,
    #[serde(default)]
    account_label: String,
    credential: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Migration {
    migration_id: String,
}

async fn validated(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    row: &Row,
    transfer: bool,
) -> MysqlResult<Package> {
    let s = &row.json["spec"];
    if s["localPrincipal"] != p.thumbprint {
        return Err(fail("plugin_auth_migration_device_mismatch"));
    }
    if !transfer && (!row.is_active || s["expires_at"].as_i64().unwrap_or(0) <= now()) {
        return Err(fail("plugin_auth_migration_expired"));
    }
    if !transfer && s["automatic"] == true && !enabled(tx, p).await? {
        return Err(fail("plugin_auth_automation_disabled"));
    }
    let pkg = package(
        tx,
        p,
        s["installed_plugin_id"].as_i64().ok_or_else(invalid)?,
        text(s, "connector_slug")?,
        false,
    )
    .await?;
    if pkg.source() != s["source_identity"] || pkg.definition != s["auth_definition"] {
        return Err(fail("plugin_auth_definition_changed"));
    }
    if !transfer {
        let policy = local_policy(tx, p, &pkg).await?;
        if policy
            .as_ref()
            .is_some_and(|r| r.json["spec"]["enabled"] == false)
            || policy
                .as_ref()
                .map(|r| r.json["spec"]["pendingNativeLogins"][&p.thumbprint].clone())
                .unwrap_or(Value::Null)
                != s["loginGeneration"]
        {
            return Err(fail("plugin_auth_migration_expired"));
        }
    }
    Ok(pkg)
}

pub(super) async fn exchange(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    operation: &str,
    data: &Value,
) -> MysqlResult<Value> {
    if operation == "plugin.auth.automatic" {
        return automatic(tx, p, parse(data)?).await;
    }
    if matches!(
        operation,
        "plugin.auth.enroll" | "plugin.auth.transfer.stage"
    ) {
        let input: Enrollment = parse(data)?;
        if input.account_id.is_empty()
            || input.account_id.chars().count() > 256
            || input.account_label.chars().count() > 256
            || input.credential.is_empty()
            || input.credential.len() > 65536
        {
            return Err(invalid());
        }
        return if operation == "plugin.auth.enroll" {
            enroll(tx, p, &input).await
        } else {
            stage(tx, p, &input).await
        };
    }
    let input: Migration = parse(data)?;
    if input.migration_id.len() != 64
        || !input
            .migration_id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(invalid());
    }
    if operation == "plugin.auth.prepare" {
        if let Some(row) = get(
            tx,
            p.user_id,
            "ConnectorTransfer",
            &input.migration_id,
            true,
        )
        .await?
        {
            let pkg = validated(tx, p, &row, true).await?;
            return Ok(json!({"package":pkg.metadata()?,"operation":"transfer"}));
        }
        let row = get(
            tx,
            p.user_id,
            "ConnectorMigration",
            &input.migration_id,
            true,
        )
        .await?
        .ok_or_else(|| fail("plugin_auth_migration_expired"))?;
        let pkg = validated(tx, p, &row, false).await?;
        return Ok(json!({"package":pkg.metadata()?,"operation":"export"}));
    }
    transfer(tx, p, operation, &input.migration_id).await
}

async fn automatic(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    input: Automatic,
) -> MysqlResult<Value> {
    if input.installed_plugin_ids.len() > 256
        || input.installed_plugin_ids.iter().any(|id| *id <= 0)
    {
        return Err(invalid());
    }
    let key = if input.prepare_only {
        "packages"
    } else {
        "migrations"
    };
    let mut result = vec![];
    let automatic_enabled = enabled(tx, p).await?;
    let transfers = rows(tx, p.user_id, "ConnectorTransfer").await?;
    for id in input.installed_plugin_ids {
        let row:Option<Row>=tx.fetch_optional("SELECT id,name,json,is_active FROM kinds WHERE user_id=? AND kind='InstalledPlugin' AND namespace='default' AND id=? AND is_active=1",(p.user_id,id)).await?;
        let Some(row) = row else {
            continue;
        };
        if row.json["spec"]["enabled"] == false {
            continue;
        }
        let connectors = row.json["spec"]["components"]["connectors"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for c in connectors {
            let Some(slug) = c["slug"].as_str() else {
                continue;
            };
            if !c["accountAuth"].is_object()
                || input.targets.as_ref().is_some_and(|v| {
                    !v.iter()
                        .any(|t| t.installed_plugin_id == id && t.connector_slug == slug)
                })
            {
                continue;
            }
            let pkg = match package(tx, p, id, slug, false).await {
                Ok(pkg) => pkg,
                Err(MysqlError::InvalidQuery { reason }) if reason.starts_with("plugin_auth_") => {
                    continue;
                }
                Err(error) => return Err(error),
            };
            if pkg.metadata().is_err() {
                continue;
            }
            let recovering = transfers.iter().any(|r| {
                r.json["spec"]["installed_plugin_id"] == id
                    && r.json["spec"]["connector_slug"] == slug
                    && r.json["spec"]["localPrincipal"] == p.thumbprint
            });
            let policy = local_policy(tx, p, &pkg).await?;
            if !recovering
                && policy
                    .as_ref()
                    .is_some_and(|r| r.json["spec"]["enabled"] == false)
            {
                continue;
            }
            let generation = policy
                .as_ref()
                .map(|r| r.json["spec"]["pendingNativeLogins"][&p.thumbprint].clone())
                .unwrap_or(Value::Null);
            if !recovering && !automatic_enabled && generation.is_null() {
                continue;
            }
            let blocked = rows(tx, p.user_id, "ConnectorConnection")
                .await?
                .iter()
                .any(|r| {
                    let s = &r.json["spec"];
                    s["sourceIdentity"] == pkg.source()
                        && s["connectorSlug"] == slug
                        && (s["status"] == "disconnected" || !granted(s, p))
                });
            if !recovering && blocked && generation.is_null() {
                continue;
            }
            if input.prepare_only {
                result.push(pkg.metadata()?);
            } else {
                let intent = match create_intent(tx, p, &pkg, generation).await {
                    Ok(intent) => intent,
                    Err(MysqlError::InvalidQuery { reason })
                        if reason.starts_with("plugin_auth_") =>
                    {
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                result.push(json!({"id":intent,"installed_plugin_id":id,"connector_slug":slug}));
            }
            if result.len() >= 256 {
                return Ok(json!({key:result}));
            }
        }
    }
    Ok(json!({key:result}))
}
async fn create_intent(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    pkg: &Package,
    generation: Value,
) -> MysqlResult<String> {
    let transfers: Vec<_> = rows(tx, p.user_id, "ConnectorTransfer")
        .await?
        .into_iter()
        .filter(|r| {
            r.json["spec"]["installed_plugin_id"] == pkg.id
                && r.json["spec"]["connector_slug"] == pkg.slug
                && r.json["spec"]["localPrincipal"] == p.thumbprint
        })
        .collect();
    if transfers.len() > 1 {
        return Err(fail("plugin_auth_transfer_pending"));
    }
    if let Some(row) = transfers.first() {
        validated(tx, p, row, true).await?;
        return Ok(row.name.clone());
    }
    let slot = all_rows(tx, p.user_id, "ConnectorMigration")
        .await?
        .into_iter()
        .find(|r| {
            let s = &r.json["spec"];
            s["installed_plugin_id"] == pkg.id
                && s["connector_slug"] == pkg.slug
                && s["localPrincipal"] == p.thumbprint
        });
    if let Some(row) = &slot
        && row.json["spec"]["loginGeneration"] == generation
        && validated(tx, p, row, false).await.is_ok()
    {
        return Ok(row.name.clone());
    }
    let name = nonce()?;
    let spec = json!({"installed_plugin_id":pkg.id,"connector_slug":pkg.slug,"source_identity":pkg.source(),"auth_definition":pkg.definition,"localPrincipal":p.thumbprint,"expires_at":now()+300,"automatic":generation.is_null(),"operation":"export","loginGeneration":generation});
    save(
        tx,
        p.user_id,
        "ConnectorMigration",
        &name,
        slot.as_ref(),
        spec,
        true,
    )
    .await?;
    Ok(name)
}
fn credential(input: &Enrollment, kind: &Value) -> MysqlResult<Value> {
    let kind = kind.as_str().ok_or_else(invalid)?;
    if kind == "oauth2" {
        credentials::token_payload(&input.credential)
    } else {
        crate::plugin_account_auth::native_credential::validated_payload(&input.credential, kind)
            .map_err(credentials::failure)
    }
}
async fn target(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    pkg: &Package,
    account: &str,
    fresh_login: bool,
) -> MysqlResult<Option<Row>> {
    let name = credentials::digest(&json!([pkg.source(), pkg.slug, account]));
    let row = get(tx, p.user_id, "ConnectorConnection", &name, true).await?;
    if let Some(row) = &row {
        if row.json["spec"]["authDefinition"] == pkg.definition || !fresh_login {
            validate_connection(pkg, &row.json["spec"])?;
        } else if row.json["spec"]["installedPluginId"] != pkg.id
            || row.json["spec"]["sourceIdentity"] != pkg.source()
        {
            return Err(fail("plugin_auth_definition_changed"));
        }
        if matches!(
            row.json["spec"]["oauthRevocation"]["state"].as_str(),
            Some("pending" | "in_flight" | "attention")
        ) {
            return Err(fail("plugin_auth_revocation_pending"));
        }
        let refresh = &row.json["spec"]["oauthRefresh"];
        if refresh["state"] == "in_flight" && refresh["expiresAt"].as_i64().unwrap_or(0) > now() {
            return Err(fail("plugin_auth_refresh_in_progress"));
        }
        if matches!(refresh["state"].as_str(), Some("in_flight" | "uncertain")) && !fresh_login {
            // An abandoned refresh may have consumed its token. Only an
            // explicit login can replace it; automatic export must not retry it.
            return Err(fail("plugin_auth_reconnect_required"));
        }
    }
    Ok(row)
}

async fn activate(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    pkg: &Package,
    intent: &Value,
    input: &Enrollment,
) -> MysqlResult<Value> {
    credential(input, &pkg.definition["credentialType"])?;
    let old = target(
        tx,
        p,
        pkg,
        &input.account_id,
        !intent["loginGeneration"].is_null(),
    )
    .await?;
    let previous = old
        .as_ref()
        .map(|r| r.json["spec"].clone())
        .unwrap_or(json!({}));
    if old.is_some() && !granted(&previous, p) && intent["loginGeneration"].is_null() {
        return Err(fail("plugin_auth_device_not_granted"));
    }
    if previous["status"] == "disconnected" && intent["loginGeneration"].is_null() {
        return Err(fail("plugin_auth_connection_disabled"));
    }
    let observed = credentials::observation(
        p.user_id,
        &input.credential,
        &pkg.source(),
        &pkg.slug,
        &input.account_id,
        &previous["nativeAuthSources"][&p.thumbprint],
    )?;
    // Automatic exports cannot overwrite a newer central token. Explicit login
    // replaces the credential and old refresh lease even for an unchanged source.
    let unchanged = intent["loginGeneration"].is_null()
        && previous["nativeAuthSources"][&p.thumbprint] == observed
        && previous["status"] == "connected"
        && previous["authDefinition"] == pkg.definition;
    let mut spec = previous.clone();
    if old.is_some() && previous["authDefinition"] != pkg.definition {
        for field in [
            "deviceGrants",
            "localGrants",
            "localAuthSources",
            "nativeAuthSources",
        ] {
            spec[field] = json!({});
        }
    }
    if !unchanged {
        spec["installedPluginId"] = json!(pkg.id);
        spec["pluginKey"] = pkg.spec["source"]["pluginKey"].clone();
        spec["sourceIdentity"] = json!(pkg.source());
        spec["connectorSlug"] = json!(pkg.slug);
        spec["accountId"] = json!(input.account_id);
        spec["accountLabel"] = json!(input.account_label);
        spec["credentialType"] = pkg.definition["credentialType"].clone();
        spec["authDefinition"] = pkg.definition.clone();
        spec["status"] = json!("connected");
        spec["credential"] =
            credentials::encrypt(&input.credential, &credentials::context(p.user_id, &spec))?;
        spec.as_object_mut()
            .expect("spec object")
            .remove("oauthRefresh");
    }
    for key in [
        "deviceGrants",
        "localGrants",
        "localAuthSources",
        "nativeAuthSources",
    ] {
        if !spec[key].is_object() {
            spec[key] = json!({});
        }
    }
    if !spec["deviceRevocations"].is_array() {
        spec["deviceRevocations"] = json!([]);
    }
    spec["localGrants"][&p.thumbprint] = json!(true);
    spec["nativeAuthSources"][&p.thumbprint] = observed;
    let name = credentials::digest(&json!([pkg.source(), pkg.slug, input.account_id]));
    if !unchanged || !granted(&previous, p) {
        save(
            tx,
            p.user_id,
            "ConnectorConnection",
            &name,
            old.as_ref(),
            spec,
            true,
        )
        .await?;
    }
    if let Some(policy) = local_policy(tx, p, pkg).await? {
        let mut s = policy.json["spec"].clone();
        let removed = s["pendingNativeLogins"]
            .as_object_mut()
            .and_then(|map| map.remove(&p.thumbprint))
            .is_some();
        if removed {
            save(
                tx,
                p.user_id,
                "ConnectorLocalAuthPolicy",
                &policy.name,
                Some(&policy),
                s,
                true,
            )
            .await?;
        }
    }
    let row = get(tx, p.user_id, "ConnectorConnection", &name, true)
        .await?
        .ok_or_else(invalid)?;
    Ok(metadata(&row))
}
async fn enroll(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    input: &Enrollment,
) -> MysqlResult<Value> {
    let row = get(
        tx,
        p.user_id,
        "ConnectorMigration",
        &input.migration_id,
        true,
    )
    .await?
    .ok_or_else(|| fail("plugin_auth_migration_expired"))?;
    let pkg = validated(tx, p, &row, false).await?;
    if pkg.definition["exportMode"] == "exclusive" {
        return Err(fail("plugin_auth_transfer_required"));
    }
    no_transfer(tx, p, &pkg.source(), &pkg.slug, &input.account_id).await?;
    let connection = activate(tx, p, &pkg, &row.json["spec"], input).await?;
    save(
        tx,
        p.user_id,
        "ConnectorMigration",
        &row.name,
        Some(&row),
        row.json["spec"].clone(),
        false,
    )
    .await?;
    Ok(json!({"connection":connection}))
}
fn escrow_context(user: i64, id: &str, s: &Value) -> String {
    credentials::canonical(&json!([
        "native-plugin-transfer",
        user,
        id,
        s["localPrincipal"],
        s["source_identity"],
        s["connector_slug"],
        s["account_id"]
    ]))
}
async fn stage(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    input: &Enrollment,
) -> MysqlResult<Value> {
    if let Some(row) = get(
        tx,
        p.user_id,
        "ConnectorTransfer",
        &input.migration_id,
        false,
    )
    .await?
    {
        validated(tx, p, &row, true).await?;
        if row.json["spec"]["account_id"] != input.account_id {
            return Err(fail("plugin_auth_account_mismatch"));
        }
        return Ok(json!({"state":row.json["spec"]["state"]}));
    }
    let row = get(
        tx,
        p.user_id,
        "ConnectorMigration",
        &input.migration_id,
        true,
    )
    .await?
    .ok_or_else(|| fail("plugin_auth_migration_expired"))?;
    let pkg = validated(tx, p, &row, false).await?;
    if pkg.definition["exportMode"] != "exclusive" {
        return Err(fail("plugin_auth_operation_unsupported"));
    }
    credential(input, &pkg.definition["credentialType"])?;
    no_transfer(tx, p, &pkg.source(), &pkg.slug, &input.account_id).await?;
    let old = target(
        tx,
        p,
        &pkg,
        &input.account_id,
        !row.json["spec"]["loginGeneration"].is_null(),
    )
    .await?;
    if let Some(old) = &old {
        let spec = &old.json["spec"];
        if !granted(spec, p) && row.json["spec"]["loginGeneration"].is_null() {
            return Err(fail("plugin_auth_device_not_granted"));
        }
        let observed = credentials::observation(
            p.user_id,
            &input.credential,
            &pkg.source(),
            &pkg.slug,
            &input.account_id,
            &spec["nativeAuthSources"][&p.thumbprint],
        )?;
        if row.json["spec"]["automatic"] == true
            && spec["nativeAuthSources"][&p.thumbprint] == observed
        {
            return Err(fail("plugin_auth_source_unchanged"));
        }
    }
    let mut s = row.json["spec"].clone();
    s["account_id"] = json!(input.account_id);
    s["account_label"] = json!(input.account_label);
    s["state"] = json!("staged");
    s["expected_revision"] = json!(
        old.as_ref()
            .map(|r| revision(&r.json["spec"]))
            .transpose()?
            .unwrap_or(0)
    );
    s["credential"] =
        credentials::encrypt(&input.credential, &escrow_context(p.user_id, &row.name, &s))?;
    save(tx, p.user_id, "ConnectorTransfer", &row.name, None, s, true).await?;
    save(
        tx,
        p.user_id,
        "ConnectorMigration",
        &row.name,
        Some(&row),
        row.json["spec"].clone(),
        false,
    )
    .await?;
    Ok(json!({"state":"staged"}))
}
async fn transfer(
    tx: &mut impl MysqlTransaction,
    p: &Principal,
    operation: &str,
    id: &str,
) -> MysqlResult<Value> {
    let row = get(tx, p.user_id, "ConnectorTransfer", id, false)
        .await?
        .ok_or_else(|| fail("plugin_auth_migration_expired"))?;
    let pkg = validated(tx, p, &row, true).await?;
    let mut s = row.json["spec"].clone();
    match operation {
        "plugin.auth.transfer.prepare" => {
            if s["state"] == "completed" {
                return Ok(json!({"state":"completed"}));
            }
            if !row.is_active || s["state"] != "staged" {
                return Err(fail("plugin_auth_migration_expired"));
            }
            Ok(
                json!({"state":"staged","package":pkg.metadata()?,"credential":credentials::decrypt(&s["credential"],&escrow_context(p.user_id,id,&s))?}),
            )
        }
        "plugin.auth.transfer.abort" => {
            if s["state"] == "aborted" {
                return Ok(json!({"state":"aborted"}));
            }
            if s["state"] != "staged" {
                return Err(fail("plugin_auth_operation_mismatch"));
            }
            s["state"] = json!("aborted");
            s.as_object_mut().expect("spec").remove("credential");
            save(tx, p.user_id, "ConnectorTransfer", id, Some(&row), s, false).await?;
            Ok(json!({"state":"aborted"}))
        }
        "plugin.auth.transfer.finish" => {
            if s["state"] == "completed" {
                let connection = get(
                    tx,
                    p.user_id,
                    "ConnectorConnection",
                    text(&s, "connection_id")?,
                    true,
                )
                .await?
                .ok_or_else(invalid)?;
                return Ok(json!({"connection":metadata(&connection)}));
            }
            if !row.is_active || s["state"] != "staged" {
                return Err(fail("plugin_auth_migration_expired"));
            }
            let old = target(
                tx,
                p,
                &pkg,
                text(&s, "account_id")?,
                !s["loginGeneration"].is_null(),
            )
            .await?;
            if old
                .as_ref()
                .map(|r| revision(&r.json["spec"]))
                .transpose()?
                .unwrap_or(0)
                != s["expected_revision"].as_i64().ok_or_else(invalid)?
            {
                return Err(fail("plugin_auth_revision_conflict"));
            }
            let input = Enrollment {
                migration_id: id.into(),
                account_id: text(&s, "account_id")?.into(),
                account_label: s["account_label"].as_str().unwrap_or_default().into(),
                credential: credentials::decrypt(
                    &s["credential"],
                    &escrow_context(p.user_id, id, &s),
                )?,
            };
            let connection = activate(tx, p, &pkg, &s, &input).await?;
            s["state"] = json!("completed");
            s["connection_id"] = connection["id"].clone();
            s.as_object_mut().expect("spec").remove("credential");
            save(tx, p.user_id, "ConnectorTransfer", id, Some(&row), s, false).await?;
            Ok(json!({"connection":connection}))
        }
        _ => Err(invalid()),
    }
}
