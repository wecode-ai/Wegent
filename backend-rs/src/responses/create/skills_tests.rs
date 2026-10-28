// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for `_build_skill_data` and the skill resolution reads.
#![cfg(test)]

use super::*;
use serde_json::json;

fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn skill_reads_match_the_recorded_statements() {
    let attached = normalize(&attached_skill_statement());
    assert!(attached.contains(
        "WHERE kinds.id = ? AND kinds.kind = 'Skill' AND kinds.name = ? \
         AND kinds.is_active = true LIMIT 1"
    ));
    let public = normalize(&public_skill_statement());
    assert!(public.contains(
        "WHERE kinds.user_id = 0 AND kinds.kind = 'Skill' AND kinds.name = ? \
         AND kinds.is_active = true LIMIT 1"
    ));
}

/// `_get_bot_skills` re-resolves each binding ref through
/// `find_skill_by_ref`'s explicit-id branch (`id` + `name`). The group-binding
/// recording reads each Skill once by id while building the ref and once by
/// id+name here; a user-default binding additionally reads it once per binding
/// in `list_user_default_bindings` (see `list_user_default_skill_refs`).
#[tokio::test]
async fn binding_ref_lookup_uses_the_attached_skill_statement() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let _ = resolve_binding_ref_skill(&mysql, Some(1_757_975), "lbs-concert-json2table-star-uid")
        .await
        .expect("read");
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert!(queries[0].sql.contains(
        "WHERE kinds.id = ? AND kinds.kind = 'Skill' AND kinds.name = ? \
         AND kinds.is_active = true LIMIT 1"
    ));
    assert_eq!(queries[0].args, 2);
    assert_eq!(queries[0].first_integer, Some(1_757_975));
}

#[test]
fn ref_meta_derives_from_the_kind_row() {
    let row = SkillKindRow {
        kinds_id: 200_318,
        kinds_user_id: 0,
        kinds_kind: "Skill".to_string(),
        kinds_name: "subscription-manager".to_string(),
        kinds_namespace: "default".to_string(),
        kinds_json: Json(json!({
            "status": {"fileHash": "d9f8d69053873ea444f69e871cf9ce542d8315869b0f1b0bfe3aa00c26c50caa"}
        })),
        kinds_is_active: 1,
        kinds_created_at: None,
        kinds_updated_at: None,
    };
    assert_eq!(
        SkillRefMeta::from_kind(&row),
        SkillRefMeta {
            skill_id: 200_318,
            namespace: "default".to_string(),
            is_public: true,
            content_hash: Some(
                "sha256:d9f8d69053873ea444f69e871cf9ce542d8315869b0f1b0bfe3aa00c26c50caa"
                    .to_string()
            ),
        }
    );
}

/// `_get_bot_skills` stores `build_skill_ref_meta(skill)`
/// (`request_builder.py:1700-1701`): the resolved Skill row supplies the
/// version. A Ghost-stored ref that still carries the previous
/// `content_hash` must not override the live `status.fileHash`.
#[test]
fn ghost_skill_ref_content_hash_comes_from_the_live_skill_row() {
    let live = SkillKindRow {
        kinds_id: 42,
        kinds_user_id: 3097,
        kinds_kind: "Skill".to_string(),
        kinds_name: "radar-celebrity-review".to_string(),
        kinds_namespace: "default".to_string(),
        kinds_json: Json(json!({
            "status": {"fileHash": "live-file-hash"}
        })),
        kinds_is_active: 1,
        kinds_created_at: None,
        kinds_updated_at: None,
    };
    // The Ghost's stored ref: same identity, stale hash.
    let ghost_stored = json!({
        "skill_id": 42,
        "namespace": "default",
        "is_public": false,
        "content_hash": "sha256:stale-file-hash",
    });
    let meta = ghost_skill_ref_meta(&live);
    assert_eq!(meta["content_hash"], json!("sha256:live-file-hash"));
    assert_ne!(meta["content_hash"], ghost_stored["content_hash"]);
    assert_eq!(meta["skill_id"], ghost_stored["skill_id"]);
}

