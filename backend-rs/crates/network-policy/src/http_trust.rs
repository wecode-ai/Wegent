// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Trust anchors for outbound HTTPS clients.
//!
//! A deployment that intercepts outbound HTTPS to serve recorded dependency
//! traffic mounts one public certificate at a fixed container path. Every
//! client whose dependencies are intercepted must add that certificate to its
//! trust store, because the shared `brz-http` transport validates the chain
//! against the bundled webpki roots only. A normal deployment has no file at
//! that path, so its clients keep the built-in roots unchanged.

use std::path::Path;

/// The fixed path of the deployment's public trust anchor.
const TRUST_ANCHOR_PATH: &str = "/traffic-e2e/trust/replay-ca.pem";

/// The deployment's trust anchor, when the file is present and parseable.
pub fn trust_anchor() -> Option<brz_http::reqwest::Certificate> {
    trust_anchor_from(Path::new(TRUST_ANCHOR_PATH))
}

/// Reads one PEM bundle and parses its first certificate.
pub fn trust_anchor_from(path: &Path) -> Option<brz_http::reqwest::Certificate> {
    let pem = std::fs::read(path).ok()?;
    brz_http::reqwest::Certificate::from_pem(&pem).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_anchor_leaves_the_built_in_roots_alone() {
        assert!(trust_anchor_from(Path::new("/nonexistent/replay-ca.pem")).is_none());
        assert!(
            trust_anchor_from(Path::new("/nonexistent/traffic-e2e/trust/replay-ca.pem")).is_none()
        );
    }
}
