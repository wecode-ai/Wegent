// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Kind-resolution helpers reproducing the source's recorded kind-cache
//! read sequences for the task-detail flow
//! (`team_kinds_service._convert_to_team_dict`,
//! `team_kinds_service._get_bot_summary`, and
//! `task_detail_helpers.get_bots_for_subtasks`'s per-bot tail).
use super::error::ApiError;
use super::kinds::KindStore;
use crate::crd::{CrdDocument, reference_parts};

/// `team_kinds_service._convert_to_team_dict`: per member, resolve the bot
/// through the reader the Team resolution uses — the member bot of a
/// non-group team is looked up with the resolved Team row's owner
/// (`team.user_id`, so a personal Bot of the team owner wins and the public
/// fallback follows), a group team resolves by name and namespace
/// (`get_group`), then `_get_bot_summary` for the member's bot (shell +
/// model reads). `user_id` is the task owner, used as the summary user for a
/// non-group team.
///
/// The outcome feeds only fields the tree and status responses discard; the
/// function is shared by both flows for its recorded kind-cache read
/// sequence.
pub(crate) async fn convert_team_dict<M>(
    kinds: &KindStore<'_, M, impl brz_redis::Redis>,
    team: &super::kinds::KindRecord,
    user_id: i64,
) -> Result<(), ApiError>
where
    M: brz_mysql::Mysql,
{
    let team_crd = CrdDocument::project(&team.json.0);
    let members = team_crd
        .spec
        .as_ref()
        .and_then(|spec| spec.members.as_ref());
    let is_group_resource = team.namespace != "default";
    let mut first_bot_id: Option<i64> = None;
    for member in members
        .into_iter()
        .flatten()
        .filter_map(|member| member.as_ref())
    {
        let Some((name, namespace)) = reference_parts(&member.bot_ref) else {
            continue;
        };
        let bot = if is_group_resource {
            kinds.get_group("Bot", &namespace, &name).await?
        } else {
            kinds
                .get_by_name_and_namespace(team.user_id, "Bot", &namespace, &name)
                .await?
        };
        let Some(bot) = bot else { continue };
        if first_bot_id.is_none() {
            first_bot_id = Some(bot.id);
        }
        let summary_user_id = if is_group_resource {
            bot.user_id
        } else {
            user_id
        };
        get_bot_summary(kinds, &bot, summary_user_id).await?;
    }
    // Agent-type lookup: the first bot again (`kindReader.get_by_id`), then
    // its shell through the cached reader. Only the shell read produces
    // cache traffic; the resulting `agent_type` is unused by the tree.
    if let Some(first_bot_id) = first_bot_id
        && let Some(first_bot) = kinds.get_by_id("Bot", first_bot_id).await?
    {
        let shell_user_id = if is_group_resource {
            first_bot.user_id
        } else {
            user_id
        };
        let first_bot_crd = CrdDocument::project(&first_bot.json.0);
        if let Some((name, namespace)) = first_bot_crd
            .spec
            .as_ref()
            .and_then(|spec| reference_parts(&spec.shell_ref))
        {
            let _shell = kinds
                .get_by_name_and_namespace(shell_user_id, "Shell", &namespace, &name)
                .await?;
        }
    }
    Ok(())
}

/// `team_kinds_service._get_bot_summary`: shell then model lookups through
/// the cached kind reader, mirroring the recorded read order. The built
/// summary is discarded by the tree response.
async fn get_bot_summary<M>(
    kinds: &KindStore<'_, M, impl brz_redis::Redis>,
    bot: &super::kinds::KindRecord,
    user_id: i64,
) -> Result<(), ApiError>
where
    M: brz_mysql::Mysql,
{
    let crd = CrdDocument::project(&bot.json.0);
    let spec = crd.spec.as_ref();
    if let Some((name, namespace)) = spec.and_then(|spec| reference_parts(&spec.shell_ref)) {
        let _shell = kinds
            .get_by_name_and_namespace(user_id, "Shell", &namespace, &name)
            .await?;
    }
    if let Some((name, namespace)) = spec.and_then(|spec| reference_parts(&spec.model_ref)) {
        let _model = kinds
            .get_by_name_and_namespace(user_id, "Model", &namespace, &name)
            .await?;
    }
    Ok(())
}

/// `task_detail_helpers.get_bots_for_subtasks` per-bot tail (statement
/// order): the model lookup first (`spec.modelRef`, by `bot.user_id`),
/// then the shell lookup (`spec.shellRef`, by `bot.user_id`), both through
/// the cached reader (`get_by_name_and_namespace`). For a public bot
/// (`user_id = 0`) only the public index is read; for a user bot the
/// personal index comes first and the public fallback follows. The built
/// summary is discarded by the tree response.
///
/// The source helper deduplicates the model and shell lookups per
/// `(bot.user_id, namespace, name)` through `model_cache` /
/// `shell_type_cache` local to ONE `get_bots_for_subtasks` call, so two
/// public bots sharing the same model/shell refs produce only one read
/// sequence (the recorded case: developer-bot and spec-bot both reference
/// `application-moonshot-kimi-k2.6(公网)` and `ClaudeCode`). Callers pass the
/// caches across the whole bot loop; `SummaryCaches` is created once per
/// `get_bots_for_subtasks` invocation and dropped afterwards.
#[derive(Default)]
pub(crate) struct SummaryCaches {
    models: Vec<(i64, String, String)>,
    shells: Vec<(i64, String, String)>,
}