/// `_build_skill_data` keeps a present-or-absent text field as JSON
/// `null` and omits `config`/`runtime`/`mcpServers` the source's
/// truthiness check rejects. The chat-shell body compares values exactly,
/// so `""` or `"mcpServers": null` would never match the recorded body.
#[test]
fn skill_data_keeps_present_nulls_and_omits_absent_optional_keys() {
    let skill = SkillKindRow {
        kinds_id: 1_757_975,
        kinds_user_id: 655,
        kinds_kind: "Skill".to_string(),
        kinds_name: "lbs-concert-json2table-star-uid".to_string(),
        kinds_namespace: "lbs-group1".to_string(),
        kinds_json: Json(json!({
            "spec": {"description": "convert", "prompt": "# prompt"},
        })),
        kinds_is_active: 1,
        kinds_created_at: None,
        kinds_updated_at: None,
    };
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    let object = data.as_object().expect("object");
    assert_eq!(object["displayName"], Value::Null);
    assert!(!object.contains_key("mcpServers"));
    assert!(!object.contains_key("config"));
    assert!(!object.contains_key("runtime"));
    assert_eq!(
        object.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "name",
            "description",
            "prompt",
            "displayName",
            "skill_id",
            "skill_user_id"
        ]
    );
}

/// A truthy `mcpServers` descriptor is copied verbatim (including the
/// unsubstituted `${{...}}` placeholders the source keeps), while a falsy
/// `config` object is omitted.
#[test]
fn skill_data_copies_truthy_optional_keys() {
    let skill = SkillKindRow {
        kinds_id: 200_318,
        kinds_user_id: 0,
        kinds_kind: "Skill".to_string(),
        kinds_name: "subscription-manager".to_string(),
        kinds_namespace: "default".to_string(),
        kinds_json: Json(json!({
            "spec": {
                "description": "d",
                "prompt": "p",
                "displayName": "订阅任务管理",
                "mcpServers": {
                    "wegent-subscription": {"url": "${{backend_url}}/mcp/subscription/sse"}
                },
                "config": {},
            },
        })),
        kinds_is_active: 1,
        kinds_created_at: None,
        kinds_updated_at: None,
    };
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    let object = data.as_object().expect("object");
    assert_eq!(object["displayName"], json!("订阅任务管理"));
    assert_eq!(
        object["mcpServers"],
        json!({"wegent-subscription": {"url": "${{backend_url}}/mcp/subscription/sse"}})
    );
    assert!(!object.contains_key("config"));
}

fn skill_row(kinds_id: i64, kinds_user_id: i64, spec: Value) -> SkillKindRow {
    SkillKindRow {
        kinds_id,
        kinds_user_id,
        kinds_kind: "Skill".to_string(),
        kinds_name: "mermaid-diagram".to_string(),
        kinds_namespace: "default".to_string(),
        kinds_json: Json(json!({"spec": spec})),
        kinds_is_active: 1,
        kinds_created_at: None,
        kinds_updated_at: None,
    }
}

/// `request_builder.py:2042-2054`: a provider emits the `module` / `class`
/// pair, and a public skill (`user_id == 0`) additionally carries the
/// internal binary download URL.
#[test]
fn a_public_skill_with_a_provider_emits_the_binary_download_url() {
    let skill = skill_row(
        100_419,
        0,
        json!({
            "description": "d",
            "prompt": "p",
            "provider": {"module": "provider", "class": "MermaidToolProvider"},
        }),
    );
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    assert_eq!(
        data["provider"],
        json!({"module": "provider", "class": "MermaidToolProvider"})
    );
    let url = data["binary_download_url"].as_str().expect("url");
    assert!(url.ends_with("/api/internal/skills/100419/binary"), "{url}");
    assert_eq!(
        url,
        binary_download_url(
            &crate::responses::create::bot_config::backend_url(),
            100_419
        )
    );
}

/// The download URL is a security restriction for public skills: a
/// provider-bearing non-public skill emits only `provider`.
#[test]
fn a_private_skill_with_a_provider_has_no_binary_download_url() {
    let skill = skill_row(
        1_757_975,
        655,
        json!({
            "description": "d",
            "prompt": "p",
            "provider": {"module": "provider", "class": "ToolProvider"},
        }),
    );
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    assert_eq!(
        data["provider"],
        json!({"module": "provider", "class": "ToolProvider"})
    );
    assert!(
        !data
            .as_object()
            .expect("object")
            .contains_key("binary_download_url")
    );
}

