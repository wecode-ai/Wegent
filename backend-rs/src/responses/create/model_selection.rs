// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `create_response`'s model selection (`openapi_responses.py:594-672`).
//!
//! With an explicit `model_id`, `_resolve_requested_model` resolves the
//! requested Model through the caller-visible namespace scope and a missing
//! Model is the source's `400 Model '<ns>/<id>' not found`.
//!
//! Without a `model_id`, the source validates the whole Team CRD instead:
//! every member's `botRef` must be complete, every referenced Bot must exist
//! (one `kindReader.get_by_name_and_namespace` read per member, i.e. one
//! cached `kind:v2:idx:group:Bot` read on the shared reader), each Bot's
//! `spec.modelRef` must carry a name and a namespace, and member 0's
//! referenced Model supplies `model_info["model_type"]`.
//!
//! The resolved category (`shared/utils/model_category.py`) is what
//! `setup_chat_session` turns into the Task's `taskType`.
use brz_http_server::StatusCode;
use brz_mysql::Mysql;
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::task_skills::kinds::KindCacheStore;

use super::handler::dependency;
use super::resolution::{KindRow, kinds_row, model_by_name_namespace};

/// `resolve_model_category`: the normalized category of a Model `spec`.
///
/// The CRD keeps it at `spec.modelType`; older payloads nest it in
/// `spec.modelConfig.modelType`. Missing or `null` reads as `llm`, and the
/// value is trimmed and lower-cased.
pub fn model_category(spec: Option<&Value>) -> String {
    let spec = spec.unwrap_or(&Value::Null);
    let model_type = spec
        .get("modelType")
        .filter(|value| !value.is_null())
        .or_else(|| {
            spec.get("modelConfig")
                .and_then(|config| config.get("modelType"))
                .filter(|value| !value.is_null())
        });
    let text = match model_type {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    let text = text.trim().to_ascii_lowercase();
    if text.is_empty() {
        "llm".to_string()
    } else {
        text
    }
}

/// `create_response`'s `model_info["model_type"]`: `Some(category)` once a
/// Model was resolved, `None` when the source leaves it unset.
pub async fn resolve_model_selection<M, R>(
    cache: &KindCacheStore<'_, M, R>,
    user_id: i64,
    namespace: &str,
    team_name: &str,
    team_owner_user_id: i64,
    team_json: &Value,
    model_id: Option<&str>,
) -> Result<Option<String>, FastApiError>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let Some(model_id) = model_id else {
        return validate_member_models(
            cache,
            user_id,
            namespace,
            team_name,
            team_owner_user_id,
            team_json,
        )
        .await;
    };
    let Some(model) = resolve_requested_model(cache.mysql, user_id, namespace, model_id).await?
    else {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Model '{namespace}/{model_id}' not found"),
        ));
    };
    Ok(Some(category_of(&model)))
}

/// `_resolve_requested_model`: the directly-owned Model in `namespace`, then
/// the caller's `default` namespace when `namespace` is not `default`.
pub async fn resolve_requested_model<M: Mysql>(
    mysql: &M,
    user_id: i64,
    namespace: &str,
    name: &str,
) -> Result<Option<KindRow>, FastApiError> {
    let mut model = model_by_name_namespace(mysql, user_id, name, namespace)
        .await
        .map_err(dependency)?;
    if model.is_none() && namespace != "default" {
        model = model_by_name_namespace(mysql, user_id, name, "default")
            .await
            .map_err(dependency)?;
    }
    Ok(model)
}

