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

/// `team_kinds_service._convert_to_team_dict` (non-cache variant): per
/// member, resolve the bot through the cached reader (`get_by_name_and_namespace`
/// in namespace `default`, i.e. personal-then-public for Bot), then
/// `_get_bot_summary` for the member's bot (shell + model reads). The
/// result feeds only fields the tree response discards; the function is
/// reproduced for its recorded kind-cache read sequence.
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