/// Without `spec.provider` neither field is emitted, even for a public
/// skill.
#[test]
fn a_skill_without_a_provider_emits_neither_field() {
    let skill = skill_row(200_318, 0, json!({"description": "d", "prompt": "p"}));
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    let object = data.as_object().expect("object");
    assert!(!object.contains_key("provider"));
    assert!(!object.contains_key("binary_download_url"));
}

/// The loader module defaults to `provider` when the spec omits it, and
/// `module`/`class` are the only provider keys.
#[test]
fn a_provider_without_a_module_uses_the_pydantic_default() {
    let skill = skill_row(
        110_603,
        0,
        json!({
            "description": "d",
            "prompt": "p",
            "provider": {"class": "SandboxToolProvider"},
        }),
    );
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    assert_eq!(
        data["provider"],
        json!({"module": "provider", "class": "SandboxToolProvider"})
    );
}

/// `spec.tools` is dumped entry by entry: `config` survives only when it
/// is not `None`, and keys outside the declaration model are dropped.
#[test]
fn skill_tools_drop_null_config_and_unknown_keys() {
    let skill = skill_row(
        100_419,
        0,
        json!({
            "description": "d",
            "prompt": "p",
            "tools": [
                {"name": "render_mermaid", "provider": "mermaid", "config": {"timeout": 30}},
                {"name": "read_mermaid_reference", "provider": "mermaid", "config": null, "extra": "x"},
            ],
        }),
    );
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    assert_eq!(
        data["tools"],
        json!([
            {"name": "render_mermaid", "provider": "mermaid", "config": {"timeout": 30}},
            {"name": "read_mermaid_reference", "provider": "mermaid"},
        ])
    );
}

/// An empty `tools` list is falsy in the source, so the key is omitted.
#[test]
fn an_empty_tools_list_is_omitted() {
    let skill = skill_row(100_419, 0, json!({"description": "d", "tools": []}));
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    assert!(!data.as_object().expect("object").contains_key("tools"));
}

/// `settings.BACKEND_INTERNAL_URL.rstrip("/")` + the internal path. The
/// configured base already ends in `/api`, so the recorded value repeats it.
#[test]
fn binary_download_url_strips_trailing_slashes() {
    assert_eq!(
        binary_download_url("https://internal.example/api", 100_419),
        "https://internal.example/api/api/internal/skills/100419/binary"
    );
    assert_eq!(
        binary_download_url("https://internal.example/api/", 100_419),
        "https://internal.example/api/api/internal/skills/100419/binary"
    );
}

#[test]
fn binding_predicates_and_extractors_follow_the_source() {
    let binding = json!({
        "spec": {
            "targetType": "user",
            "targetId": "user-5831",
            "skillRef": {"skillId": 128913, "name": "wegent-knowledge"},
            "forcePreload": true,
        }
    });
    assert!(is_user_default_binding(&binding, "user-5831"));
    assert!(!is_user_default_binding(&binding, "other"));
    assert_eq!(extract_skill_id(&binding), Some(128_913));
    assert!(extract_force_preload(&binding));

    let group = json!({"spec": {"targetType": "group", "targetId": "ns-a"}});
    assert!(is_group_binding(&group, "ns-a"));
    assert_eq!(extract_skill_id(&group), None);
    assert!(!extract_force_preload(&group));
}

#[test]
fn subscription_manager_injection_skips_subscription_tasks() {
    assert_eq!(inject_subscription_manager_skill(true), Vec::<Value>::new());
    assert_eq!(
        inject_subscription_manager_skill(false),
        vec![json!({
            "name": "subscription-manager",
            "namespace": "default",
            "is_public": true,
        })]
    );
}

#[test]
fn conditional_provider_skills_preload_every_matched_service() {
    let mut references = Vec::new();
    inject_conditional_provider_skills(
        "帮我把这份 钉钉 文档整理成表格，按 记录 汇总",
        &mut references,
    );
    assert_eq!(
        references,
        vec![
            json!({"name": "dingtalk-docs", "namespace": "default", "is_public": true}),
            json!({"name": "dingtalk-ai-table", "namespace": "default", "is_public": true}),
        ]
    );
}

