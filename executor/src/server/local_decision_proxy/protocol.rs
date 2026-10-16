// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wire types for the `wework-decision-router/1` protocol.
//!
//! These structs describe the contract between a Wework Smart App and the
//! Executor local decision proxy. They intentionally perform no business
//! validation: catalog authorization, `questions` shape checks, and error mapping
//! belong to the HTTP handler, which owns the response status codes.

use serde::{Deserialize, Serialize};

/// Only protocol version this Executor build understands.
pub(crate) const DECISION_PROXY_PROTOCOL_VERSION: u32 = 1;

/// One entry of the model catalogue reported by `GET .../status`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DecisionModel {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub protocol: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "type")]
    pub model_type: String,
    pub namespace: String,
}

/// `POST .../v1/decisions` request body.
///
/// Extra top-level fields are rejected so that client-side fields such as
/// `baseUrl`, `apiKey`, or `endpoint` can never travel with a request.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DecisionRequest {
    pub model: String,
    /// Any JSON value is forwarded upstream untouched; `null` is accepted here
    /// and rejected by the request validator.
    pub state: serde_json::Value,
    pub questions: serde_json::Value,
}

/// `GET .../status` response body.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct DecisionStatusResponse {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    pub models: Vec<DecisionModel>,
}

/// Error envelope shared by every failure response.
#[derive(Debug, Serialize)]
pub(crate) struct DecisionProxyErrorBody {
    pub error: DecisionProxyErrorPayload,
}

/// Client-visible error detail. Only these four fields may be serialized.
#[derive(Debug, Serialize)]
pub(crate) struct DecisionProxyErrorPayload {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
    #[serde(rename = "requestId")]
    pub request_id: String,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn status_response_uses_camel_case_wire_keys() {
        let response = DecisionStatusResponse {
            protocol_version: DECISION_PROXY_PROTOCOL_VERSION,
            default_model: "model-a".to_owned(),
            models: vec![DecisionModel {
                id: "model-a".to_owned(),
                display_name: "Model A".to_owned(),
                protocol: "systemone".to_owned(),
                model_id: "jev-latest".to_owned(),
                model_type: "public".to_owned(),
                namespace: "default".to_owned(),
            }],
        };
        let value = serde_json::to_value(&response).expect("serialize status response");
        assert_eq!(
            value,
            json!({
                "protocolVersion": 1,
                "defaultModel": "model-a",
                "models": [{
                    "id": "model-a", "displayName": "Model A", "protocol": "systemone",
                    "modelId": "jev-latest", "type": "public", "namespace": "default"
                }],
            })
        );
    }

    #[test]
    fn request_rejects_unknown_top_level_fields() {
        let error = serde_json::from_value::<DecisionRequest>(json!({
            "model": "model-a",
            "state": {},
            "questions": {},
            "baseUrl": "https://evil.example.com",
        }))
        .expect_err("unknown top-level fields must be rejected");
        assert!(
            error.to_string().contains("baseUrl"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn request_requires_model_state_and_questions() {
        for body in [
            json!({"state": {}, "questions": {}}),
            json!({"model": "model-a", "questions": {}}),
            json!({"model": "model-a", "state": {}}),
        ] {
            assert!(
                serde_json::from_value::<DecisionRequest>(body.clone()).is_err(),
                "body must be rejected: {body}"
            );
        }
    }

    #[test]
    fn request_forwards_any_non_null_state_shape() {
        for state in [json!("text"), json!(42), json!([1, 2]), json!({"k": "v"})] {
            let request = serde_json::from_value::<DecisionRequest>(json!({
                "model": "model-a",
                "state": state,
                "questions": {"q1": {}},
            }))
            .expect("the DTO does not validate the shape of state");
            assert_eq!(request.state, state);
        }
    }

    #[test]
    fn request_keeps_null_state_for_the_validator_to_reject() {
        let request = serde_json::from_value::<DecisionRequest>(json!({
            "model": "model-a",
            "state": null,
            "questions": {},
        }))
        .expect("null deserializes; the request validator rejects it");
        assert!(request.state.is_null());
    }

    #[test]
    fn error_body_serializes_only_whitelisted_fields() {
        let body = DecisionProxyErrorBody {
            error: DecisionProxyErrorPayload {
                code: "upstream_rejected",
                message: "upstream rejected the request",
                retryable: false,
                request_id: "local_req_1".to_owned(),
            },
        };
        let value = serde_json::to_value(&body).expect("serialize error body");
        assert_eq!(
            value,
            json!({
                "error": {
                    "code": "upstream_rejected",
                    "message": "upstream rejected the request",
                    "retryable": false,
                    "requestId": "local_req_1",
                }
            })
        );
    }
}
