// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Gerrit's authenticated `GET` (HTTP Basic or HTTP Digest).
//!
//! Ports `GerritProvider._make_request`'s auth selection: `auth_type == "basic"`
//! sends `HTTPBasicAuth`, otherwise `HTTPDigestAuth`. `requests` performs the
//! Digest handshake transparently (an unauthenticated first attempt, then a
//! retry carrying the RFC 2617 `Authorization` header).
use brz_http::{Client, RequestBuilder};
use md5::{Digest as _, Md5};

/// `autographed_get`: the response body on success, `None` when the request
/// failed or the final status was not successful, mirroring
/// `raise_for_status()` being swallowed as a `RequestException`.
pub(crate) async fn authenticated_get(
    client: &Client,
    url: &str,
    query: &[(&str, String)],
    username: &str,
    token: &str,
    basic: bool,
) -> Option<String> {
    if basic {
        let builder = client
            .get(url)
            .ok()?
            .basic_auth(username, Some(token))
            .query(query);
        return send_text(builder).await;
    }
    // Digest: probe for the challenge, then retry with the computed response.
    let probe = client.get(url).ok()?.query(query).send().await.ok()?;
    let status = probe.status();
    if status.is_success() {
        return probe.text().await.ok();
    }
    let challenge = probe
        .headers()
        .get("www-authenticate")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    // Drain the challenge body so the probe is a completed exchange.
    let challenge = match challenge {
        Some(challenge) => {
            let _ = probe.text().await;
            challenge
        }
        None => {
            let _ = probe.text().await;
            return None;
        }
    };
    if status.as_u16() != 401 {
        return None;
    }
    let challenge = parse_digest(&challenge)?;
    let uri = request_uri(url, query)?;
    let authorization = digest_authorization(username, token, "GET", &uri, &challenge)?;
    let builder = client
        .get(url)
        .ok()?
        .header("authorization", authorization)
        .query(query);
    send_text(builder).await
}

async fn send_text(builder: RequestBuilder) -> Option<String> {
    let response = builder.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

/// One parsed `WWW-Authenticate: Digest` challenge.
struct DigestChallenge {
    realm: String,
    nonce: String,
    opaque: Option<String>,
    qop: Option<String>,
}

/// Parse a `Digest` challenge; a non-Digest scheme is unsupported.
fn parse_digest(header: &str) -> Option<DigestChallenge> {
    let rest = header
        .strip_prefix("Digest")
        .or_else(|| header.strip_prefix("digest"))?;
    let mut realm = None;
    let mut nonce = None;
    let mut opaque = None;
    let mut qop = None;
    for part in rest.split(',') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches('"').to_string();
        match key.as_str() {
            "realm" => realm = Some(value),
            "nonce" => nonce = Some(value),
            "opaque" => opaque = Some(value),
            // A server advertising both `auth` and `auth-int` still accepts
            // `auth`, which needs no body hash.
            "qop" => {
                qop = Some(if value.split(',').any(|token| token.trim() == "auth") {
                    "auth".to_string()
                } else {
                    value
                })
            }
            _ => {}
        }
    }
    Some(DigestChallenge {
        realm: realm?,
        nonce: nonce?,
        opaque,
        qop,
    })
}

/// Build the `Authorization: Digest` header value.
fn digest_authorization(
    username: &str,
    token: &str,
    method: &str,
    uri: &str,
    challenge: &DigestChallenge,
) -> Option<String> {
    let ha1 = md5_hex(&format!("{username}:{}:{token}", challenge.realm));
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let (response, qop_part, nc) = match challenge.qop.as_deref() {
        Some(qop) => {
            let nc = "00000001";
            let cnonce = "0123456789abcdef";
            let response = md5_hex(&format!(
                "{ha1}:{}:{nc}:{cnonce}:{qop}:{ha2}",
                challenge.nonce
            ));
            (response, qop, Some((nc, cnonce)))
        }
        None => (
            md5_hex(&format!("{ha1}:{}:{ha2}", challenge.nonce)),
            "",
            None,
        ),
    };
    let mut header = format!(
        "Digest username=\"{username}\", realm=\"{}\", nonce=\"{}\", uri=\"{uri}\", response=\"{response}\"",
        challenge.realm, challenge.nonce
    );
    if let Some((nc, cnonce)) = nc {
        header.push_str(&format!(", qop={qop_part}, nc={nc}, cnonce=\"{cnonce}\""));
    }
    if let Some(opaque) = &challenge.opaque {
        header.push_str(&format!(", opaque=\"{opaque}\""));
    }
    Some(header)
}

/// The request-target (`uri` directive) used in HA2: path plus query.
fn request_uri(url: &str, query: &[(&str, String)]) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let mut pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    for (key, value) in query {
        pairs.push(((*key).to_string(), value.clone()));
    }
    let mut path = parsed.path().to_string();
    if !pairs.is_empty() {
        let query = pairs
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        path.push('?');
        path.push_str(&query);
    }
    Some(path)
}

/// `hashlib.md5(text).hexdigest()`.
fn md5_hex(text: &str) -> String {
    let digest = Md5::digest(text.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap());
        out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_matches_known_vectors() {
        assert_eq!(md5_hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
    }

    #[test]
    fn digest_challenge_is_parsed() {
        let challenge = parse_digest(
            r#"Digest realm="Gerrit Code Review", qop="auth", nonce="abc", opaque="xyz""#,
        )
        .unwrap();
        assert_eq!(challenge.realm, "Gerrit Code Review");
        assert_eq!(challenge.nonce, "abc");
        assert_eq!(challenge.opaque.as_deref(), Some("xyz"));
        assert_eq!(challenge.qop.as_deref(), Some("auth"));
    }

    #[test]
    fn digest_authorization_carries_the_rfc2617_fields() {
        let challenge = DigestChallenge {
            realm: "testrealm@host.com".to_string(),
            nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093".to_string(),
            opaque: Some("5ccc069c403ebaf9f0171e9517f40e41".to_string()),
            qop: Some("auth".to_string()),
        };
        let header = digest_authorization(
            "Mufasa",
            "Circle Of Life",
            "GET",
            "/dir/index.html",
            &challenge,
        )
        .unwrap();
        assert!(header.starts_with("Digest username=\"Mufasa\""), "{header}");
        assert!(header.contains("realm=\"testrealm@host.com\""), "{header}");
        assert!(
            header.contains("nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\""),
            "{header}"
        );
        assert!(header.contains("uri=\"/dir/index.html\""), "{header}");
        assert!(
            header.contains("qop=auth, nc=00000001, cnonce=\"0123456789abcdef\""),
            "{header}"
        );
        assert!(
            header.contains("opaque=\"5ccc069c403ebaf9f0171e9517f40e41\""),
            "{header}"
        );
        // The response is a 32-character MD5 hex digest.
        let response = header
            .split("response=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap();
        assert_eq!(response.len(), 32);
        assert!(response.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn request_uri_merges_path_and_query() {
        assert_eq!(
            request_uri(
                "https://gerrit.example.com/a/projects/",
                &[("d", String::new())]
            )
            .unwrap(),
            "/a/projects/?d="
        );
    }
}