#[test]
fn conditional_provider_skills_ignore_an_unmatched_prompt() {
    let mut references = Vec::new();
    inject_conditional_provider_skills("写一首关于春天的诗", &mut references);
    assert!(!references.iter().any(|reference| {
        reference["name"]
            .as_str()
            .is_some_and(|name| name.starts_with("dingtalk-"))
    }));

    let mut empty = Vec::new();
    inject_conditional_provider_skills("   ", &mut empty);
    assert!(empty.is_empty());
}

#[test]
fn conditional_provider_skills_normalize_spacing_and_case() {
    // `_normalize_provider_keyword_text` case-folds and drops whitespace, so a
    // keyword matches across the spaces and case the user typed.
    let mut references = Vec::new();
    inject_conditional_provider_skills(
        "upload this to DingTalk  AI  Table please",
        &mut references,
    );
    assert_eq!(
        references,
        vec![json!({"name": "dingtalk-ai-table", "namespace": "default", "is_public": true})]
    );
}

#[test]
fn conditional_provider_skills_keep_an_existing_reference_once() {
    let mut references = vec![json!({
        "name": "dingtalk-docs",
        "namespace": "default",
        "is_public": true,
    })];
    inject_conditional_provider_skills("钉钉 文档", &mut references);
    assert_eq!(
        references,
        vec![json!({"name": "dingtalk-docs", "namespace": "default", "is_public": true})]
    );
}

#[test]
fn conditional_provider_skills_preload_all_services_without_a_service_keyword() {
    // A provider keyword with no matching service keyword still preloads the
    // provider's declared services (`matched_services = provider.services`).
    let mut references = Vec::new();
    inject_conditional_provider_skills("dingtalk", &mut references);
    assert_eq!(
        references
            .iter()
            .filter_map(|reference| reference["name"].as_str())
            .collect::<Vec<_>>(),
        [
            "dingtalk-docs",
            "dingtalk-table",
            "dingtalk-ai-table",
            "dingtalk-wikispace"
        ]
    );
}

#[test]
fn binding_exceptions_filter_by_mode_agent_and_project() {
    let context = SkillBindingContext {
        mode: "chat",
        agent_id: 302_292,
        project_id: Some(2571),
        group_namespace: Some("lbs-group1"),
    };
    let binding = |exceptions: Value| json!({"spec": {"exceptions": exceptions}});
    assert!(is_excluded_by_context(
        &binding(json!([{"type": "mode", "value": "chat"}])),
        &context
    ));
    assert!(is_excluded_by_context(
        &binding(json!([{"type": "agent", "value": "302292"}])),
        &context
    ));
    assert!(is_excluded_by_context(
        &binding(json!([{"type": "project", "value": " 2571 "}])),
        &context
    ));
    assert!(!is_excluded_by_context(
        &binding(json!([{"type": "mode", "value": "video"}])),
        &context
    ));
    assert!(!is_excluded_by_context(&binding(json!([])), &context));
}

/// The recorded statement carries `kinds.user_id = 6582`, an integer
/// literal, so the read binds an integer (`kinds.user_id = ?`). A
/// stringified id never matched the recorded exchange.
#[tokio::test]
async fn user_default_binding_read_binds_the_user_id_as_an_integer() {
    let mysql = crate::sql_test_support::KindQueryCapture::writing();
    let context = SkillBindingContext {
        mode: "chat",
        agent_id: 302_292,
        project_id: None,
        group_namespace: None,
    };
    let refs = list_user_default_skill_refs(&mysql, 6582, "user:6582", &context, None)
        .await
        .expect("read");
    assert!(refs.is_empty());
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert!(queries[0].sql.contains("kinds.user_id = ?"));
    assert!(
        queries[0]
            .sql
            .contains("WHERE kinds.user_id = ? AND kinds.kind = 'SkillBinding'")
    );
    assert_eq!(queries[0].first_integer, Some(6582));
}

fn named_skill_row(name: &str, kinds_user_id: i64, namespace: &str, spec: Value) -> SkillKindRow {
    SkillKindRow {
        kinds_id: 187_624,
        kinds_user_id,
        kinds_kind: "Skill".to_string(),
        kinds_name: name.to_string(),
        kinds_namespace: namespace.to_string(),
        kinds_json: Json(json!({"spec": spec})),
        kinds_is_active: 1,
        kinds_created_at: None,
        kinds_updated_at: None,
    }
}

