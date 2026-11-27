use super::*;

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
    assert_eq!(rows.len(), 7);
    let assistant = &first["assistant"];
    for definition in assistant["definitions"].as_array().unwrap() {
        assert_eq!(definition["team"]["spec"]["collaborationModel"], "solo");
        let members = definition["team"]["spec"]["members"].as_array().unwrap();
        assert_eq!(members.len(), 1);
        assert_eq!(
            members[0]["botRef"]["name"],
            definition["bot"]["metadata"]["name"]
        );
    }
    assert_eq!(
        assistant["defaultTeamRef"]["name"],
        assistant["definitions"][0]["team"]["metadata"]["name"]
    );
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
    verify_legacy_account_upgrade(mysql, user + 2).await?;
    Ok(())
}

async fn verify_legacy_account_upgrade(
    mysql: &brz_mysql::MysqlService,
    user: i64,
) -> anyhow::Result<()> {
    mysql.execute(
        "INSERT INTO users (id,user_name,password_hash,role,auth_source,preferences,is_active) VALUES (?,'personal-assistant-legacy','fixture','user','local','{}',true)",
        (user,),
    ).await?;
    mysql.execute(
        "INSERT INTO kinds (user_id,kind,name,namespace,json,is_active,created_at,updated_at) VALUES (?,'Device','legacy-device','default',JSON_OBJECT('spec',JSON_OBJECT('deviceType','cloud','deviceId','legacy-runtime')),true,NOW(),NOW())",
        (user,),
    ).await?;
    let mut original = Vec::new();
    let mut identities = Vec::new();
    for (role_id, display_name, prompt) in [
        ("@primary", "Legacy assistant", "Keep my primary prompt"),
        ("support", "Legacy support", "Keep my support prompt"),
    ] {
        let (identity, [ghost, bot, _]) = definition_documents(Definition {
            execution_device_id: Some("legacy-device".into()),
            role_id: role_id.into(),
            name: display_name.into(),
            prompt: prompt.into(),
        });
        original.extend([ghost, bot]);
        // Accounts created before the Team-backed contract referenced Bots directly.
        identities.push(json!({"roleId":role_id,"botRef":identity["teamRef"]}));
    }
    let stop_states = json!({
        "legacy-device":{"requestId":"pending","pending":true,"expectedVersion":7},
        "old-device":{"requestId":"cleared","pending":false}
    });
    let mut records = original.clone();
    records.push(resource(
        ACCOUNT_KIND,
        DEFAULT_NAME,
        "",
        json!({
            "defaultBotRef":{"name":DEFAULT_NAME,"namespace":NAMESPACE},
            "identities":identities,
            "retiredRoleIds":["retired"],
            "stopIntentStates":stop_states
        }),
    ));
    mysql
        .with_transaction(async |tx| insert_documents(tx, user, records).await)
        .await?;

    let start = Initialize {
        definitions: vec![Definition {
            execution_device_id: None,
            role_id: "@primary".into(),
            name: "Never overwrite".into(),
            prompt: "Never overwrite".into(),
        }],
    };
    let stop = StopIntentChange {
        expected_version: Some(7),
        ..stop_change("legacy-runtime", StopIntentOperation::Mark, "pending", None)
    };
    let (read, initialized, marked) = tokio::try_join!(
        read_account(mysql, user),
        initialize_for(mysql, user, start),
        set_stop_intent(mysql, user, stop),
    )?;
    assert_eq!(read, initialized);
    assert_eq!(read, stop_intent_view(marked));
    assert_eq!(
        read["assistant"]["defaultTeamRef"],
        json!({"name":DEFAULT_NAME,"namespace":NAMESPACE})
    );
    assert_eq!(read["assistant"]["retiredRoleIds"], json!(["retired"]));
    assert_eq!(
        read["assistant"]["stopIntents"],
        json!([{"deviceId":"legacy-device","requestId":"pending","expectedVersion":7}])
    );
    assert_eq!(
        read["assistant"]["stopIntentGenerations"],
        json!({"legacy-device":"pending","old-device":"cleared"})
    );

    let rows: Vec<Row> = mysql.fetch_all(SELECT, (user, NAMESPACE)).await?;
    assert_eq!(rows.len(), 7);
    let account = &rows
        .iter()
        .find(|row| row.kind == ACCOUNT_KIND && row.name == DEFAULT_NAME)
        .unwrap()
        .document
        .0;
    assert!(account["spec"].get("defaultBotRef").is_none());
    assert_eq!(account["spec"]["stopIntentStates"], stop_states);
    let definitions = read["assistant"]["definitions"].as_array().unwrap();
    for (identity, definition) in account["spec"]["identities"]
        .as_array()
        .unwrap()
        .iter()
        .zip(definitions)
    {
        assert!(identity.get("botRef").is_none());
        assert_eq!(identity["roleId"], definition["roleId"]);
        let team_ref = &identity["teamRef"];
        assert_eq!(definition["team"]["metadata"]["name"], team_ref["name"]);
        assert_eq!(
            definition["team"]["spec"]["members"],
            json!([{"botRef":team_ref,"role":"leader"}])
        );
    }
    for document in original {
        let (kind, name) = document_key(&document)?;
        assert_eq!(
            rows.iter()
                .find(|row| row.kind == kind && row.name == name)
                .unwrap()
                .document
                .0,
            document
        );
    }
    assert_eq!(read_account(mysql, user).await?, read);
    Ok(())
}

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
