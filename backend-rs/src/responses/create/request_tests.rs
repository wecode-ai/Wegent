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

#[test]
fn the_flat_model_config_precedes_the_shell_read() {
    // `_get_model_config` (`request_builder.py:318`) completes before
    // `_build_bot_config` (`:415`), whose `_resolve_shell_info` (`:2211`) is
    // the Shell read. Both flat-config failures return before the Shell call,
    // so a bot without a model, or a model that does not resolve, never issues
    // a Shell query.
    let source = include_str!("request.rs");
    let no_model = source
        .find("None => return Err(flat_model_config_error(None, &input.bot.name)),")
        .expect("bot-without-model raise");
    let unresolved = source
        .find("None => return Err(flat_model_config_error(Some(&model_name), &input.bot.name)),")
        .expect("model-not-found raise");
    let shell = source
        .find("let (shell_type, base_image) = resolve_shell_type(state, input).await?;")
        .expect("shell resolution");
    assert!(
        no_model < unresolved && unresolved < shell,
        "both flat-model-config failures must return before the Shell read"
    );
}