/// `_build_skill_data`'s user-managed provider branch
/// (`request_builder.py:2004-2035`): a public `default`-namespace Skill whose
/// name is registered by a user-mode provider removes its `mcpServers` and
/// replaces `prompt` with the configuration guidance when the request user has
/// not configured that service.
#[test]
fn an_unconfigured_user_managed_runtime_skill_requires_configuration() {
    let skill = named_skill_row(
        "dingtalk-docs",
        0,
        "default",
        json!({
            "description": "d",
            "prompt": "# skill prompt",
            "mcpServers": {"dingtalk_docs": {"url": "https://mcp-gw.dingtalk.com/server/abc"}},
        }),
    );
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    let object = data.as_object().expect("object");
    assert!(!object.contains_key("mcpServers"));
    assert_eq!(object["configuration_required"], json!(true));
    let prompt = object["prompt"].as_str().expect("prompt");
    assert_eq!(prompt.chars().count(), 836);
    assert!(prompt.starts_with("## Configuration Required\n"));
    assert!(prompt.contains("wegent://modal/mcp-provider-config?provider=dingtalk&service=docs"));
}

/// When the user has an enabled service with a usable URL the branch leaves
/// the stored `mcpServers` and `prompt` untouched and emits no
/// `configuration_required`.
#[test]
fn a_configured_user_managed_runtime_skill_keeps_its_servers() {
    let skill = named_skill_row(
        "dingtalk-table",
        0,
        "default",
        json!({
            "description": "d",
            "prompt": "# skill prompt",
            "mcpServers": {"dingtalk_table": {"url": "https://mcp-gw.dingtalk.com/server/abc"}},
        }),
    );
    let preferences = json!({
        "mcps": {
            "dingtalk": {
                "services": {
                    "table": {
                        "enabled": true,
                        "credentials": {"url": "https://mcp-gw.dingtalk.com/server/abc"},
                    }
                }
            }
        }
    })
    .to_string();
    let data = build_skill_data(&skill, Some(&preferences)).expect("skill data");
    let object = data.as_object().expect("object");
    assert!(!object.contains_key("configuration_required"));
    assert_eq!(
        object["mcpServers"],
        json!({"dingtalk_table": {"url": "https://mcp-gw.dingtalk.com/server/abc"}})
    );
    assert_eq!(object["prompt"], json!("# skill prompt"));
}

/// The branch is limited to public Skills in the `default` namespace, and to
/// names the registry knows.
#[test]
fn only_public_default_namespace_registered_skills_are_reconfigured() {
    let spec = json!({
        "description": "d",
        "prompt": "# skill prompt",
        "mcpServers": {"dingtalk_docs": {"url": "https://mcp-gw.dingtalk.com/server/abc"}},
    });
    for (name, user_id, namespace) in [
        ("dingtalk-docs", 0, "lbs-group1"),
        ("dingtalk-docs", 7, "default"),
        ("subscription-manager", 0, "default"),
    ] {
        let skill = named_skill_row(name, user_id, namespace, spec.clone());
        let data = build_skill_data(&skill, Some("")).expect("skill data");
        let object = data.as_object().expect("object");
        assert!(
            !object.contains_key("configuration_required"),
            "{name}/{namespace}"
        );
        assert!(object.contains_key("mcpServers"), "{name}/{namespace}");
        assert_eq!(object["prompt"], json!("# skill prompt"), "{name}");
    }
}

/// A registered `system`-mode provider resolves by skill name but never takes
/// the user-configuration branch (`configuration_mode == "user"` gate).
#[test]
fn a_system_mode_provider_skips_the_user_configuration_branch() {
    static SERVICES: &[crate::mcp_provider_registry::McpProviderServiceDefinition] =
        &[crate::mcp_provider_registry::McpProviderServiceDefinition {
            service_id: "knowledge",
            server_name: "skills-test-system-server",
            detail_url: "",
            skill_name: "skills-test-system-skill",
            display_name: "System",
            message_keywords: &[],
            oauth_supported: false,
        }];
    crate::mcp_provider_registry::register_mcp_provider(
        crate::mcp_provider_registry::McpProviderDefinition {
            provider_id: "skills-test-system-provider",
            display_name: "System",
            configuration_mode: "system",
            message_keywords: &[],
            services: SERVICES,
        },
    );
    let skill = named_skill_row(
        "skills-test-system-skill",
        0,
        "default",
        json!({
            "description": "d",
            "prompt": "# skill prompt",
            "mcpServers": {"server": {"url": "https://example.invalid/mcp"}},
        }),
    );
    let data = build_skill_data(&skill, Some("")).expect("skill data");
    let object = data.as_object().expect("object");
    assert!(!object.contains_key("configuration_required"));
    assert!(object.contains_key("mcpServers"));
}

