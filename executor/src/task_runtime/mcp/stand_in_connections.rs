//! Source discovery and bounded reads never grant subscriptions or collect credentials.
use super::*;

pub(super) fn read_tool(bound_work: bool) -> Value {
    let mut tool = json!({"name":"read_source","description":"Read an exact source already connected to this identity. First inspect list_connection_providers for the selected provider's read.inputSchema, read.itemSchema and pagination. Supply only that provider's query fields; the plugin defines its query defaults and limits. Follow nextCursor on the same source until hasMore is false before deciding the outcome. Cursors are opaque; omit query on continuation unless preserving the original query exactly. Collection checkpoints and subscription boundaries are not read cursors. Read access does not grant actions or configuration changes. Never invent IDs or broaden scope.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"source":{"type":"object","properties":{"providerId":{"type":"string"},"profile":{"type":"string"},"kind":{"type":"string"},"id":{"type":"string"}},"required":["providerId","profile","kind","id"]},"query":{"type":"object","description":"Provider-defined query from read.inputSchema; no framework business defaults."},"cursor":{"type":"string","minLength":1,"maxLength":8192}},"required":["source"]}});
    if bound_work {
        tool["inputSchema"]["required"] = json!([]);
        tool["description"] = json!(format!("{} In this source-bound work, omit source to read only the host-verified current work source; an explicit source must match that same resource. Use read_work for the original messages. This never grants access to the role's other connections.", tool["description"].as_str().unwrap_or_default()));
    }
    tool
}

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
    connection_discovery_result(provider, kind, resources)
}

fn connection_discovery_result(
    provider: &str,
    kind: &str,
    resources: Value,
) -> Result<Value, String> {
    if let Some(status) = resource_availability(&resources, provider, kind)? {
        return Ok(status);
    }
    let has_resources = resources["items"]
        .as_array()
        .is_some_and(|items| !items.is_empty());
    Ok(json!({
        "status":if has_resources {"scope_required"} else {"setup_required"},
        "providerId":provider,"kind":kind,"resources":resources,
        "capabilityScope":"stand_in_connections","executionPluginsAssessed":false,
        "nextStep":if has_resources {
            "Select the exact source and handling scope requested by the user. Read get_profile and use propose_profile without replacing other connections; wait for native confirmation before using the subscription. Discovery alone grants no source access. Separately installed execution plugins retain their existing native permissions."
        } else {
            "This stand-in provider returned no matching source resources. This is not a finding that separately installed execution skills, tools or accounts are unavailable or unauthenticated. For the requested one-time read, delegate bounded discovery and use of relevant already-installed execution capabilities through their existing native authorization; a new subscription is not a prerequisite. Do not infer credentials, migrate accounts, create subscriptions, broaden scope or evade a denied operation. Configure this provider through its native source setup only when that connection is actually needed; never request credentials in chat."
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
        || identity.readonly_worker
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

pub(crate) fn source_read_input(source: Value, arguments: &Value) -> Result<Value, String> {
    if !arguments.as_object().is_some_and(|fields| {
        fields
            .keys()
            .all(|key| matches!(key.as_str(), "source" | "query" | "cursor"))
    }) {
        return Err(
            "source_read_input_invalid: Supply source, provider query and opaque cursor only"
                .into(),
        );
    }
    let mut input = json!({"source":source});
    if let Some(query) = arguments.get("query") {
        if !query.is_object() || query.to_string().len() > 65536 {
            return Err(
                "source_read_query_invalid: Supply a query object of at most 65536 bytes".into(),
            );
        }
        input["query"] = query.clone();
    }
    if let Some(cursor) = arguments.get("cursor") {
        let cursor = cursor
            .as_str()
            .filter(|value| !value.trim().is_empty() && value.len() <= 8192)
            .ok_or("source_read_cursor_invalid: Supply a bounded opaque read cursor")?;
        input["cursor"] = json!(cursor);
    }
    Ok(input)
}

pub(super) fn scoped_provider_catalog(catalog: &Value, source: &Value) -> Value {
    let items = catalog["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|provider| provider["id"] == source["providerId"])
        .map(|provider| {
            let mut item = json!({"id":provider["id"]});
            for key in ["name", "label", "read", "actions"] {
                if let Some(value) = provider.get(key) {
                    item[key] = value.clone();
                }
            }
            item
        })
        .collect::<Vec<_>>();
    json!({"items":items})
}

pub(super) async fn list_providers(identity: &StandInMcpIdentity) -> Result<Value, String> {
    let sources = if identity.readonly_worker {
        super::super::stand_in_tasks::call(
            identity.clone(),
            "delegated_read_sources".into(),
            json!({}),
        )
        .await?["sources"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    } else if identity.work.is_some() {
        vec![
            super::super::stand_in_tasks::call(
                identity.clone(),
                "authorize_source_read".into(),
                Value::Null,
            )
            .await?,
        ]
    } else {
        Vec::new()
    };
    let catalog = crate::runtime_work::connection_host::call("catalog", None, json!({}))
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let mut result = if identity.readonly_worker {
        delegated_provider_catalog(&catalog, &sources)
    } else {
        sources.first().map_or(catalog.clone(), |source| {
            scoped_provider_catalog(&catalog, source)
        })
    };
    result["capabilityScope"] = json!("stand_in_connections");
    result["executionPluginsAssessed"] = json!(false);
    Ok(result)
}

fn delegated_provider_catalog(catalog: &Value, sources: &[Value]) -> Value {
    let mut items = Vec::new();
    let mut references = Vec::new();
    for source in sources {
        references.push(json!({"providerId":source["providerId"],"profile":source["profile"],"kind":source["kind"],"id":source["id"]}));
        if items
            .iter()
            .any(|item: &Value| item["id"] == source["providerId"])
        {
            continue;
        }
        for mut provider in scoped_provider_catalog(catalog, source)["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            provider.as_object_mut().unwrap().remove("actions");
            items.push(provider);
        }
    }
    json!({"items":items,"sources":references})
}

pub(super) async fn read_source(
    runtime: &TaskRuntime,
    identity: &StandInMcpIdentity,
    arguments: Value,
) -> Result<Value, String> {
    let source = if identity.readonly_worker {
        super::super::stand_in_tasks::call(
            identity.clone(),
            "authorize_delegated_source_read".into(),
            arguments["source"].clone(),
        )
        .await?
    } else if identity.work.is_some() {
        super::super::stand_in_tasks::call(
            identity.clone(),
            "authorize_source_read".into(),
            arguments["source"].clone(),
        )
        .await?
    } else {
        let settings = runtime
            .stand_in_store()
            .personal_stand_in(identity.user, &identity.device)
            .map_err(|error| error.to_string())?;
        authorized_source(&settings, identity, &arguments["source"])?
    };
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
    fn source_discovery_does_not_infer_execution_plugin_availability_or_authentication() {
        for provider in [
            "@independent/files/service",
            "@independent/calendar/service",
        ] {
            let empty = connection_discovery_result(
                provider,
                "resource",
                json!({"items":[],"hasMore":false}),
            )
            .unwrap();
            assert_eq!(empty["status"], "setup_required");
            assert_eq!(empty["providerId"], provider);
            assert_eq!(empty["capabilityScope"], "stand_in_connections");
            assert_eq!(empty["executionPluginsAssessed"], false);
            assert!(empty.get("code").is_none());
            assert!(empty.get("authTarget").is_none());
            assert!(empty.get("pluginKey").is_none());
            assert!(empty["nextStep"]
                .as_str()
                .unwrap()
                .contains("one-time read"));
            let resources = json!({"items":[{"id":"one","profile":"account","kind":"resource"}],"hasMore":false});
            let selected =
                connection_discovery_result(provider, "resource", resources.clone()).unwrap();
            assert_eq!(selected["status"], "scope_required");
            assert_eq!(selected["resources"], resources);
            assert_eq!(selected["executionPluginsAssessed"], false);
            assert!(selected.get("policy").is_none());
            let target = json!({"pluginKey":"actual-plugin","connectorSlug":"actual-account","instance":"https://service.example"});
            let auth = connection_discovery_result(
                provider,
                "resource",
                json!({"items":[],"availability":{"status":"auth_required","authTarget":target}}),
            )
            .unwrap();
            assert_eq!(auth["code"], "connector_auth_required");
            assert_eq!(auth["authTarget"], target);
            let denied = connection_discovery_result(
                provider,
                "resource",
                json!({"items":[],"availability":{"status":"error","code":"permission_denied"}}),
            )
            .unwrap();
            assert_eq!(denied["status"], "error");
            assert!(denied.get("connectorSlug").is_none());
            assert!(denied.get("executionPluginsAssessed").is_none());
        }
    }

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
            memory_review: false,
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
    fn source_reads_forward_provider_queries_without_business_defaults() {
        let source = json!({"boundary":{"partition":"1","sequence":99}});
        assert_eq!(
            source_read_input(source.clone(), &json!({})).unwrap(),
            json!({"source":source})
        );
        let query = json!({"state":"failed","pageSize":75,"include":["checks"],"since":"2000-01-01T00:00:00Z"});
        let input = source_read_input(source.clone(), &json!({"query":query})).unwrap();
        assert_eq!(input, json!({"source":source,"query":query}));
        for arguments in [
            json!({"query":null}),
            json!({"query":[]}),
            json!({"query":"text"}),
            json!({"query":{"value":"x".repeat(65536)}}),
            json!({"since":"2026-01-01T00:00:00Z"}),
            json!({"limit":20}),
        ] {
            assert!(source_read_input(source.clone(), &arguments).is_err());
        }
    }

    #[test]
    fn bound_work_catalog_exposes_only_its_provider_capabilities() {
        let read = json!({"inputSchema":{"type":"object","properties":{"state":{"type":"string"}}},"itemSchema":{"type":"object"},"pagination":"cursor"});
        let catalog = json!({"items":[{"id":"@third-party/builds","read":read,"actions":[],"authTarget":{"private":"not needed"},"resourceQuerySchema":{"discovery":true}},{"id":"@other/mail","read":{"pagination":"none"}}]});
        let scoped =
            scoped_provider_catalog(&catalog, &json!({"providerId":"@third-party/builds"}));
        assert_eq!(
            scoped,
            json!({"items":[{"id":"@third-party/builds","read":read,"actions":[]}]})
        );
        assert_eq!(
            scoped_provider_catalog(&catalog, &json!({"providerId":"missing"})),
            json!({"items":[]})
        );
    }

    #[test]
    fn delegated_catalog_contains_selected_refs_and_read_capabilities_only() {
        let read = json!({"inputSchema":{"type":"object"},"itemSchema":{"type":"object"},"pagination":"cursor"});
        let catalog = json!({"items":[{"id":"selected","read":read,"actions":[{"id":"write"}],"authTarget":{"private":"not exposed"}},{"id":"unselected","read":read}]});
        let sources = vec![
            json!({"providerId":"selected","profile":"account","kind":"repo","id":"one","policy":{"automatic":true}}),
            json!({"providerId":"selected","profile":"account","kind":"repo","id":"two"}),
        ];
        assert_eq!(
            delegated_provider_catalog(&catalog, &sources),
            json!({"items":[{"id":"selected","read":read}],
            "sources":[{"providerId":"selected","profile":"account","kind":"repo","id":"one"},{"providerId":"selected","profile":"account","kind":"repo","id":"two"}]})
        );
        assert_eq!(
            delegated_provider_catalog(&catalog, &[]),
            json!({"items":[],"sources":[]})
        );
    }

    #[test]
    fn source_read_cursor_continuations_do_not_invent_a_new_window_or_bypass_current_scope() {
        let source = json!({"providerId":"@company/events/source","profile":"account","kind":"folder","id":"selected","boundary":{"cursor":"collection"}});
        let input =
            source_read_input(source.clone(), &json!({"cursor":"opaque-read-page"})).unwrap();
        assert_eq!(input, json!({"source":source,"cursor":"opaque-read-page"}));
        assert!(input.get("query").is_none());
        let query = json!({"offsets":["opaque-domain-position"],"pageSize":75});
        assert_eq!(
            source_read_input(source.clone(), &json!({"cursor":"page","query":query})).unwrap()
                ["query"],
            query
        );
        for arguments in [
            json!({"cursor":""}),
            json!({"cursor":null}),
            json!({"cursor":"x".repeat(8193)}),
            json!({"cursor":"page","query":[]}),
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
