// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for `GET /api/admin/public-bots`.

use super::*;
use crate::json_contract_tests::serialized;

#[derive(Debug, Serialize)]
struct RefIn {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    namespace: Option<String>,
}

#[derive(Debug, Default, Serialize)]
struct BotSpecIn {
    #[serde(rename = "ghostRef", skip_serializing_if = "Option::is_none")]
    ghost_ref: Option<RefIn>,
    #[serde(rename = "shellRef", skip_serializing_if = "Option::is_none")]
    shell_ref: Option<RefIn>,
    #[serde(rename = "modelRef", skip_serializing_if = "Option::is_none")]
    model_ref: Option<RefIn>,
    #[serde(rename = "secondaryModelRef", skip_serializing_if = "Option::is_none")]
    secondary_model_ref: Option<RefIn>,
}

#[derive(Debug, Default, Serialize)]
struct BotDocIn {
    spec: BotSpecIn,
}

#[derive(Debug, Serialize)]
struct MetaIn {
    #[serde(rename = "displayName")]
    display_name: String,
}

#[derive(Debug, Serialize)]
struct SkillRefIn {
    skill_id: i64,
    is_public: bool,
    namespace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
}

#[derive(Debug, Default, Serialize)]
struct GhostSpecIn {
    #[serde(rename = "systemPrompt", skip_serializing_if = "Option::is_none")]
    system_prompt: Option<Option<String>>,
    #[serde(rename = "mcpServers", skip_serializing_if = "Option::is_none")]
    mcp_servers: Option<Option<BTreeMap<String, u8>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skills: Option<Option<Vec<String>>>,
    #[serde(rename = "skill_refs", skip_serializing_if = "Option::is_none")]
    skill_refs: Option<Option<BTreeMap<String, SkillRefIn>>>,
    #[serde(rename = "preload_skills", skip_serializing_if = "Option::is_none")]
    preload_skills: Option<Option<Vec<String>>>,
    #[serde(rename = "preload_skill_refs", skip_serializing_if = "Option::is_none")]
    preload_skill_refs: Option<Option<BTreeMap<String, SkillRefIn>>>,
    #[serde(
        rename = "defaultKnowledgeBaseRefs",
        skip_serializing_if = "Option::is_none"
    )]
    default_knowledge_base_refs: Option<Option<Vec<u8>>>,
}

#[derive(Debug, Serialize)]
struct GhostDocIn {
    spec: GhostSpecIn,
}

#[derive(Debug, Default, Serialize)]
struct ModelSpecIn {
    #[serde(rename = "isCustomConfig", skip_serializing_if = "Option::is_none")]
    is_custom_config: Option<bool>,
    #[serde(rename = "modelConfig", skip_serializing_if = "Option::is_none")]
    model_config: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol: Option<String>,
}

#[derive(Debug, Serialize)]
struct ModelDocIn {
    spec: ModelSpecIn,
}

fn ref_in(name: &str) -> RefIn {
    RefIn {
        name: name.to_string(),
        namespace: Some("default".to_string()),
    }
}

fn kind_row<S: Serialize>(id: i64, name: &str, document: S) -> KindRow {
    KindRow {
        id,
        name: name.to_string(),
        namespace: "default".to_string(),
        json: Json(OpaqueJson::from_serializable(document)),
        is_active: 1,
        created_at: NaiveDateTime::parse_from_str("2026-06-04 08:31:48", "%Y-%m-%d %H:%M:%S")
            .unwrap(),
        updated_at: NaiveDateTime::parse_from_str("2026-09-24 03:54:53", "%Y-%m-%d %H:%M:%S")
            .unwrap(),
    }
}

fn bot_row(spec: BotSpecIn) -> KindRow {
    kind_row(251883, "wegent-skill-creator", BotDocIn { spec })
}

fn refs_of(bot: &KindRow) -> BotRefs {
    let document = bot.json.0.project::<BotDocument>().unwrap_or_default();
    let secondary = document.spec.secondary_model_ref.value.as_ref();
    BotRefs {
        ghost_name: reference_name(&document.spec.ghost_ref),
        shell_name: reference_name(&document.spec.shell_ref),
        model_name: reference_name(&document.spec.model_ref),
        secondary_model_name: secondary.and_then(|reference| reference.name.clone()),
        secondary_model_namespace: secondary.map(|reference| {
            reference
                .namespace
                .clone()
                .unwrap_or_else(default_namespace)
        }),
    }
}

