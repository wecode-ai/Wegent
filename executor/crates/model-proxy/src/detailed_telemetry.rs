//! Transport for diagnostic details explicitly authorized in Wework.
use axum::{body::Bytes, http::StatusCode};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::json;
use std::{path::PathBuf, sync::OnceLock, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    telemetry_enabled: bool,
    detailed_telemetry_enabled: bool,
    detailed_telemetry_destination: Option<Destination>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Destination {
    host: String,
    project_key: String,
}

fn destination(bytes: &[u8]) -> Option<(url::Url, String)> {
    let prefs: Preferences = serde_json::from_slice(bytes).ok()?;
    if !prefs.telemetry_enabled || !prefs.detailed_telemetry_enabled {
        return None;
    }
    let target = prefs.detailed_telemetry_destination?;
    let mut url = url::Url::parse(&target.host).ok()?;
    let loopback = matches!(url.host(), Some(url::Host::Ipv4(ip)) if ip.is_loopback())
        || matches!(url.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback());
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || target.project_key.is_empty()
    {
        return None;
    }
    url.set_path(&format!("{}/capture/", url.path().trim_end_matches('/')));
    url.set_query(None);
    url.set_fragment(None);
    Some((url, target.project_key))
}

pub(crate) enum DiagnosticDetail {
    ModelHttpError {
        status: StatusCode,
        body: Bytes,
        model: Option<String>,
    },
}

pub(crate) fn capture_model_http_error(status: StatusCode, body: Bytes, model: Option<String>) {
    if !status.is_client_error() && !status.is_server_error() {
        return;
    }
    capture(DiagnosticDetail::ModelHttpError {
        status,
        body,
        model,
    });
}

pub(crate) fn capture(detail: DiagnosticDetail) {
    let Some(path) = std::env::var_os("WEWORK_DETAILED_TELEMETRY_PREFERENCES") else {
        return;
    };
    tokio::spawn(send_if_consented(path.into(), detail));
}

async fn send_if_consented(path: PathBuf, detail: DiagnosticDetail) {
    let Ok(prefs) = tokio::fs::read(path).await else {
        return;
    };
    let Some((url, key)) = destination(&prefs) else {
        return;
    };
    static CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
    let Some(client) = CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .ok()
    }) else {
        return;
    };
    let (name, properties) = match detail {
        DiagnosticDetail::ModelHttpError {
            status,
            body,
            model,
        } => {
            let (text, encoding) = match std::str::from_utf8(&body) {
                Ok(text) => (text.to_owned(), "utf-8"),
                Err(_) => (STANDARD.encode(&body), "base64"),
            };
            (
                "model_http_error",
                json!({
                            "distinct_id": "wework-model-http-diagnostics",
                            "$process_person_profile": false,
                            "$geoip_disable": true,
                            "$ai_model": model,
                            "http_status": status.as_u16(),
                            "response_body": text,
                            "response_body_encoding": encoding
                }),
            )
        }
    };
    let _ = client
        .post(url)
        .json(&json!({"api_key":key,"event":name,"properties":properties}))
        .send()
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn delivers_original_http_error_after_opt_in() {
        use axum::{routing::post, Json, Router};
        let (tx, mut rx) = tokio::sync::mpsc::channel(1);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/capture/",
            post(move |Json(event): Json<serde_json::Value>| {
                let tx = tx.clone();
                async move {
                    tx.send(event).await.unwrap();
                    StatusCode::OK
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        let body = Bytes::from_static(b"{  \"error\": \"quota\" }\n");
        for consent in [false, true, false] {
            let prefs = json!({"telemetryEnabled": true, "detailedTelemetryEnabled": consent,
                "detailedTelemetryDestination":{"host":host,"projectKey":"test"}});
            tokio::fs::write(&path, prefs.to_string()).await.unwrap();
            send_if_consented(
                path.clone(),
                DiagnosticDetail::ModelHttpError {
                    status: StatusCode::TOO_MANY_REQUESTS,
                    body: body.clone(),
                    model: Some("kimi".into()),
                },
            )
            .await;
            if consent {
                let event = rx.try_recv().unwrap();
                assert_eq!(event["event"], "model_http_error");
                assert_eq!(event["properties"]["http_status"], 429);
                assert_eq!(
                    event["properties"]["response_body"],
                    std::str::from_utf8(&body).unwrap()
                );
            } else {
                assert!(rx.try_recv().is_err());
            }
        }
        server.abort();
    }

    #[test]
    fn upload_requires_both_consents_and_secure_destination() {
        for (general, body, host, accepted) in [
            (true, true, "https://analytics.example", true),
            (false, true, "https://analytics.example", false),
            (true, false, "https://analytics.example", false),
            (true, true, "http://analytics.example", false),
        ] {
            let prefs = json!({
                "telemetryEnabled": general, "detailedTelemetryEnabled": body,
                "detailedTelemetryDestination": {"host": host, "projectKey": "test"}
            });
            assert_eq!(
                destination(prefs.to_string().as_bytes()).is_some(),
                accepted
            );
        }
        assert!(destination(b"{}").is_none());
    }
}
