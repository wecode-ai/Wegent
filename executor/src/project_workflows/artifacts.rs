// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;

pub const ARTIFACT_TYPES: &[&str] = &[
    "requirements_analysis",
    "implementation_plan",
    "code_change_summary",
    "test_report",
    "review_report",
    "pull_request",
    "ci_summary",
    "approval_decision",
    "delivery_summary",
    "execution_result",
];

pub fn validate_artifact(artifact_type: &str, content: &Value) -> Result<(), String> {
    if !ARTIFACT_TYPES.contains(&artifact_type) {
        return Err(format!(
            "Unsupported workflow artifact type: {artifact_type}"
        ));
    }
    if !content.is_object() {
        return Err("Workflow artifact content must be an object".to_owned());
    }
    Ok(())
}