/// The `model_id`-absent branch: validate every member's Bot `modelRef`, and
/// take member 0's referenced Model as the resolved category.
async fn validate_member_models<M, R>(
    cache: &KindCacheStore<'_, M, R>,
    user_id: i64,
    namespace: &str,
    team_name: &str,
    team_owner_user_id: i64,
    team_json: &Value,
) -> Result<Option<String>, FastApiError>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    // `Team.model_validate(team.json).spec.members` is a required list: a
    // missing or non-list value fails the CRD parse, and only a present but
    // empty list reaches the source's `400`.
    let members = match team_json.get("spec").and_then(|spec| spec.get("members")) {
        Some(Value::Array(members)) => members,
        _ => return Err(FastApiError::unhandled()),
    };
    if members.is_empty() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Team '{namespace}#{team_name}' has no members configured"),
        ));
    }

    let mut model_type = None;
    for (index, member) in members.iter().enumerate() {
        // `TeamMember.botRef.name` is a required string; `namespace` defaults
        // to `default`. Anything else fails `Team.model_validate`.
        let bot_ref = match member.get("botRef") {
            Some(Value::Object(bot_ref)) => bot_ref,
            _ => return Err(FastApiError::unhandled()),
        };
        let bot_name = match bot_ref.get("name") {
            Some(Value::String(name)) => name.as_str(),
            _ => return Err(FastApiError::unhandled()),
        };
        let bot_namespace = match bot_ref.get("namespace") {
            Some(Value::String(namespace)) => namespace.as_str(),
            None => "default",
            Some(_) => return Err(FastApiError::unhandled()),
        };
        if bot_name.is_empty() {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                format!("Team '{namespace}#{team_name}' has invalid bot reference"),
            ));
        }

        // `kindReader.get_by_name_and_namespace`: the same cached read
        // `get_bot_ids_from_team` performs for this member.
        let Some(bot) = cache
            .get_by_name_and_namespace_row(team_owner_user_id, "Bot", bot_namespace, bot_name)
            .await
            .map_err(dependency)?
            .map(kinds_row)
        else {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                format!("Bot '{bot_namespace}/{bot_name}' not found"),
            ));
        };

        // `Bot.model_validate(bot.json).spec.modelRef`: optional (a `None`
        // reference is the source's `400`), but a present reference's `name`
        // is required and `namespace` defaults to `default`.
        let invalid_model = || {
            FastApiError::detail(
                StatusCode::BAD_REQUEST,
                format!(
                    "Bot '{bot_namespace}/{bot_name}' does not have a valid model \
                     configured. Please specify model_id in the request or configure \
                     modelRef for the bot."
                ),
            )
        };
        let model_ref = bot.json.0.get("spec").and_then(|spec| spec.get("modelRef"));
        let reference = match model_ref {
            None | Some(Value::Null) => return Err(invalid_model()),
            Some(Value::Object(reference)) => reference,
            Some(_) => return Err(FastApiError::unhandled()),
        };
        let reference_name = match reference.get("name") {
            Some(Value::String(name)) => name.as_str(),
            _ => return Err(FastApiError::unhandled()),
        };
        let reference_namespace = match reference.get("namespace") {
            Some(Value::String(namespace)) => namespace.as_str(),
            None => "default",
            Some(_) => return Err(FastApiError::unhandled()),
        };
        if reference_name.is_empty() || reference_namespace.is_empty() {
            return Err(invalid_model());
        }

        if index == 0 {
            let default_model =
                resolve_requested_model(cache.mysql, user_id, reference_namespace, reference_name)
                    .await?;
            if let Some(model) = default_model {
                model_type = Some(category_of(&model));
            }
        }
    }
    Ok(model_type)
}

/// `_model_category_from_kind`: the resolved Model row's `spec` category.
fn category_of(model: &KindRow) -> String {
    model_category(model.json.0.get("spec"))
}