impl SummaryCaches {
    fn seen(cache: &mut Vec<(i64, String, String)>, key: (i64, String, String)) -> bool {
        if cache.contains(&key) {
            return true;
        }
        cache.push(key);
        false
    }
}

pub(crate) async fn get_bot_summary_for_subtask<M>(
    kinds: &KindStore<'_, M, impl brz_redis::Redis>,
    bot: &super::kinds::KindRecord,
    caches: &mut SummaryCaches,
) -> Result<(), ApiError>
where
    M: brz_mysql::Mysql,
{
    let crd = CrdDocument::project(&bot.json.0);
    let spec = crd.spec.as_ref();
    if let Some((name, namespace)) = spec.and_then(|spec| reference_parts(&spec.model_ref)) {
        let key = (bot.user_id, namespace.clone(), name.clone());
        if !SummaryCaches::seen(&mut caches.models, key) {
            let _model = kinds
                .get_by_name_and_namespace(bot.user_id, "Model", &namespace, &name)
                .await?;
        }
    }
    if let Some((name, namespace)) = spec.and_then(|spec| reference_parts(&spec.shell_ref)) {
        let key = (bot.user_id, namespace.clone(), name.clone());
        if !SummaryCaches::seen(&mut caches.shells, key) {
            let _shell = kinds
                .get_by_name_and_namespace(bot.user_id, "Shell", &namespace, &name)
                .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_workspace_tree::kinds::KindRecord;

    fn team_record(
        user_id: i64,
        namespace: &str,
        bot_name: &str,
        bot_namespace: &str,
    ) -> KindRecord {
        KindRecord {
            id: 19709,
            user_id,
            kind: "Team".to_owned(),
            name: "AI助理".to_owned(),
            namespace: namespace.to_owned(),
            json: brz_mysql::Json(serde_json::json!({
                "kind": "Team",
                "spec": {
                    "members": [{
                        "role": "leader",
                        "botRef": {"name": bot_name, "namespace": bot_namespace},
                        "prompt": ""
                    }],
                    "collaborationModel": "solo"
                },
                "metadata": {"name": "AI助理", "namespace": namespace},
                "apiVersion": "agent.wecode.io/v1"
            })),
            is_active: 1,
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    /// `_convert_to_team_dict` resolves a member bot of a personal team with
    /// the resolved Team row's owner (`team.user_id`), not with the task
    /// CRD's teamRef: the source passes `team.user_id` to
    /// `get_by_name_and_namespace`, so the personal index/SQL of the team
    /// owner is the one that serves the lookup. The recorded
    /// `remote-workspace/status` case for task 19712 proves the lookup:
    /// `kind:v2:idx:personal:Bot:457:default:AI助理` followed by
    /// `kinds.user_id = 457 ... kind = 'Bot' ...`.
    #[tokio::test]
    async fn personal_team_member_bot_lookup_uses_the_team_owner() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let kinds: KindStore<'_, _, brz_redis::RedisService> = KindStore {
            mysql: &mysql,
            redis: None,
        };
        convert_team_dict(
            &kinds,
            &team_record(457, "default", "AI助理", "default"),
            457,
        )
        .await
        .expect("conversion succeeds");
        let queries = mysql.queries();
        assert_eq!(queries.len(), 2, "{queries:?}");
        assert_eq!(queries[0].first_integer, Some(457), "{queries:?}");
        assert!(
            queries[0]
                .sql
                .contains("WHERE kinds.user_id = ? AND kinds.kind = ? AND kinds.namespace = ?"),
            "{}",
            queries[0].sql
        );
        // The personal miss falls through to the public Bot index, exactly
        // like the recorded lane (`idx:personal` then `idx:public`).
        assert!(
            queries[1]
                .sql
                .contains("WHERE kinds.user_id = 0 AND kinds.kind = ?"),
            "{}",
            queries[1].sql
        );
    }

    /// A public team (`team.user_id == 0`) skips the personal index and
    /// resolves the member bot through the public fallback, exactly like the
    /// recorded `kind:v2:idx:public:Bot:default:wegent-chat` lane of the
    /// public-team status cases.
    #[tokio::test]
    async fn public_team_member_bot_lookup_falls_back_to_the_public_index() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let kinds: KindStore<'_, _, brz_redis::RedisService> = KindStore {
            mysql: &mysql,
            redis: None,
        };
        convert_team_dict(
            &kinds,
            &team_record(0, "default", "wegent-chat", "default"),
            457,
        )
        .await
        .expect("conversion succeeds");
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1, "{queries:?}");
        assert!(
            queries[0]
                .sql
                .contains("WHERE kinds.user_id = 0 AND kinds.kind = ? AND kinds.namespace = ?"),
            "{}",
            queries[0].sql
        );
    }

    /// A group team resolves its member bot by name and namespace
    /// (`kindReader.get_group`) regardless of the group owner.
    #[tokio::test]
    async fn group_team_member_bot_lookup_is_namespace_scoped() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let kinds: KindStore<'_, _, brz_redis::RedisService> = KindStore {
            mysql: &mysql,
            redis: None,
        };
        convert_team_dict(
            &kinds,
            &team_record(0, "Feed-Monitor", "接口请求分析助手-bot", "Feed-Monitor"),
            457,
        )
        .await
        .expect("conversion succeeds");
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1, "{queries:?}");
        assert!(
            !queries[0].sql.contains("WHERE kinds.user_id"),
            "{}",
            queries[0].sql
        );
        assert!(
            queries[0]
                .sql
                .contains("WHERE kinds.kind = ? AND kinds.namespace = ?"),
            "{}",
            queries[0].sql
        );
    }
}