/// The subscription, managed-project, code-wiki and pipeline builders load
/// the request `users.preferences` row and now pass `Some(&user.preferences)`
/// to `_build_skill_data`. For a configured user-managed provider service that
/// value keeps the Skill's stored `mcpServers` and adds no
/// `configuration_required`; the previous `None` dropped `mcpServers` and
/// rendered the configuration guidance instead.
#[test]
fn loaded_builder_preferences_keep_configured_runtime_servers() {
    let skill = named_skill_row(
        "dingtalk-table",
        0,
        "default",
        json!({
            "description": "d",
            "prompt": "# skill prompt",
            "mcpServers": {"dingtalk_table": {"url": "https://mcp-gw.dingtalk.com/server/abc"}},
        }),
    );
    let preferences = json!({
        "mcps": {
            "dingtalk": {
                "services": {
                    "table": {
                        "enabled": true,
                        "credentials": {"url": "https://mcp-gw.dingtalk.com/server/abc"},
                    }
                }
            }
        }
    })
    .to_string();
    // The value each builder supplies after loading `users.preferences`.
    let loaded = Some(preferences.as_str());
    let data = build_skill_data(&skill, loaded).expect("skill data");
    let object = data.as_object().expect("object");
    assert_eq!(
        object["mcpServers"],
        json!({"dingtalk_table": {"url": "https://mcp-gw.dingtalk.com/server/abc"}})
    );
    assert!(!object.contains_key("configuration_required"));
    assert_eq!(object["prompt"], json!("# skill prompt"));

    // The reworked `None` was observably different and is not a fidelity
    // option for these builders.
    let without_document = build_skill_data(&skill, None).expect("skill data");
    let object = without_document.as_object().expect("object");
    assert!(!object.contains_key("mcpServers"));
    assert_eq!(object["configuration_required"], json!(true));
}

/// A stub `ensure_access_token_sync`: it returns the synthetic token and
/// records every provider/service lookup, so the header tests can assert the
/// token really came from the service call.
struct StubTokens {
    token: String,
    calls: std::sync::Mutex<Vec<(String, String)>>,
}

