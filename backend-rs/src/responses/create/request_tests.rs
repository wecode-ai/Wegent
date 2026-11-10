// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `get_model_config_for_bot`'s raising contract and its position relative to
//! the Shell read.

use super::super::resolution::flat_model_config_error;

#[test]
fn a_bot_without_a_model_is_a_400_with_the_source_message() {
    // `get_model_config_for_bot`: `not model_name` raises
    // `Bot {bot.name} has no model configured`.
    let error = flat_model_config_error(None, "示例机器人");
    assert_eq!(error.status(), brz_http_server::StatusCode::BAD_REQUEST);
    assert_eq!(
        error.detail_message(),
        Some("Bot 示例机器人 has no model configured")
    );
}

#[test]
fn an_unresolved_model_is_a_400_with_the_source_message() {
    // `get_model_config_for_bot`: `model_name` with no Model raises
    // `Model {model_name} not found`.
    let error = flat_model_config_error(Some("sample-model（国内）"), "示例机器人");
    assert_eq!(error.status(), brz_http_server::StatusCode::BAD_REQUEST);
    assert_eq!(
        error.detail_message(),
        Some("Model sample-model（国内） not found")
    );
}

/// `_get_model_config` (`request_builder.py:318`), `_get_bot_skills` (`:393`)
/// and only then `_build_bot_config` (`:415`), whose `_resolve_shell_info`
/// (`:2219`) is the Shell read. Both flat-config failures return before the
/// Shell call, so a failed flat config never issues a Shell query. The one
/// earlier read is the Source's own cached `_resolve_shell_info` call in the
/// automatic-binding filter (`:374-388`), which runs before `_get_bot_skills`
/// only when a binding declares `bind_shells`; without one the lookup keeps
/// its later position and the Shell's team-owner group block cannot precede
/// the Ghost/Skill reads.
#[test]
fn the_flat_model_config_precedes_the_shell_read() {
    let source = include_str!("request.rs");
    let no_model = source
        .find("None => return Err(flat_model_config_error(None, &input.bot.name)),")
        .expect("bot-without-model raise");
    let unresolved = source
        .find("None => return Err(flat_model_config_error(Some(&model_name), &input.bot.name)),")
        .expect("model-not-found raise");
    let skills = source
        .find("let mut skills = get_bot_skills(")
        .expect("skill resolution");
    let early_shell = source
        .find("let early_shell = if super::skills::binding_refs_restrict_shell(&binding_refs) {")
        .expect("automatic-binding shell filter");
    let lazy_shell = source
        .find("None => resolve_shell_type(state, input).await?,")
        .expect("lazy shell resolution");
    assert!(
        no_model < unresolved && unresolved < early_shell && early_shell < skills,
        "both flat-model-config failures must return before any Shell read"
    );
    assert!(
        skills < lazy_shell,
        "the lazy Shell read belongs to _build_bot_config after _get_bot_skills"
    );
}

/// Source `TaskRequestBuilder.build` resolves `_get_bot_for_subtask` once and
/// reuses that Bot row for the team-member lookup. The `/chat` trigger already
/// performs that read to resolve the member role/prompt, so it marks the input
/// resolved and the builder must not issue the identical second `kinds` read.
#[test]
fn a_resolved_subtask_bot_skips_the_builder_reread() {
    let source = include_str!("request.rs");
    let guard = source
        .find("let subtask_bot = if input.subtask_bot_resolved {")
        .expect("the resolved-bot guard");
    let read = source
        .find("super::subtask_bot::bot_by_id(&state.mysql, input.bot_ids.first().copied())")
        .expect("the bot-by-id read");
    assert!(
        guard < read,
        "the builder must skip its bot re-read when the caller resolved it"
    );
    let trigger = include_str!("../../socketio/chat_trigger.rs");
    assert!(
        trigger.contains("subtask_bot_resolved: true,"),
        "the /chat trigger reuses the Bot it resolved for the member lookup"
    );
    let other_callers = [
        include_str!("seam.rs"),
        include_str!("../../background_jobs/code_wiki_task.rs"),
        include_str!("../../background_jobs/subscription_execution.rs"),
        include_str!("../../background_jobs/project_managed.rs"),
        include_str!("../../internal_callback/pipeline.rs"),
    ];
    for caller in other_callers {
        assert!(
            caller.contains("subtask_bot_resolved: false,"),
            "non-/chat callers keep the builder's single _get_bot_for_subtask read"
        );
    }
}
