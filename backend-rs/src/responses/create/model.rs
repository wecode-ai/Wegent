// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `parse_model_string` (`app/services/openapi/helpers.py`).
use brz_http_server::StatusCode;

use crate::http_compat::FastApiError;

/// The parsed `model` request field: `namespace#team_name` plus an optional
/// `#model_id`.
#[derive(Debug, PartialEq, Eq)]
pub struct ModelString {
    pub namespace: String,
    pub team_name: String,
    pub model_id: Option<String>,
}

/// `parse_model_string`: split `model` on `#`; fewer than two parts raise the
/// source's `400` detail, extra parts are ignored (Python takes index 2 only).
pub fn parse_model_string(model: &str) -> Result<ModelString, FastApiError> {
    let parts: Vec<&str> = model.split('#').collect();
    if parts.len() < 2 {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!(
                "Invalid model format: '{model}'. Expected format: \
                 'namespace#team_name' or 'namespace#team_name#model_id'"
            ),
        ));
    }
    Ok(ModelString {
        namespace: parts[0].to_string(),
        team_name: parts[1].to_string(),
        model_id: parts.get(2).map(|model_id| model_id.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_recorded_model_string() {
        let parsed =
            parse_model_string("ns-b#team-beta#deepseek-flash-not-think(公网)").expect("parse");
        assert_eq!(
            parsed,
            ModelString {
                namespace: "ns-b".to_string(),
                team_name: "team-beta".to_string(),
                model_id: Some("deepseek-flash-not-think(公网)".to_string()),
            }
        );
    }

    #[test]
    fn parses_a_model_string_without_a_model_id() {
        let parsed = parse_model_string("default#健康哨兵").expect("parse");
        assert_eq!(parsed.namespace, "default");
        assert_eq!(parsed.team_name, "健康哨兵");
        assert_eq!(parsed.model_id, None);
    }

    #[test]
    fn rejects_a_model_string_without_a_separator() {
        let error = parse_model_string("no-separator").expect_err("reject");
        // The source raises HTTPException(400, "Invalid model format: ...").
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            parse_model_string("").expect_err("reject").status(),
            StatusCode::BAD_REQUEST
        );
    }
}
