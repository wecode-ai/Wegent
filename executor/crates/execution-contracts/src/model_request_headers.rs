// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

const GATEWAY_PREFIX: &str = "x-wegent-upstream-header-";

/// Attach the desktop identity from the host that launched this executor.
pub fn apply_wework_headers(headers: &mut Vec<(String, String)>) {
    if let Ok(version) = std::env::var("WEWORK_APP_VERSION") {
        apply_desktop_identity(headers, &version);
    }
}

fn apply_desktop_identity(headers: &mut Vec<(String, String)>, version: &str) {
    if version.is_empty()
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return;
    }
    let gateway = headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("x-wegent-model-type"));
    for (name, value) in [
        ("x-wework-version", version),
        ("x-wework-platform", std::env::consts::OS),
        ("x-wework-arch", std::env::consts::ARCH),
    ] {
        let forwarded = format!("{GATEWAY_PREFIX}{name}");
        headers.retain(|(key, _)| {
            !key.eq_ignore_ascii_case(name) && !key.eq_ignore_ascii_case(&forwarded)
        });
        headers.push((
            if gateway { forwarded } else { name.to_owned() },
            value.to_owned(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_identity_replaces_stale_values_and_follows_gateway_routing() {
        let mut headers = vec![
            ("X-WeWork-Version".into(), "stale".into()),
            (
                "X-Wegent-Upstream-Header-X-Wework-Version".into(),
                "stale".into(),
            ),
            ("Authorization".into(), "Bearer provider-key".into()),
        ];
        apply_desktop_identity(&mut headers, "1.2.3-beta.1+build");
        assert_eq!(
            headers[0],
            ("Authorization".into(), "Bearer provider-key".into())
        );
        assert_eq!(
            headers[1],
            ("x-wework-version".into(), "1.2.3-beta.1+build".into())
        );
        assert_eq!(
            headers[2],
            ("x-wework-platform".into(), std::env::consts::OS.into())
        );
        assert_eq!(
            headers[3],
            ("x-wework-arch".into(), std::env::consts::ARCH.into())
        );

        headers.push(("X-Wegent-Model-Type".into(), "public".into()));
        apply_desktop_identity(&mut headers, "1.2.4");
        assert_eq!(
            headers[2],
            (
                "x-wegent-upstream-header-x-wework-version".into(),
                "1.2.4".into()
            )
        );
        assert!(headers[2..]
            .iter()
            .all(|(name, _)| name.starts_with(GATEWAY_PREFIX)));
        assert_eq!(headers.len(), 5);
    }
}