/// `chat_session.py:66-70`: `task_type = model_type if model_type in {image,
/// video} else ("code" if git_url else "chat")`. The Task's default covers
/// the `code`/`chat` arms, so only the generation categories are explicit.
pub fn model_task_type(category: Option<&str>) -> Option<&str> {
    category.filter(|category| matches!(*category, "image" | "video"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn category_prefers_the_top_level_model_type() {
        let spec = serde_json::json!({
            "modelType": "  Video ",
            "modelConfig": {"modelType": "llm"},
        });
        assert_eq!(model_category(Some(&spec)), "video");
    }

    #[test]
    fn category_falls_back_to_the_nested_config() {
        let spec = serde_json::json!({"modelConfig": {"modelType": "IMAGE"}});
        assert_eq!(model_category(Some(&spec)), "image");
    }

    #[test]
    fn category_defaults_to_llm() {
        assert_eq!(model_category(None), "llm");
        assert_eq!(model_category(Some(&serde_json::json!({}))), "llm");
        assert_eq!(
            model_category(Some(&serde_json::json!({"modelType": null}))),
            "llm"
        );
    }

    #[test]
    fn task_type_only_carries_the_generation_categories() {
        assert_eq!(model_task_type(Some("video")), Some("video"));
        assert_eq!(model_task_type(Some("image")), Some("image"));
        assert_eq!(model_task_type(Some("llm")), None);
        assert_eq!(model_task_type(None), None);
    }

    /// The `model_id`-absent branch reads each member's Bot through the cached
    /// reader, exactly like `get_bot_ids_from_team`: the recording carries one
    /// `kind:v2:idx:group:Bot` read for it before the id/first-bot reads.
    #[tokio::test]
    async fn member_validation_reads_one_cached_bot_per_member() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let store: KindCacheStore<'_, _> = KindCacheStore {
            mysql: &mysql,
            redis: None,
            erp: None,
            resolvers: None,
        };
        let team = serde_json::json!({
            "spec": {"members": [{"botRef": {"name": "bot", "namespace": "ns-b"}}]}
        });
        let error = resolve_model_selection(&store, 6527, "ns-b", "team-beta", 6527, &team, None)
            .await
            .expect_err("the capture fake resolves no Bot");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);

        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(queries[0].sql.contains("kinds.kind = ?"));
        assert!(queries[0].sql.contains("kinds.namespace = ?"));
        assert!(queries[0].sql.contains("kinds.name = ?"));
        assert_eq!(queries[0].args, 3);
    }

    /// One read per member, in member order.
    #[tokio::test]
    async fn member_validation_reads_every_member_bot() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let store: KindCacheStore<'_, _> = KindCacheStore {
            mysql: &mysql,
            redis: None,
            erp: None,
            resolvers: None,
        };
        let team = serde_json::json!({
            "spec": {"members": [
                {"botRef": {"name": "first", "namespace": "ns-b"}},
                {"botRef": {"name": "second", "namespace": "ns-b"}},
            ]}
        });
        resolve_model_selection(&store, 6527, "ns-b", "team-beta", 6527, &team, None)
            .await
            .expect_err("the capture fake resolves no Bot");
        // The first member's Bot is missing, so the loop stops there.
        assert_eq!(mysql.queries().len(), 1);
    }

    /// An empty `spec.members` list is the source's `400`; a missing or
    /// non-list value fails `Team.model_validate` first.
    #[tokio::test]
    async fn member_validation_rejects_a_team_without_members() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let store: KindCacheStore<'_, _> = KindCacheStore {
            mysql: &mysql,
            redis: None,
            erp: None,
            resolvers: None,
        };
        let empty = serde_json::json!({"spec": {"members": []}});
        let error = resolve_model_selection(&store, 6527, "ns-b", "team-beta", 6527, &empty, None)
            .await
            .expect_err("no members");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);

        for malformed in [
            serde_json::json!({"spec": {}}),
            serde_json::json!({"spec": {"members": "not-a-list"}}),
            serde_json::json!({}),
        ] {
            let error =
                resolve_model_selection(&store, 6527, "ns-b", "team-beta", 6527, &malformed, None)
                    .await
                    .expect_err("invalid crd");
            assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        }
        // Both checks run before any read.
        assert!(mysql.queries().is_empty());
    }

    /// The `botRef` shape is validated before the Bot read.
    #[tokio::test]
    async fn member_validation_rejects_a_member_without_a_bot_name() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let store: KindCacheStore<'_, _> = KindCacheStore {
            mysql: &mysql,
            redis: None,
            erp: None,
            resolvers: None,
        };
        let empty_name = serde_json::json!({"spec": {"members": [{"botRef": {"name": ""}}]}});
        let error =
            resolve_model_selection(&store, 6527, "ns-b", "team-beta", 6527, &empty_name, None)
                .await
                .expect_err("empty bot name");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);

        for malformed in [
            serde_json::json!({"spec": {"members": [{"name": "x"}]}}),
            serde_json::json!({"spec": {"members": [{"botRef": {"namespace": "ns-b"}}]}}),
        ] {
            let error =
                resolve_model_selection(&store, 6527, "ns-b", "team-beta", 6527, &malformed, None)
                    .await
                    .expect_err("invalid bot ref");
            assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        }
        assert!(mysql.queries().is_empty());
    }

    /// The `botRef.namespace` default is `default`, so an omitted namespace
    /// reads through the personal/public fallback rather than the group path.
    #[tokio::test]
    async fn member_validation_defaults_a_missing_bot_namespace() {
        let mysql = crate::sql_test_support::KindQueryCapture::writing();
        let store: KindCacheStore<'_, _> = KindCacheStore {
            mysql: &mysql,
            redis: None,
            erp: None,
            resolvers: None,
        };
        let team = serde_json::json!({"spec": {"members": [{"botRef": {"name": "bot"}}]}});
        resolve_model_selection(&store, 6527, "ns-b", "team-beta", 6527, &team, None)
            .await
            .expect_err("the capture fake resolves no Bot");
        // The `default` namespace reads personal then the public fallback.
        let queries = mysql.queries();
        assert_eq!(queries.len(), 2);
        assert!(queries[0].sql.contains("kinds.user_id = ?"));
        assert!(queries[0].sql.contains("kinds.namespace = ?"));
        assert_eq!(queries[0].args, 4);
        assert!(queries[1].sql.contains("kinds.user_id = 0"));
    }
}
