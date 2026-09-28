// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared projection of executor-manager status/address responses.

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub(crate) struct ExecutorPayload {
    pub(crate) status: Option<String>,
    pub(crate) base_url: Option<String>,
}

impl ExecutorPayload {
    pub(crate) fn parse(body: &[u8]) -> Option<Self> {
        serde_json::from_slice(body).ok()
    }
    pub(crate) fn sandbox_available(&self) -> bool {
        self.status
            .as_deref()
            .is_some_and(|status| status.eq_ignore_ascii_case("running"))
            && self.base_url.as_deref().is_some_and(|url| !url.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn payload_parses_typed_fields() {
        for raw in ["null", "false", "invalid"] {
            assert!(ExecutorPayload::parse(raw.as_bytes()).is_none());
        }
        for raw in [r#"{}"#, r#"{"status":null,"base_url":"http://x"}"#] {
            assert!(
                !ExecutorPayload::parse(raw.as_bytes())
                    .unwrap()
                    .sandbox_available()
            );
        }
        for raw in [
            r#"{"status":"running","base_url":42}"#,
            r#"{"status":false,"base_url":"http://x"}"#,
        ] {
            assert!(ExecutorPayload::parse(raw.as_bytes()).is_none());
        }
        let payload =
            ExecutorPayload::parse(br#"{"status":"RUNNING","base_url":"http://x","extra":null}"#)
                .unwrap();
        assert!(payload.sandbox_available());
    }
}
