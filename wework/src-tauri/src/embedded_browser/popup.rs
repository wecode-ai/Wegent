use serde::Serialize;
use tauri::Emitter;

use super::{current_unix_millis, EMBEDDED_BROWSER_POPUP_EVENT, EMBEDDED_BROWSER_POPUP_SEQUENCE};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EmbeddedBrowserPopupPayload {
    popup_id: String,
    parent_label: String,
    parent_native_label: String,
    url: String,
    origin: String,
    kind: String,
    strategy: String,
    status: String,
    created_at_unix_ms: u128,
    warning: Option<String>,
}

fn popup_origin(url: &tauri::Url) -> String {
    match (url.scheme(), url.host_str(), url.port()) {
        (scheme, Some(host), Some(port)) => format!("{scheme}://{host}:{port}"),
        (scheme, Some(host), None) => format!("{scheme}://{host}"),
        (scheme, None, _) => scheme.to_string(),
    }
}

pub(super) fn classify_popup_url(url: &tauri::Url) -> (&'static str, &'static str, Option<String>) {
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return (
            "external_scheme",
            "user_confirmation_required",
            Some("External schemes are not opened silently.".to_string()),
        );
    }

    let combined = format!(
        "{} {} {}",
        url.host_str().unwrap_or_default(),
        url.path(),
        url.query().unwrap_or_default()
    )
    .to_ascii_lowercase();
    if combined.contains("pay") || combined.contains("payment") || combined.contains("checkout") {
        return (
            "payment",
            "controlled_popup_required",
            Some(
                "Payment-like popup should require user confirmation before production use."
                    .to_string(),
            ),
        );
    }
    if [
        "oauth",
        "authorize",
        "openid",
        "sso",
        "saml",
        "cas",
        "login",
        "signin",
        "auth",
    ]
    .iter()
    .any(|marker| combined.contains(marker))
    {
        return ("oauth", "observe_and_allow", None);
    }
    ("unknown", "observe_and_allow", None)
}

pub(super) fn emit_popup_observed(
    app: &tauri::AppHandle,
    parent_label: &str,
    parent_native_label: &str,
    url: tauri::Url,
) {
    let (kind, strategy, warning) = classify_popup_url(&url);
    let payload = EmbeddedBrowserPopupPayload {
        popup_id: format!(
            "browser-popup-{}",
            EMBEDDED_BROWSER_POPUP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ),
        parent_label: parent_label.to_string(),
        parent_native_label: parent_native_label.to_string(),
        origin: popup_origin(&url),
        url: url.to_string(),
        kind: kind.to_string(),
        strategy: strategy.to_string(),
        status: "observed".to_string(),
        created_at_unix_ms: current_unix_millis(),
        warning,
    };
    let _ = app.emit(EMBEDDED_BROWSER_POPUP_EVENT, payload);
}