fn json_of<T: Serialize>(value: &T) -> String {
    serialized(value).unwrap().to_string()
}

#[test]
fn count_and_page_queries_match_the_source_rendering() {
    let list = list_sql(0, 100);
    assert!(list.contains("kinds.kind = 'Bot'"), "{list}");
    assert!(list.contains("ORDER BY kinds.updated_at DESC"), "{list}");
    assert!(list.ends_with("LIMIT 0, 100"), "{list}");
    let count = count_sql();
    assert!(count.contains("SELECT count(*) AS count_1"), "{count}");
    assert!(count.ends_with("AS anon_1"), "{count}");
}

#[test]
fn lookup_queries_bind_name_and_namespace() {
    let ghost = ghost_sql();
    assert!(
        ghost.contains("kinds.kind = 'Ghost' AND kinds.name = ? AND kinds.namespace = ?"),
        "{ghost}"
    );
    let model = model_sql();
    assert!(
        model.contains("kinds.kind = 'Model' AND kinds.name = ? AND kinds.namespace = ?"),
        "{model}"
    );
}

#[test]
fn query_validation_matches_fastapi_bounds() {
    let (page, limit) = PublicBotsQuery {
        page: None,
        limit: None,
    }
    .validated()
    .unwrap();
    assert_eq!((page, limit), (1, 20));

    let error = PublicBotsQuery {
        page: Some("0".to_string()),
        limit: None,
    }
    .validated()
    .unwrap_err();
    assert_eq!(
        error.status(),
        brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
    );
    assert!(error.validation_detail().contains("greater_than_equal"));

    let error = PublicBotsQuery {
        page: None,
        limit: Some("1001".to_string()),
    }
    .validated()
    .unwrap_err();
    assert!(error.validation_detail().contains("less_than_equal"));

    let error = PublicBotsQuery {
        page: Some("abc".to_string()),
        limit: None,
    }
    .validated()
    .unwrap_err();
    assert!(error.validation_detail().contains("int_parsing"));
}

#[derive(Debug, Serialize)]
struct BotWithMeta {
    spec: BotSpecIn,
    metadata: MetaIn,
}

#[test]
fn item_expands_ghost_and_predefined_model() {
    let bot = kind_row(
        251883,
        "wegent-skill-creator",
        BotWithMeta {
            spec: BotSpecIn {
                ghost_ref: Some(ref_in("g")),
                shell_ref: Some(ref_in("Chat")),
                model_ref: Some(ref_in("m")),
                ..BotSpecIn::default()
            },
            metadata: MetaIn {
                display_name: "Nice Bot".to_string(),
            },
        },
    );

    let ghost = kind_row(
        1,
        "g",
        GhostDocIn {
            spec: GhostSpecIn {
                system_prompt: Some(Some("hi".to_string())),
                mcp_servers: Some(Some(BTreeMap::from([("a".to_string(), 1u8)]))),
                skills: Some(Some(vec!["s1".to_string()])),
                skill_refs: Some(Some(BTreeMap::from([(
                    "s1".to_string(),
                    SkillRefIn {
                        skill_id: 5,
                        is_public: true,
                        namespace: "default".to_string(),
                        content_hash: None,
                    },
                )]))),
                preload_skills: Some(Some(vec!["s1".to_string()])),
                preload_skill_refs: Some(None),
                default_knowledge_base_refs: Some(Some(vec![1])),
            },
        },
    );
    let model = kind_row(
        2,
        "m",
        ModelDocIn {
            spec: ModelSpecIn {
                is_custom_config: None,
                model_config: Some(BTreeMap::new()),
                protocol: None,
            },
        },
    );

    let item = build_item(&bot, Some(&ghost), Some(&model), refs_of(&bot));

    assert_eq!(item.display_name.as_deref(), Some("Nice Bot"));
    assert_eq!(item.ghost_name.as_deref(), Some("g"));
    assert_eq!(item.shell_name.as_deref(), Some("Chat"));
    assert_eq!(item.model_name.as_deref(), Some("m"));
    assert_eq!(item.system_prompt.as_deref(), Some("hi"));
    assert_eq!(
        json_of(&item.mcp_servers),
        json_of(&Some(BTreeMap::from([("a".to_string(), 1u8)])))
    );
    assert_eq!(
        json_of(&item.skills),
        json_of(&Some(vec!["s1".to_string()]))
    );
    // SkillRefMeta adds the missing content_hash default.
    assert_eq!(
        item.skill_refs,
        Some(BTreeMap::from([(
            "s1".to_string(),
            SkillRefMeta {
                skill_id: 5,
                namespace: "default".to_string(),
                is_public: true,
                content_hash: None,
            },
        )]))
    );
    assert_eq!(item.preload_skill_refs, None); // explicit null stays null
    assert_eq!(
        json_of(&item.agent_config),
        json_of(&Some(BindModel {
            bind_model: "m",
            bind_model_namespace: "default",
        }))
    );
    assert_eq!(item.created_at, "2026-06-04T08:31:48");
    assert!(item.is_active);
}

