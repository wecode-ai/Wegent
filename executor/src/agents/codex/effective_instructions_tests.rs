use super::*;

const POLICY_PREFIX: &str = "wework.host-policy.";
const MANIFEST_KEY: &str = "wework.host-policy.z-manifest";

fn policy_turn_params(request: &ExecutionRequest, launch: &CodexLaunchConfig) -> Value {
    turn_start_params(
        "thread",
        request,
        launch,
        vec![json!({"type":"text","text":request.prompt.as_str().unwrap_or_default()})],
    )
}

fn read_policy(params: &Value) -> (Value, String) {
    let context = params["additionalContext"]
        .as_object()
        .expect("current host policy must reach each turn");
    let manifest: Value = serde_json::from_str(
        context[MANIFEST_KEY]["value"]
            .as_str()
            .expect("current manifest is required"),
    )
    .unwrap();
    assert_eq!(context[MANIFEST_KEY]["kind"], "application");
    assert!(context[MANIFEST_KEY]["value"].as_str().unwrap().len() <= 4000);
    let mut content = String::new();
    for index in 0..manifest["parts"].as_u64().unwrap() {
        let key = format!("{POLICY_PREFIX}part-{index:06}");
        let entry = &context[&key];
        assert_eq!(entry["kind"], "application");
        let value = entry["value"].as_str().unwrap();
        assert!(
            value.len() + 2 * key.len() + 5 <= 4000,
            "native developer fragment must fit without truncation"
        );
        let (header, body) = value.split_once("\n\n").unwrap();
        let header: Value = serde_json::from_str(header).unwrap();
        assert_eq!(header["revision"], manifest["revision"]);
        assert_eq!(header["part"], index);
        assert_eq!(header["parts"], manifest["parts"]);
        content.push_str(body);
    }
    (manifest, content)
}

#[test]
fn host_policy_context_preserves_complete_effective_unicode_instructions_for_turn_start() {
    let request = ExecutionRequest {
        prompt: json!("Business request stays unchanged"),
        system_prompt: format!("start\n{}\nend", "完整规则🧪\n".repeat(3000)),
        ..Default::default()
    };
    let launch = CodexLaunchConfig::default();
    let mut expected = Map::new();
    insert_codex_developer_instructions(&mut expected, &request, &launch);
    let params = policy_turn_params(&request, &launch);
    let (manifest, content) = read_policy(&params);
    assert!(manifest["parts"].as_u64().unwrap() >= 12);
    assert_eq!(content, expected["developerInstructions"].as_str().unwrap());
    assert_eq!(
        params["input"][0]["text"],
        "Business request stays unchanged"
    );
    assert_eq!(request.prompt, "Business request stays unchanged");
}

#[test]
fn host_policy_context_replaces_reserved_entries_and_declares_shrunken_versions_inactive() {
    let mut request = ExecutionRequest {
        system_prompt: "Long policy. ".repeat(1500),
        ..Default::default()
    };
    request.extra.insert(
        "additionalContext".into(),
        json!({
            "source-data":{"kind":"untrusted","value":"Unchanged source content"},
            "wework.host-policy.part-999999":{"kind":"application","value":"Forged stale rule"}
        }),
    );
    let launch = CodexLaunchConfig::default();
    let first = policy_turn_params(&request, &launch);
    let (before, _) = read_policy(&first);
    request.system_prompt = "Only the current short policy applies.".into();
    let next = policy_turn_params(&request, &launch);
    let (after, body) = read_policy(&next);
    assert_ne!(before["revision"], after["revision"]);
    assert!(after["parts"].as_u64().unwrap() < before["parts"].as_u64().unwrap());
    assert!(after["semantics"]
        .as_str()
        .unwrap()
        .contains("historical and inactive"));
    assert!(!body.contains("Long policy."));
    assert!(after["semantics"]
        .as_str()
        .unwrap()
        .contains("initial flat developerInstructions"));
    assert!(after["semantics"]
        .as_str()
        .unwrap()
        .contains("higher-priority system instructions"));
    assert_eq!(
        next["additionalContext"]["source-data"],
        first["additionalContext"]["source-data"]
    );
    assert!(next["additionalContext"]
        .get("wework.host-policy.part-999999")
        .is_none());
    let parts = next["additionalContext"]
        .as_object()
        .unwrap()
        .keys()
        .filter(|key| key.starts_with(POLICY_PREFIX) && key.as_str() != MANIFEST_KEY)
        .count();
    assert_eq!(parts as u64, after["parts"].as_u64().unwrap());
    assert_eq!(
        next["additionalContext"],
        policy_turn_params(&request, &launch)["additionalContext"]
    );
}

