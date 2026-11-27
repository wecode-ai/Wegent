// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Hook {
    pub url: String,
    pub method: String,
    pub content_type: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub template: String,
}

impl Hook {
    pub fn validate(&self, allowed_origins: &str) -> Result<Url, &'static str> {
        let url = Url::parse(&self.url).map_err(|_| "Invalid Hook URL")?;
        if !safe_scheme(&url)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !allowed_origins
                .split(',')
                .map(str::trim)
                .any(|origin| origin == url.origin().ascii_serialization())
        {
            return Err("Hook URL must use an approved origin");
        }
        if !matches!(self.method.as_str(), "POST" | "PUT" | "PATCH")
            || self.template.len() > 16_384
            || self.headers.len() > 16
            || http::header::HeaderValue::from_str(&self.content_type).is_err()
        {
            return Err("Invalid Hook request configuration");
        }
        for (key, value) in &self.headers {
            let name = http::header::HeaderName::from_bytes(key.as_bytes())
                .map_err(|_| "Invalid Hook header")?;
            if !matches!(name.as_str(), "authorization" | "accept")
                && !name.as_str().starts_with("x-")
            {
                return Err("Unsupported Hook header");
            }
            if value.len() > 4096 || http::header::HeaderValue::from_str(value).is_err() {
                return Err("Invalid Hook header value");
            }
        }
        self.render(&Value::Null)?;
        Ok(url)
    }

    pub fn render(&self, variables: &Value) -> Result<String, &'static str> {
        let mut cursor = self.template.as_str();
        let mut body = String::new();
        let content_type = self
            .content_type
            .split(';')
            .next()
            .unwrap_or_default()
            .trim();
        while let Some((literal, remainder)) = cursor.split_once("{{") {
            body.push_str(literal);
            let (key, rest) = remainder
                .split_once("}}")
                .ok_or("Unclosed Hook template variable")?;
            let key = key.trim();
            if !matches!(
                key,
                "invocationId"
                    | "projectId"
                    | "issueId"
                    | "input"
                    | "callbackUrl"
                    | "callbackToken"
                    | "deliveryId"
            ) {
                return Err("Unknown Hook template variable");
            }
            let value = variables[key].as_str().unwrap_or_default();
            match content_type {
                "application/json" => {
                    body.push_str(&serde_json::to_string(value).map_err(|_| "Invalid JSON value")?)
                }
                "application/x-www-form-urlencoded" => {
                    body.extend(url::form_urlencoded::byte_serialize(value.as_bytes()))
                }
                "application/xml" | "text/xml" => escape_xml(value, &mut body),
                _ => body.push_str(value),
            }
            cursor = rest;
        }
        body.push_str(cursor);
        if content_type == "application/json" && serde_json::from_str::<Value>(&body).is_err() {
            return Err("Invalid JSON Hook template");
        }
        Ok(body)
    }
}

fn escape_xml(value: &str, output: &mut String) {
    for character in value.chars() {
        match character {
            '&' => output.push_str("&amp;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&apos;"),
            _ => output.push(character),
        }
    }
}

pub(super) fn safe_scheme(url: &Url) -> bool {
    url.scheme() == "https"
        || (url.scheme() == "http"
            && match url.host() {
                Some(url::Host::Ipv4(address)) => address.is_loopback(),
                Some(url::Host::Ipv6(address)) => address.is_loopback(),
                _ => false,
            })
}

pub(super) fn protect(key: &str, agent: &str, payload: &[u8]) -> Option<String> {
    use aes_gcm::aead::{Aead, AeadCore, OsRng, Payload};
    use base64::Engine as _;

    let cipher = cipher(key);
    let nonce = aes_gcm::Aes256Gcm::generate_nonce(&mut OsRng);
    let encrypted = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: payload,
                aad: agent.as_bytes(),
            },
        )
        .ok()?;
    let mut bytes = nonce.to_vec();
    bytes.extend(encrypted);
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub(super) fn unprotect(key: &str, agent: &str, payload: &str) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, Payload};
    use base64::Engine as _;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    let (nonce, ciphertext) = bytes.split_at_checked(12)?;
    cipher(key)
        .decrypt(
            aes_gcm::Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: agent.as_bytes(),
            },
        )
        .ok()
}

fn cipher(key: &str) -> aes_gcm::Aes256Gcm {
    use aes_gcm::KeyInit as _;
    use hmac::Mac as _;

    let key = super::mac(key, "external-hook-encryption", &[])
        .finalize()
        .into_bytes();
    aes_gcm::Aes256Gcm::new(&key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encodes_untrusted_text_for_the_configured_format() {
        let mut hook = Hook {
            url: "https://hooks.example.com/incoming".into(),
            method: "POST".into(),
            content_type: "application/xml".into(),
            headers: BTreeMap::new(),
            template: "<text>{{input}}</text>".into(),
        };
        assert!(hook.validate("https://hooks.example.com").is_ok());
        assert!(
            hook.validate("https://hooks.example.com.evil.test")
                .is_err()
        );
        let data = json!({"input":"x&<\"" });
        assert_eq!(hook.render(&data).unwrap(), "<text>x&amp;&lt;&quot;</text>");
        hook.content_type = "application/x-www-form-urlencoded".into();
        hook.template = "text={{input}}".into();
        assert_eq!(hook.render(&data).unwrap(), "text=x%26%3C%22");
        hook.content_type = "application/json".into();
        hook.template = r#"{"text":{{input}}}"#.into();
        assert_eq!(
            serde_json::from_str::<Value>(&hook.render(&data).unwrap()).unwrap()["text"],
            data["input"]
        );
    }
}
