use super::super::model_config::strip_and_encode_wegent_headers;
use super::*;
use serde_json::{Map, json};

#[test]
fn deployment_default_headers_resolve_to_the_recorded_values() {
    // Recorded `model_config.default_headers`: the frozen
    // `EXECUTOR_ENV.DEFAULT_HEADERS` template with `task_data.*` paths
    // resolved, empty identity headers dropped, and the non-ASCII team name
    // base64-encoded.
    use brz_mysql::Json;
    let team = KindRow {
        id: 302_292,
        user_id: 6582,
        kind: "Team".into(),
        name: "示例团队".into(),
        namespace: "sample-group".into(),
        json: Json(serde_json::json!({})),
        is_active: 1,
        created_at: None,
        updated_at: None,
    };
    let mut config = Map::new();
    config.insert("api_key".into(), json!("${DEPLOYMENT_USER_API_KEY}"));
    config.insert(
        "default_headers".into(),
        json!({
            "x-runtime-source": "agent",
            "x-runtime-user": "${task_data.user.name}",
            "x-runtime-action": "wegent",
            "x-runtime-executor": "chat",
            "x-runtime-wegent-agent-namespace": "${task_data.team.namespace}",
            "x-runtime-wegent-agent-name": "${task_data.team.name}",
            "x-runtime-session-id": "${task_data.task_id}",
        }),
    );
    process_model_config_placeholders(&mut config, 6582, "sample-service", &Value::Null, 42, &team);
    let headers = &config["default_headers"];
    assert_eq!(headers["x-runtime-source"], json!("agent"));
    assert_eq!(headers["x-runtime-user"], json!("sample-service"));
    assert_eq!(headers["x-runtime-action"], json!("wegent"));
    assert_eq!(headers["x-runtime-executor"], json!("chat"));
    assert_eq!(
        headers["x-runtime-wegent-agent-namespace"],
        json!("sample-group")
    );
    assert_eq!(
        headers["x-runtime-wegent-agent-name"],
        json!("b64:56S65L6L5Zui6Zif")
    );
    assert_eq!(headers["x-runtime-session-id"], json!("42"));
}

#[test]
fn the_bot_model_config_is_resolved_before_the_knowledge_acl() {
    // Source builds the bot config — `build_agent_config_for_bot` ->
    // `_resolve_model_for_bot` — right after skills and before the
    // knowledge resolution (`request_builder.py:392-422`). That second
    // caller-group resolution repeats the ERP profile reads
    // (`erp:no_profile:{user}`) before the knowledge ACL's membership
    // checks; resolving it afterwards puts those reads behind
    // `erp:membership` and breaks the recorded Redis lane. The create flow
    // has no row-capable MySQL fake, so pin the call order at the source
    // level.
    let source = include_str!("request.rs");
    let skills = source
        .find("let mut skills = get_bot_skills(")
        .expect("skills resolution");
    let bot_config = source
        .find("let built_agent_config = build_agent_config(")
        .expect("bot config entry");
    let knowledge = source
        .find("let knowledge = resolve_knowledge(")
        .expect("knowledge resolution");
    assert!(
        skills < bot_config && bot_config < knowledge,
        "create prep must resolve skills, then the bot model config, then knowledge"
    );
}

#[test]
fn base_prompt_wraps_the_own_prompt_and_member_prompt() {
    let chain = vec![GhostNode {
        namespace: "default".to_string(),
        spec: json!({"systemPrompt": "ghost"}),
    }];
    assert_eq!(
        base_system_prompt(&chain, None),
        "<base_prompt>\nghost\n</base_prompt>"
    );
    assert_eq!(
        base_system_prompt(&chain, Some("member")),
        "<base_prompt>\nghost\n\nmember\n</base_prompt>"
    );
    assert_eq!(base_system_prompt(&[], None), "");
}

#[test]
fn wegent_identity_headers_are_stripped_and_encoded() {
    let mut headers = Map::new();
    headers.insert("wegent-agent-name".into(), json!("示例智能体"));
    headers.insert("wegent-agent-namespace".into(), json!(""));
    headers.insert("x-runtime-source".into(), json!("agent"));
    let processed = strip_and_encode_wegent_headers(headers);
    // The empty wegent-agent-* header is dropped.
    assert!(processed.get("wegent-agent-namespace").is_none());
    assert_eq!(processed["x-runtime-source"], json!("agent"));
    // The non-ASCII identity value is base64-encoded with the b64: prefix.
    let encoded = processed["wegent-agent-name"].as_str().unwrap();
    assert!(encoded.starts_with("b64:"));
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&encoded[4..])
        .unwrap();
    assert_eq!(String::from_utf8(decoded).unwrap(), "示例智能体");
}
