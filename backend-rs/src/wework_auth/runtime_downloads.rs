// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeDownloads {
    uv_download_base_url: String,
    python_install_mirror: String,
}

impl RuntimeDownloads {
    pub(super) fn from_config(read: impl Fn(&str) -> Option<String>) -> Result<Self, &'static str> {
        Ok(Self {
            uv_download_base_url: directory_url(
                read("WEWORK_UV_DOWNLOAD_BASE_URL"),
                "https://github.com/astral-sh/uv/releases/download/0.9.5/",
            )?,
            python_install_mirror: directory_url(
                read("WEWORK_PYTHON_INSTALL_MIRROR"),
                "https://github.com/astral-sh/python-build-standalone/releases/download/",
            )?,
        })
    }
}

fn directory_url(value: Option<String>, default: &str) -> Result<String, &'static str> {
    let value = value.as_deref().unwrap_or_default().trim();
    let value = if value.is_empty() { default } else { value };
    let mut url = url::Url::parse(value).map_err(|_| "Invalid runtime download URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid runtime download URL");
    }
    url.set_path(&format!("{}/", url.path().trim_end_matches('/')));
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_blank_settings_use_pinned_public_sources() {
        for value in [None, Some("  ".to_string())] {
            let config = RuntimeDownloads::from_config(|_| value.clone()).unwrap();
            assert_eq!(
                serde_json::to_value(config).unwrap(),
                serde_json::json!({
                    "uvDownloadBaseUrl": "https://github.com/astral-sh/uv/releases/download/0.9.5/",
                    "pythonInstallMirror": "https://github.com/astral-sh/python-build-standalone/releases/download/"
                })
            );
        }
    }

    #[test]
    fn deployment_sources_are_trimmed_directory_prefixes() {
        let config = RuntimeDownloads::from_config(|key| {
            Some(
                match key {
                    "WEWORK_UV_DOWNLOAD_BASE_URL" => {
                        " http://minio.example.invalid/bucket/uv/0.9.5 "
                    }
                    _ => "https://mirror.example.invalid/python///",
                }
                .to_string(),
            )
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(config).unwrap(),
            serde_json::json!({
                "uvDownloadBaseUrl": "http://minio.example.invalid/bucket/uv/0.9.5/",
                "pythonInstallMirror": "https://mirror.example.invalid/python/"
            })
        );
    }

    #[test]
    fn rejects_malformed_or_credential_bearing_sources_without_echoing_them() {
        for value in [
            "bad-url",
            "file:///tmp/uv",
            "https://user:secret@example.invalid/",
            "https://example.invalid/?token=secret",
            "https://example.invalid/#fragment",
        ] {
            assert_eq!(
                RuntimeDownloads::from_config(|_| Some(value.into())).unwrap_err(),
                "Invalid runtime download URL"
            );
        }
    }
}
