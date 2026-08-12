use std::env;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::{browser_url, EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV};

pub(super) fn bridge_navigation_url(url: &str) -> Result<tauri::Url, String> {
    let parsed = browser_url(url)?;
    match parsed.scheme() {
        "http" | "https" | "file" => Ok(parsed),
        scheme => Err(format!(
            "Embedded browser bridge only allows http/https/file URLs, got {scheme}"
        )),
    }
}

pub(super) fn generate_bridge_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("Failed to generate embedded browser bridge token: {error}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn expected_bridge_authorization() -> Result<String, String> {
    let token = env::var(EMBEDDED_BROWSER_BRIDGE_TOKEN_ENV)
        .map_err(|_| "Embedded browser bridge token is not configured".to_string())?;
    let token = token.trim();
    if token.is_empty() {
        return Err("Embedded browser bridge token is empty".to_string());
    }
    Ok(format!("Bearer {token}"))
}

pub(super) fn bridge_request_authorized(headers: &str) -> Result<bool, String> {
    let expected = expected_bridge_authorization()?;
    Ok(headers
        .lines()
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            name.eq_ignore_ascii_case("authorization") && value.trim() == expected
        }))
}