impl StubTokens {
    fn new(token: &str) -> Self {
        Self {
            token: token.to_string(),
            calls: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<(String, String)> {
        self.calls.lock().expect("stub calls").clone()
    }
}

#[async_trait::async_trait]
impl UserMcpAccessTokens for StubTokens {
    async fn ensure_access_token(
        &self,
        _preferences: &str,
        provider_id: &str,
        service_id: &str,
    ) -> Result<String, FastApiError> {
        self.calls
            .lock()
            .expect("stub calls")
            .push((provider_id.to_string(), service_id.to_string()));
        Ok(self.token.clone())
    }
}

/// The stored preferences of an enabled `dingtalk`/`table` service.
fn configured_preferences(auth_mode: &str, url: &str) -> String {
    json!({
        "mcps": {
            "dingtalk": {
                "services": {
                    "table": {
                        "enabled": true,
                        "auth_mode": auth_mode,
                        "credentials": {"url": url},
                    }
                }
            }
        }
    })
    .to_string()
}

/// `_apply_user_mcp_oauth_header`: an OAuth-mode configured server receives
/// `headers.Authorization = "Bearer <access_token>"` from the token service,
/// and the stored URL is left untouched.
#[tokio::test]
async fn configured_oauth_runtime_skill_receives_the_access_token_header() {
    let skill = named_skill_row(
        "dingtalk-table",
        0,
        "default",
        json!({
            "description": "d",
            "prompt": "# skill prompt",
            "mcpServers": {"dingtalk_table": {
                "url": "https://mcp-gw.dingtalk.com/server/abc",
                "type": "streamable-http",
            }},
        }),
    );
    let preferences = configured_preferences("oauth", "https://mcp-gw.dingtalk.com/server/abc");
    let tokens = StubTokens::new("synthetic-token");

    let data = build_skill_data_with_oauth(&skill, Some(&preferences), &tokens)
        .await
        .expect("skill data");

    assert_eq!(
        data["mcpServers"]["dingtalk_table"],
        json!({
            "url": "https://mcp-gw.dingtalk.com/server/abc",
            "type": "streamable-http",
            "headers": {"Authorization": "Bearer synthetic-token"},
        })
    );
    assert_eq!(
        tokens.calls(),
        vec![("dingtalk".to_string(), "table".to_string())]
    );
}

/// A configured server whose auth mode is `url` carries its own credential, so
/// no token is requested and no header is added.
#[tokio::test]
async fn url_mode_runtime_skill_keeps_its_servers_unchanged() {
    let skill = named_skill_row(
        "dingtalk-table",
        0,
        "default",
        json!({
            "description": "d",
            "prompt": "# skill prompt",
            "mcpServers": {"dingtalk_table": {
                "url": "https://mcp-gw.dingtalk.com/server/abc",
                "type": "streamable-http",
            }},
        }),
    );
    let preferences = configured_preferences("url", "https://mcp-gw.dingtalk.com/server/abc");
    let tokens = StubTokens::new("synthetic-token");

    let data = build_skill_data_with_oauth(&skill, Some(&preferences), &tokens)
        .await
        .expect("skill data");

    assert_eq!(
        data["mcpServers"]["dingtalk_table"],
        json!({
            "url": "https://mcp-gw.dingtalk.com/server/abc",
            "type": "streamable-http",
        })
    );
    assert!(tokens.calls().is_empty());
}

/// The source refuses to send an OAuth token over an insecure transport, so a
/// non-loopback `http` URL gets no header and no token lookup.
#[tokio::test]
async fn insecure_oauth_runtime_skill_receives_no_header() {
    let skill = named_skill_row(
        "dingtalk-table",
        0,
        "default",
        json!({
            "description": "d",
            "prompt": "# skill prompt",
            "mcpServers": {"dingtalk_table": {
                "url": "http://mcp-gw.dingtalk.com/server/abc",
                "type": "streamable-http",
            }},
        }),
    );
    let preferences = configured_preferences("oauth", "http://mcp-gw.dingtalk.com/server/abc");
    let tokens = StubTokens::new("synthetic-token");

    let data = build_skill_data_with_oauth(&skill, Some(&preferences), &tokens)
        .await
        .expect("skill data");

    assert_eq!(
        data["mcpServers"]["dingtalk_table"],
        json!({
            "url": "http://mcp-gw.dingtalk.com/server/abc",
            "type": "streamable-http",
        })
    );
    assert!(tokens.calls().is_empty());
}

/// Older public Skills used the hyphenated provider server name.
#[tokio::test]
async fn legacy_hyphenated_server_name_receives_the_header() {
    let skill = named_skill_row(
        "dingtalk-table",
        0,
        "default",
        json!({
            "description": "d",
            "prompt": "# skill prompt",
            "mcpServers": {"dingtalk-table": {
                "url": "https://mcp-gw.dingtalk.com/server/abc",
            }},
        }),
    );
    let preferences = configured_preferences("oauth", "https://mcp-gw.dingtalk.com/server/abc");
    let tokens = StubTokens::new("synthetic-token");

    let data = build_skill_data_with_oauth(&skill, Some(&preferences), &tokens)
        .await
        .expect("skill data");

    assert_eq!(
        data["mcpServers"]["dingtalk-table"]["headers"],
        json!({"Authorization": "Bearer synthetic-token"})
    );
    assert_eq!(tokens.calls().len(), 1);
}

/// An unconfigured user-managed provider service renders the configuration
/// guidance and never asks for a token.
#[tokio::test]
async fn unconfigured_runtime_skill_requests_no_token() {
    let skill = named_skill_row(
        "dingtalk-table",
        0,
        "default",
        json!({
            "description": "d",
            "prompt": "# skill prompt",
            "mcpServers": {"dingtalk_table": {
                "url": "https://mcp-gw.dingtalk.com/server/abc",
            }},
        }),
    );
    let tokens = StubTokens::new("synthetic-token");

    let data = build_skill_data_with_oauth(&skill, Some(""), &tokens)
        .await
        .expect("skill data");

    assert!(!data.as_object().expect("object").contains_key("mcpServers"));
    assert_eq!(data["configuration_required"], json!(true));
    assert!(tokens.calls().is_empty());
}