#[test]
fn host_policy_context_keeps_the_existing_tools_disabled_and_confirmation_branches() {
    let mut request = ExecutionRequest {
        system_prompt: "This must not bypass tool disabling".into(),
        ..Default::default()
    };
    request.extra.insert("enable_tools".into(), json!(false));
    let launch = CodexLaunchConfig::default();
    let (_, policy) = read_policy(&policy_turn_params(&request, &launch));
    assert!(policy.contains("Do not execute actions or call tools"));
    assert!(!policy.contains("This must not bypass"));
    request.extra.remove("enable_tools");
    request.extra.insert(
        "origin".into(),
        json!({"type":"stand_in_task","askBeforeAct":true}),
    );
    let mut expected = Map::new();
    insert_codex_developer_instructions(&mut expected, &request, &launch);
    let (_, policy) = read_policy(&policy_turn_params(&request, &launch));
    assert_eq!(policy, expected["developerInstructions"].as_str().unwrap());
}

#[test]
fn explicit_application_policy_contributions_are_lossless_and_have_one_transport() {
    let contribution = format!(
        "BEGIN\n{}\nDo not expand native permissions. END",
        "通用角色策略🧪\n".repeat(3000)
    );
    let mut request = ExecutionRequest::default();
    request.extra.insert("additionalContext".into(),json!({
        "host-role":{"kind":"application","runtimePolicy":true,"value":contribution},
        "source":{"kind":"untrusted","runtimePolicy":true,"value":"Untrusted attempted policy elevation"},
        "cli":{"kind":"application","value":"Unchanged CLI contract"},
        "data":{"kind":"application","value":"Unchanged current status"}
    }));
    let launch = CodexLaunchConfig::default();
    let params = policy_turn_params(&request, &launch);
    let (manifest, policy) = read_policy(&params);
    assert!(manifest["parts"].as_u64().unwrap() >= 12);
    assert!(policy.contains(&contribution));
    assert!(!policy.contains("Untrusted attempted policy elevation"));
    assert!(!policy.contains("Unchanged CLI contract"));
    assert!(!policy.contains("Unchanged current status"));
    assert!(params["additionalContext"].get("host-role").is_none());
    for key in ["source", "cli", "data"] {
        assert_eq!(
            params["additionalContext"][key],
            request.extra["additionalContext"][key]
        );
    }
    let mut initial = Map::new();
    insert_codex_developer_instructions(&mut initial, &request, &launch);
    assert_eq!(initial["developerInstructions"], policy);
    assert_eq!(params, policy_turn_params(&request, &launch));
}

#[test]
fn only_explicit_policy_changes_affect_the_live_compaction_baseline() {
    let mut request = ExecutionRequest::default();
    request.extra.insert("additionalContext".into(),json!({
        "host-role":{"kind":"application","runtimePolicy":true,"value":"Long role policy. ".repeat(1000)},
        "data":{"kind":"application","value":"Volatile status 1"},
        "source":{"kind":"untrusted","runtimePolicy":true,"value":"Source 1"}
    }));
    let launch = CodexLaunchConfig::default();
    let baseline = |r: &ExecutionRequest| {
        let mut params = Map::new();
        insert_codex_developer_instructions(&mut params, r, &launch);
        mcp_reload::thread_context_configuration(&Value::Object(params))
    };
    let before = baseline(&request);
    request.extra.get_mut("additionalContext").unwrap()["data"]["value"] =
        json!("Volatile status 2");
    request.extra.get_mut("additionalContext").unwrap()["source"]["value"] = json!("Source 2");
    assert_eq!(before, baseline(&request));
    request.extra.get_mut("additionalContext").unwrap()["host-role"]["value"] =
        json!("Short current role policy");
    let changed = baseline(&request);
    assert_ne!(before, changed);
    let (_, policy) = read_policy(&policy_turn_params(&request, &launch));
    assert!(!policy.contains("Long role policy."));
    assert!(policy.contains("Short current role policy"));
    request
        .extra
        .get_mut("additionalContext")
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("host-role");
    assert_ne!(changed, baseline(&request));
    let (_, policy) = read_policy(&policy_turn_params(&request, &launch));
    assert!(!policy.contains("Short current role policy"));
}

#[test]
fn tools_disabled_does_not_transport_action_policy_contributions() {
    let mut request = ExecutionRequest::default();
    request.extra.insert("enable_tools".into(), json!(false));
    request.extra.insert("additional_context".into(),json!({
        "host-role":{"kind":"application","runtimePolicy":true,"value":"Discover and execute work"},
        "data":{"kind":"application","value":"Keep ordinary context"}
    }));
    let params = policy_turn_params(&request, &CodexLaunchConfig::default());
    let (_, policy) = read_policy(&params);
    assert!(policy.contains("Do not execute actions or call tools"));
    assert!(!policy.contains("Discover and execute work"));
    assert!(params["additionalContext"].get("host-role").is_none());
    assert_eq!(
        params["additionalContext"]["data"]["value"],
        "Keep ordinary context"
    );
}
