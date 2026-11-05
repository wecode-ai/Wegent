//! Source discovery and bounded reads never grant subscriptions or collect credentials.
use super::*;

fn provider_status(catalog: &Value, provider: &str, kind: &str) -> Result<Value, String> {
    let entry = catalog["items"]
        .as_array()
        .and_then(|items| items.iter().find(|entry| entry["id"] == provider))
        .ok_or("connection_provider_not_found: Select an installed provider from list_connection_providers")?;
    if !entry["resourceKinds"]
        .as_array()
        .is_some_and(|kinds| kinds.iter().any(|value| value == kind))
    {
        return Err("connection_kind_invalid: Select a declared resource kind".into());
    }
    let status = entry["availability"]["status"]
        .as_str()
        .unwrap_or("unavailable");
    if status == "ready" {
        let mut result = json!({"status":"ready"});
        if let Some(schema) = entry.get("resourceQuerySchema") {
            result["querySchema"] = schema.clone();
        }
        return Ok(result);
    }
    let mut result = json!({"status":status,"providerId":provider,"kind":kind});
    if status == "auth_required" {
        let target = &entry["authTarget"];
        if target["pluginKey"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
            && target["connectorSlug"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        {
            result["code"] = json!("connector_auth_required");
            result["pluginKey"] = target["pluginKey"].clone();
            result["connectorSlug"] = target["connectorSlug"].clone();
            result["authTarget"] =
                json!({"pluginKey":target["pluginKey"],"connectorSlug":target["connectorSlug"]});
            if target["instance"].is_string() {
                result["instance"] = target["instance"].clone();
                result["authTarget"]["instance"] = target["instance"].clone();
            }
            result["nextStep"] = json!("Request native Wework connector authorization using this exact identity. Preserve any supplied public instance verbatim in the authorization request and final auth-required message; never infer or substitute it. Resume connect_source after authorization succeeds.");
        } else {
            result["nextStep"] = json!("Open this provider in stand-in Settings > Connections. Its native authorization identity is unavailable; do not invent one.");
        }
    } else {
        result["nextStep"] = json!("Open this provider in stand-in Settings > Connections to resolve its reported availability. Do not treat a dependency or network error as a login request.");
    }
    Ok(result)
}

fn resource_availability(
    resources: &Value,
    provider: &str,
    kind: &str,
) -> Result<Option<Value>, String> {
    let Some(availability) = resources.get("availability") else {
        return Ok(None);
    };
    if availability["status"] == "ready" {
        return Ok(None);
    }
    let catalog = json!({"items":[{"id":provider,"resourceKinds":[kind],
        "availability":availability,"authTarget":availability["authTarget"]}]});
    provider_status(&catalog, provider, kind).map(Some)
}

fn query_setup_required(schema: &Value, query: &str) -> Option<Value> {
    if !schema.is_object() {
        return None;
    }
    // The provider validates parameter values; this preflight only discovers
    // missing public inputs and never pretends to validate all JSON Schema.
    let parsed = if query.trim().is_empty() {
        Some(json!({}))
    } else {
        serde_json::from_str::<Value>(query).ok()
    };
    let object = parsed.as_ref().and_then(Value::as_object);
    let missing: Vec<&str> = schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|field| {
            object
                .and_then(|object| object.get(*field))
                .map_or(true, |value| {
                    value.is_null() || value.as_str().is_some_and(|text| text.trim().is_empty())
                })
        })
        .collect();
    if object.is_some() && missing.is_empty() {
        return None;
    }
    Some(json!({"status":"setup_required","querySchema":schema,
        "missingFields":missing,"reason":if object.is_none() {"query_object_required"} else {"missing_query_fields"},
        "nextStep":"Ask a structured question for the missing non-secret connection parameters. Encode the selected values as a JSON object in query and retry connect_source. Do not guess instances or request credentials in chat."}))
}

pub(super) async fn connect_source(arguments: Value) -> Result<Value, String> {
    let provider = arguments["providerId"]
        .as_str()
        .ok_or("providerId is required")?;
    let kind = arguments["kind"].as_str().ok_or("kind is required")?;
    let call = crate::runtime_work::connection_host::call;
    let catalog = call("catalog", None, json!({}))
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let status = provider_status(&catalog, provider, kind)?;
    if status["status"] != "ready" {
        return Ok(status);
    }
    let query = arguments["query"].as_str().unwrap_or_default();
    if let Some(mut setup) = query_setup_required(&status["querySchema"], query) {
        setup["providerId"] = json!(provider);
        setup["kind"] = json!(kind);
        return Ok(setup);
    }
    let resources = call(
        "listResources",
        Some(provider),
        json!({
            "kind":kind,"query":query
        }),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    if let Some(status) = resource_availability(&resources, provider, kind)? {
        return Ok(status);
    }
    let has_resources = resources["items"]
        .as_array()
        .is_some_and(|items| !items.is_empty());
    Ok(json!({
        "status":if has_resources {"scope_required"} else {"setup_required"},
        "providerId":provider,"kind":kind,"resources":resources,
        "nextStep":if has_resources {
            "Ask the user to select exact resources and handling scope. Read get_profile and use propose_profile without replacing other connections; wait for native confirmation before using the subscription."
        } else {
            "No matching resources are available. Ask the user to configure an account in stand-in Settings > Connections using the secure native form, or refine the search. Never request credentials in chat. Resume connect_source after setup."
        }
    }))
}

fn authorized_source(
    settings: &Value,
    identity: &StandInMcpIdentity,
    source: &Value,
) -> Result<Value, String> {
    if identity.work.is_some()
        || identity.coordinator_batch.is_some()
        || identity.project.is_some()
        || identity.review
        || settings["userId"].as_i64() != Some(identity.user)
        || settings["executionDeviceId"] != identity.device
    {
        return Err(
            "source_access_denied: This conversation cannot read independent sources".into(),
        );
    }
    let role_id = identity.role.as_deref().unwrap_or("@primary");
    let identities = crate::task_runtime::personal_stand_in::stand_in_identities(settings);
    let role = identities
        .iter()
        .find(|role| role["id"] == role_id)
        .ok_or("source_access_denied: The selected identity is no longer available")?;
    role["connections"]
        .as_array()
        .and_then(|rows| {
            rows.iter().find(|row| {
                row.get("scope").is_none()
                    && ["providerId", "profile", "kind", "id"].iter().all(|key| {
                        row[*key].as_str().is_some_and(|value| !value.is_empty())
                            && row[*key] == source[*key]
                    })
            })
        })
        .cloned()
        .ok_or(
            "source_not_connected: This exact source is not connected to the selected identity"
                .into(),
        )
}

fn source_read_input(source: Value, arguments: &Value) -> Result<Value, String> {
    if let Some(cursor) = arguments.get("cursor") {
        let cursor = cursor
            .as_str()
            .filter(|value| !value.trim().is_empty() && value.len() <= 8192)
            .ok_or("source_read_cursor_invalid: Supply a bounded opaque read cursor")?;
        let mut input = json!({"source":source,"cursor":cursor});
        if let Some(limit) = arguments.get("limit") {
            let limit = limit
                .as_u64()
                .filter(|limit| (1..=20).contains(limit))
                .ok_or("source_read_range_invalid: limit must be an integer from 1 to 20")?;
            input["limit"] = json!(limit);
        }
        if let Some(since) = arguments.get("since") {
            let since = since
                .as_str()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .ok_or("source_read_range_invalid: since must be an RFC3339 timestamp")?;
            input["since"] = json!(since.to_rfc3339());
        }
        return Ok(input);
    }
    let now = chrono::Utc::now();
    let since = match arguments.get("since") {
        None => now - chrono::Duration::days(1),
        Some(value) => value
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&chrono::Utc))
            .ok_or("source_read_range_invalid: since must be an RFC3339 timestamp")?,
    };
    let limit = arguments
        .get("limit")
        .map_or(Some(20), Value::as_u64)
        .filter(|limit| (1..=20).contains(limit))
        .ok_or("source_read_range_invalid: limit must be an integer from 1 to 20")?;
    if since < now - chrono::Duration::days(7) || since > now {
        return Err("source_read_range_invalid: Read at most the past seven days".into());
    }
    Ok(json!({"source":source,"since":since.to_rfc3339(),"limit":limit}))
}