#[test]
fn item_expands_custom_model_config_with_protocol() {
    let bot = bot_row(BotSpecIn {
        ghost_ref: Some(ref_in("g")),
        model_ref: Some(ref_in("1分钟创意视频-model")),
        ..BotSpecIn::default()
    });
    let model = kind_row(
        3,
        "1分钟创意视频-model",
        ModelDocIn {
            spec: ModelSpecIn {
                is_custom_config: Some(true),
                model_config: Some(BTreeMap::from([(
                    "bind_model".to_string(),
                    "Seedance-2.0".to_string(),
                )])),
                protocol: Some("seedance".to_string()),
            },
        },
    );

    let item = build_item(&bot, None, Some(&model), refs_of(&bot));

    assert_eq!(
        json_of(&item.agent_config),
        json_of(&Some(BTreeMap::from([
            ("bind_model".to_string(), "Seedance-2.0".to_string()),
            ("protocol".to_string(), "seedance".to_string()),
        ])))
    );
    // No resolved ghost: the expanded fields stay null, not the defaults.
    assert_eq!(item.system_prompt, None);
    assert_eq!(item.skill_refs, None);
    assert!(item.mcp_servers.is_none());
}

#[test]
fn item_keeps_explicit_null_fields() {
    let bot = bot_row(BotSpecIn {
        ghost_ref: Some(ref_in("g")),
        ..BotSpecIn::default()
    });
    let ghost = kind_row(
        4,
        "g",
        GhostDocIn {
            spec: GhostSpecIn {
                system_prompt: Some(None),
                mcp_servers: Some(None),
                skill_refs: Some(None),
                ..GhostSpecIn::default()
            },
        },
    );

    let item = build_item(&bot, Some(&ghost), None, refs_of(&bot));

    assert_eq!(item.system_prompt, None);
    assert!(item.mcp_servers.is_none());
    assert_eq!(item.skill_refs, None);
}

#[test]
fn item_applies_ghost_defaults_for_absent_keys() {
    let bot = bot_row(BotSpecIn {
        ghost_ref: Some(ref_in("g")),
        ..BotSpecIn::default()
    });
    let ghost = kind_row(
        5,
        "g",
        GhostDocIn {
            spec: GhostSpecIn {
                system_prompt: Some(Some("x".to_string())),
                mcp_servers: Some(Some(BTreeMap::new())),
                skills: Some(Some(vec!["w".to_string()])),
                ..GhostSpecIn::default()
            },
        },
    );

    let item = build_item(&bot, Some(&ghost), None, refs_of(&bot));

    assert_eq!(item.skill_refs, Some(BTreeMap::new()));
    assert_eq!(json_of(&item.preload_skills), "[]");
    assert_eq!(item.preload_skill_refs, Some(BTreeMap::new()));
    assert_eq!(json_of(&item.default_knowledge_base_refs), "[]");
    assert!(item.agent_config.is_none());
}

#[test]
fn item_reads_secondary_model_namespace() {
    let bot = bot_row(BotSpecIn {
        ghost_ref: Some(ref_in("g")),
        secondary_model_ref: Some(RefIn {
            name: "openai-gpt-5.6-terra".to_string(),
            namespace: None,
        }),
        ..BotSpecIn::default()
    });

    let item = build_item(&bot, None, None, refs_of(&bot));

    assert_eq!(
        item.secondary_model_name.as_deref(),
        Some("openai-gpt-5.6-terra")
    );
    assert_eq!(item.secondary_model_namespace.as_deref(), Some("default"));
}