pub(super) async fn read_source(
    runtime: &TaskRuntime,
    identity: &StandInMcpIdentity,
    arguments: Value,
) -> Result<Value, String> {
    let settings = runtime
        .stand_in_store()
        .personal_stand_in(identity.user, &identity.device)
        .map_err(|error| error.to_string())?;
    let source = authorized_source(&settings, identity, &arguments["source"])?;
    let input = source_read_input(source, &arguments)?;
    crate::runtime_work::connection_host::call(
        "readSource",
        input["source"]["providerId"].as_str(),
        input.clone(),
    )
    .await
    .map_err(|error| format!("{}: {}", error.code, error.message))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_discovery_preserves_exact_native_authorization_identity() {
        let target = json!({"pluginKey":"code-host","connectorSlug":"native-instance-hash","instance":"https://git.company.example"});
        let resources =
            json!({"items":[],"availability":{"status":"auth_required","authTarget":target}});
        let result =
            resource_availability(&resources, "@third-party/connection/service", "repository")
                .unwrap()
                .unwrap();
        assert_eq!(result["code"], "connector_auth_required");
        assert_eq!(result["authTarget"], target);
        assert_eq!(result["instance"], target["instance"]);
        assert_eq!(result["pluginKey"], target["pluginKey"]);
        assert_eq!(result["connectorSlug"], target["connectorSlug"]);
        let mut extra = resources.clone();
        extra["availability"]["authTarget"]["unexpected"] = json!("not-forwarded");
        assert_eq!(
            resource_availability(&extra, "source", "repository")
                .unwrap()
                .unwrap()["authTarget"],
            target
        );
        for resources in [
            json!({"items":[]}),
            json!({"items":[],"availability":{"status":"ready"}}),
        ] {
            assert!(resource_availability(&resources, "source", "repository")
                .unwrap()
                .is_none());
        }
        let denied = resource_availability(
            &json!({"items":[],"availability":{"status":"error","code":"git_permission_denied"}}),
            "source",
            "repository",
        )
        .unwrap()
        .unwrap();
        assert!(denied["code"].is_null());
        assert!(denied["pluginKey"].is_null());
        let missing = resource_availability(
            &json!({"items":[],"availability":{"status":"auth_required"}}),
            "source",
            "repository",
        )
        .unwrap()
        .unwrap();
        assert!(missing["code"].is_null());
        assert!(missing["connectorSlug"].is_null());
    }

    #[test]
    fn discovery_reports_declared_public_parameters_before_calling_a_provider() {
        let schema = json!({"type":"object","properties":{"instance":{"type":"string"},"search":{"type":"string"}},"required":["instance"]});
        let catalog = json!({"items":[{"id":"@third-party/connection/service","resourceKinds":["repository"],"resourceQuerySchema":schema,"availability":{"status":"ready"}}]});
        let status =
            provider_status(&catalog, "@third-party/connection/service", "repository").unwrap();
        assert_eq!(status["querySchema"], schema);
        for query in [
            "",
            "{}",
            "{\"instance\":null}",
            "{\"instance\":\" \"}",
            "not-json",
            "[]",
        ] {
            let setup = query_setup_required(&status["querySchema"], query).unwrap();
            assert_eq!(setup["status"], "setup_required");
            assert_eq!(setup["missingFields"], json!(["instance"]));
            assert_eq!(setup["querySchema"], schema);
        }
        assert!(query_setup_required(
            &schema,
            r#"{"instance":"https://git.company.example","search":"product"}"#
        )
        .is_none());
        assert!(query_setup_required(&Value::Null, "plain-text-search").is_none());
        // Values still go through the selected provider's authoritative validation.
        assert!(query_setup_required(&schema, r#"{"instance":false}"#).is_none());
    }

    #[test]
    fn connection_attempt_uses_only_declared_authorization_and_kind() {
        let catalog = json!({"items":[{"id":"mail","resourceKinds":["inbox"],"availability":{"status":"auth_required"},"authTarget":{"pluginKey":"mail-plugin","connectorSlug":"account"}}]});
        let result = provider_status(&catalog, "mail", "inbox").unwrap();
        assert_eq!(result["code"], "connector_auth_required");
        assert_eq!(result["pluginKey"], "mail-plugin");
        assert_eq!(result["connectorSlug"], "account");
        assert!(provider_status(&catalog, "invented", "inbox").is_err());
        assert!(provider_status(&catalog, "mail", "invented").is_err());
        let mut missing = catalog.clone();
        missing["items"][0]["authTarget"] = Value::Null;
        let result = provider_status(&missing, "mail", "inbox").unwrap();
        assert!(result["pluginKey"].is_null());
        assert!(result["code"].is_null());
        missing["items"][0]["availability"]["status"] = json!("dependency_unavailable");
        assert_eq!(
            provider_status(&missing, "mail", "inbox").unwrap()["status"],
            "dependency_unavailable"
        );
    }

    fn identity(role: Option<&str>) -> StandInMcpIdentity {
        StandInMcpIdentity {
            task_id: "chat".into(),
            user: 7,
            device: "mac".into(),
            role: role.map(str::to_owned),
            work: None,
            ask_before_act: true,
            coordinator_batch: None,
            project: None,
            review: false,
            readonly_worker: false,
        }
    }

    #[test]
    fn source_reads_require_the_selected_identities_exact_saved_connection() {
        let source = json!({"providerId":crate::task_runtime::personal_stand_in::EMAIL_PROVIDER,
            "profile":"mailbox","kind":"inbox","id":"INBOX","name":"Connected inbox",
            "policy":{"automatic":true,"askBeforeAct":true},
            "boundary":{"partition":"1","sequence":99}});
        let settings = json!({"userId":7,"executionDeviceId":"mac","primary":{"connections":[source]},
            "roles":[{"id":"other","connections":[]}]});
        assert_eq!(
            authorized_source(&settings, &identity(None), &source).unwrap(),
            source
        );
        assert!(authorized_source(&settings, &identity(Some("other")), &source).is_err());
        let mut requested = source.clone();
        requested["policy"]["askBeforeAct"] = json!(false);
        assert_eq!(
            authorized_source(&settings, &identity(None), &requested).unwrap()["policy"]
                ["askBeforeAct"],
            true
        );
        let mut role_only = settings.clone();
        role_only["primary"]["connections"] = json!([]);
        role_only["roles"][0]["connections"] = json!([source]);
        assert!(authorized_source(&role_only, &identity(Some("other")), &source).is_ok());
        assert!(authorized_source(&role_only, &identity(None), &source).is_err());
        for (key, replacement) in [
            ("profile", "unconnected"),
            ("providerId", "invented"),
            ("id", "*"),
            ("kind", "other"),
        ] {
            let mut requested = source.clone();
            requested[key] = json!(replacement);
            assert!(authorized_source(&settings, &identity(None), &requested).is_err());
        }
        let mut external = identity(None);
        external.work = Some("work".into());
        assert!(authorized_source(&settings, &external, &source).is_err());
        external.work = None;
        external.user = 8;
        assert!(authorized_source(&settings, &external, &source).is_err());
        let mut moved = settings.clone();
        moved["executionDeviceId"] = json!("other-device");
        assert!(authorized_source(&moved, &identity(None), &source).is_err());
        let mut removed = settings;
        removed["primary"]["connections"] = json!([]);
        assert!(authorized_source(&removed, &identity(None), &source).is_err());
    }

    #[test]
    fn source_reads_use_saved_plugin_identity_without_a_builtin_provider_allowlist() {
        let source = json!({"providerId":"@company/build-events/repositories",
            "profile":"company","kind":"repository","id":"org/product","name":"Builds",
            "policy":{"automatic":true,"askBeforeAct":true}});
        let settings = json!({"userId":7,"executionDeviceId":"mac",
            "primary":{"connections":[source]},"roles":[]});
        let request = json!({"providerId":"@company/build-events/repositories",
            "profile":"company","kind":"repository","id":"org/product"});
        assert_eq!(
            authorized_source(&settings, &identity(None), &request).unwrap(),
            source
        );
        let mut foreign = request;
        foreign["providerId"] = json!("@other/build-events/repositories");
        assert!(authorized_source(&settings, &identity(None), &foreign).is_err());
    }

    #[test]
    fn source_reads_are_bounded_without_modifying_the_intake_checkpoint() {
        let source = json!({"boundary":{"partition":"1","sequence":99}});
        let input = source_read_input(source.clone(), &json!({})).unwrap();
        assert_eq!(input["source"], source);
        assert_eq!(input["limit"], 20);
        for arguments in [
            json!({"limit":0}),
            json!({"limit":21}),
            json!({"limit":1.5}),
            json!({"since":"invalid"}),
            json!({"since":"2000-01-01T00:00:00Z"}),
            json!({"since":"2099-01-01T00:00:00Z"}),
        ] {
            assert!(source_read_input(source.clone(), &arguments).is_err());
        }
    }

    #[test]
    fn source_read_cursor_continuations_do_not_invent_a_new_window_or_bypass_current_scope() {
        let source = json!({"providerId":"@company/events/source","profile":"account","kind":"folder","id":"selected","boundary":{"cursor":"collection"}});
        let input =
            source_read_input(source.clone(), &json!({"cursor":"opaque-read-page"})).unwrap();
        assert_eq!(input, json!({"source":source,"cursor":"opaque-read-page"}));
        assert!(input.get("since").is_none());
        assert!(input.get("limit").is_none());
        for arguments in [
            json!({"cursor":""}),
            json!({"cursor":null}),
            json!({"cursor":"x".repeat(8193)}),
            json!({"cursor":"page","limit":21}),
            json!({"cursor":"page","since":"invalid"}),
        ] {
            assert!(source_read_input(source.clone(), &arguments).is_err());
        }
        let mut settings = json!({"userId":7,"executionDeviceId":"mac","primary":{"connections":[source]},"roles":[]});
        assert!(authorized_source(&settings, &identity(None), &input["source"]).is_ok());
        settings["primary"]["connections"] = json!([]);
        assert!(authorized_source(&settings, &identity(None), &input["source"]).is_err());
        settings["roles"] = json!([{"id":"other","connections":[source]}]);
        assert!(authorized_source(&settings, &identity(None), &input["source"]).is_err());
        assert!(authorized_source(&settings, &identity(Some("other")), &input["source"]).is_ok());
        assert_eq!(input["source"]["boundary"]["cursor"], "collection");
    }
}
