// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Wiki.js and GitLab adapters use the existing version and locator formats.

use anyhow::{Context, Result, bail};
use base64::Engine;
use brz_mysql::{FromMysqlRow, Json};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

use super::{Content, Identity, error, string};
use crate::AppState;

struct Connection {
    kind: String,
    site: String,
    key: String,
}

pub(super) async fn fetch(
    state: &AppState,
    identity: &Identity,
    metadata_only: bool,
) -> Result<Content> {
    let (connection_id, resource_id, kind) = locator(&identity.external_resource_id)?;
    let connection = connection(state, identity.user_id, &connection_id).await?;
    let mut sync = identity.sync();
    if sync.is_null() && kind.is_none() {
        sync = json!({"enabled":true,"connection_id":connection_id,"resource_id":resource_id});
    }
    validate_identity(&identity.external_resource_id, &sync, &connection.kind)?;
    match connection.kind.as_str() {
        "wikijs" => wikijs(&connection, &sync, &resource_id, metadata_only).await,
        "gitlab_repo" | "gitlab_wiki" => gitlab(&connection, &sync, metadata_only).await,
        _ => Err(error(
            "external_connection_unavailable",
            "Wiki connection adapter is unavailable",
            true,
        )),
    }
}

async fn connection(state: &AppState, owner: i64, id: &str) -> Result<Connection> {
    #[derive(FromMysqlRow)]
    struct Stored {
        json: Json<Value>,
    }
    let row:Stored=state.mysql.fetch_optional("SELECT json FROM kinds WHERE user_id=? AND name=? AND namespace='wiki' AND kind='ExternalSourceConnection' AND is_active=true",(owner,id)).await?
        .ok_or_else(||error("external_connection_unavailable","Wiki connection is unavailable",true))?;
    let spec = &row.json.0["spec"];
    if spec.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Err(error(
            "external_connection_unavailable",
            "Wiki connection is disabled",
            true,
        ));
    }
    let site = string(&spec["config"], "site_url");
    let parsed = url::Url::parse(site.trim()).context("Wiki site URL is invalid")?;
    if !["http", "https"].contains(&parsed.scheme())
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        bail!("Wiki site URL is invalid")
    }
    let encrypted = spec
        .pointer("/credentialsEncrypted/api_key")
        .and_then(Value::as_str)
        .context("Wiki API key is unavailable")?;
    let key =
        crate::subscriptions_item::crypto::decrypt_sensitive_data(encrypted).map_err(|_| {
            error(
                "wiki_auth_failed",
                "Wiki API key could not be decrypted",
                false,
            )
        })?;
    Ok(Connection {
        kind: string(spec, "adapterType"),
        site: site.trim().trim_end_matches('/').into(),
        key,
    })
}

fn locator(value: &str) -> Result<(String, String, Option<String>)> {
    let mut parts = value.splitn(3, ':');
    let version = parts.next();
    let connection = parts
        .next()
        .filter(|v| !v.is_empty())
        .context("External identity has no connection")?;
    let resource = parts
        .next()
        .filter(|v| !v.is_empty())
        .context("External identity has no resource")?;
    match version {
        Some("v1") => Ok((connection.into(), resource.into(), None)),
        Some("v2") => {
            let (kind, digest) = resource
                .split_once(':')
                .context("Invalid external identity")?;
            if !["file", "page"].contains(&kind)
                || digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                bail!("Invalid external identity")
            }
            Ok((connection.into(), digest.into(), Some(kind.into())))
        }
        _ => bail!("Invalid external identity"),
    }
}

fn validate_identity(identity: &str, sync: &Value, adapter: &str) -> Result<()> {
    let (connection, resource, kind) = locator(identity)?;
    if sync.get("enabled").and_then(Value::as_bool) != Some(true)
        || string(sync, "connection_id") != connection
    {
        bail!("Invalid synchronized document metadata")
    }
    let configured = string(sync, "adapter_type");
    if !configured.is_empty() && configured != adapter {
        bail!("Synchronized document adapter changed")
    }
    if let Some(kind) = kind {
        let project = string(sync, "project_path");
        let path = string(sync, "path");
        let branch = string(sync, "branch");
        let expected = match adapter {
            "gitlab_repo" if kind == "file" && !branch.is_empty() => json!([project, branch, path]),
            "gitlab_wiki" if kind == "page" && branch.is_empty() => json!([project, path]),
            _ => bail!("Invalid synchronized document adapter metadata"),
        };
        let key = string(sync, "resource_key");
        if project.is_empty()
            || path.is_empty()
            || string(sync, "resource_kind") != kind
            || string(sync, "resource_id") != path
            || serde_json::from_str::<Value>(&key).ok() != Some(expected)
            || format!("{:x}", Sha256::digest(key.as_bytes())) != resource
        {
            bail!("Invalid synchronized document identity")
        }
    } else if string(sync, "resource_id") != resource {
        bail!("Synchronized resource identity changed")
    }
    Ok(())
}

async fn request(
    connection: &Connection,
    path: &str,
    body: Option<Value>,
) -> Result<Option<Value>> {
    let http = super::http()?;
    for attempt in 0..3 {
        let url = format!("{}{path}", connection.site);
        let request = if let Some(body) = body.as_ref() {
            http.as_reqwest()
                .post(&url)
                .bearer_auth(&connection.key)
                .json(body)
        } else {
            http.as_reqwest()
                .get(&url)
                .header("PRIVATE-TOKEN", &connection.key)
        };
        let response = match request.send().await {
            Ok(response) => response,
            Err(_) if attempt < 2 => {
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                continue;
            }
            Err(_) => {
                return Err(error(
                    "wiki_unreachable",
                    "Wiki site could not be reached",
                    true,
                ));
            }
        };
        match response.status().as_u16() {
            404 => return Ok(None),
            401 => {
                return Err(error(
                    "wiki_auth_failed",
                    "Wiki rejected the configured credential",
                    false,
                ));
            }
            403 => {
                return Err(error(
                    "wiki_page_forbidden",
                    "Access to the Wiki document was denied",
                    false,
                ));
            }
            429 | 500..=599 if attempt < 2 => {
                tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                continue;
            }
            429 => {
                return Err(error(
                    "external_rate_limited",
                    "Wiki site rate limit exceeded",
                    true,
                ));
            }
            300..=399 => {
                return Err(error(
                    "upstream_error",
                    "Wiki site returned an unexpected redirect",
                    false,
                ));
            }
            400..=599 => {
                return Err(error(
                    "upstream_error",
                    "Wiki site rejected the request",
                    true,
                ));
            }
            _ => {}
        }
        return Ok(Some(serde_json::from_slice(
            &super::bounded_body(response, super::max_bytes().saturating_mul(2)).await?,
        )?));
    }
    unreachable!("bounded request loop returns on its last attempt")
}

async fn wikijs(
    connection: &Connection,
    sync: &Value,
    resource: &str,
    metadata_only: bool,
) -> Result<Content> {
    let id = resource
        .parse::<i64>()
        .context("Wiki page id must be an integer")?;
    let mut fields = "id path title description updatedAt locale tags { id tag title }".to_owned();
    if !metadata_only {
        fields.push_str(" content render");
    }
    let mut payload=request(connection,"/graphql",Some(json!({"query":format!("query ($id: Int!) {{ pages {{ single(id: $id) {{ {fields} }} }} }}"),"variables":{"id":id}}))).await?.context("Wiki site is unavailable")?;
    if let Some(errors) = payload.get("errors").and_then(Value::as_array) {
        let missing = errors.iter().any(|e| {
            e["message"]
                .as_str()
                .is_some_and(|v| v.to_lowercase().contains("not found"))
        });
        if missing {
            return Err(error(
                "external_source_missing",
                "Wiki source document does not exist",
                true,
            ));
        }
        let source_denied = errors.iter().any(|e| {
            e["path"]
                .as_array()
                .is_some_and(|parts| parts.iter().any(|v| v == "content"))
                || e["message"]
                    .as_str()
                    .is_some_and(|v| v.contains("read:source"))
        });
        if source_denied && !metadata_only {
            payload=request(connection,"/graphql",Some(json!({"query":"query ($id: Int!) { pages { single(id: $id) { id path title description updatedAt locale render tags { id tag title } } } }","variables":{"id":id}}))).await?.context("Wiki site is unavailable")?;
        } else {
            return Err(error(
                "wiki_page_forbidden",
                "Wiki document could not be read",
                false,
            ));
        }
    }
    let node = payload
        .pointer("/data/pages/single")
        .filter(|node| node.is_object())
        .ok_or_else(|| {
            error(
                "external_source_missing",
                "Wiki source document does not exist",
                true,
            )
        })?;
    let path = string(node, "path");
    let name = string(node, "title");
    let version = string(node, "updatedAt");
    let content = if metadata_only {
        String::new()
    } else {
        let source = string(node, "content");
        if !source.trim().is_empty() {
            source
        } else {
            rendered_markdown(&string(node, "render"), &connection.site)?
        }
    };
    let mut sync = sync.as_object().cloned().unwrap_or_default();
    sync.insert("adapter_type".into(), "wikijs".into());
    sync.insert("path".into(), path.clone().into());
    sync.insert("locale".into(), string(node, "locale").into());
    sync.insert("resource_kind".into(), "page".into());
    sync.insert("resource_key".into(), resource.into());
    sync.insert("file_extension".into(), "md".into());
    sync.insert("site_url".into(), connection.site.clone().into());
    sync.insert(
        "observed_version".into(),
        if version.is_empty() {
            Value::Null
        } else {
            version.clone().into()
        },
    );
    if !metadata_only {
        sync.insert("content_version".into(), version.into());
    }
    let metadata = json!({"provider":"wiki","title":name,"path":path,"url":format!("{}/{}",connection.site,path.trim_start_matches('/')),"sync":sync});
    Ok(Content {
        name,
        extension: "md".into(),
        bytes: content.into_bytes(),
        metadata: metadata.as_object().cloned().unwrap_or_default(),
    })
}

async fn gitlab(connection: &Connection, sync: &Value, metadata_only: bool) -> Result<Content> {
    let project = string(sync, "project_path");
    let path = string(sync, "path");
    let branch = string(sync, "branch");
    let encode =
        |value: &str| url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>();
    let endpoint = if connection.kind == "gitlab_repo" {
        format!(
            "/api/v4/projects/{}/repository/files/{}?ref={}",
            encode(&project),
            encode(&path),
            encode(&branch)
        )
    } else {
        format!(
            "/api/v4/projects/{}/wikis/{}",
            encode(&project),
            encode(&path)
        )
    };
    let node = request(connection, &endpoint, None).await?.ok_or_else(|| {
        error(
            "external_source_missing",
            "Wiki source document does not exist",
            true,
        )
    })?;
    let (name, extension, bytes, version, url) = if connection.kind == "gitlab_repo" {
        let name = string(&node, "file_name");
        let extension = name
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_lowercase())
            .unwrap_or_default();
        let body = string(&node, "content");
        let bytes = if metadata_only {
            vec![]
        } else {
            base64::engine::general_purpose::STANDARD
                .decode(body.split_whitespace().collect::<String>())?
        };
        (
            name,
            extension,
            bytes,
            string(&node, "blob_id"),
            format!(
                "{}/{project}/-/blob/{}/{path}",
                connection.site,
                encode(&branch)
            ),
        )
    } else {
        let content = string(&node, "content");
        let name = string(&node, "title");
        let format = string(&node, "format");
        let version = format!(
            "{:x}",
            Sha256::digest(format!("{name}\0{format}\0{content}").as_bytes())
        );
        let extension = match format.as_str() {
            "markdown" => "md",
            "asciidoc" => "adoc",
            _ => "txt",
        }
        .into();
        (
            name,
            extension,
            if metadata_only {
                vec![]
            } else {
                content.into_bytes()
            },
            version,
            format!("{}/{project}/-/wikis/{path}", connection.site),
        )
    };
    if !metadata_only && (bytes.is_empty() || bytes.len() > super::max_bytes()) {
        return Err(error(
            "external_file_too_large",
            "Wiki source file is empty or exceeds the document size limit",
            false,
        ));
    }
    let mut sync = sync
        .as_object()
        .cloned()
        .context("Wiki sync metadata is invalid")?;
    sync.insert("observed_version".into(), version.clone().into());
    sync.insert("file_extension".into(), extension.clone().into());
    if !metadata_only {
        sync.insert("content_version".into(), version.into());
    }
    let metadata = json!({"provider":"wiki","title":name,"path":path,"url":url,"sync":sync});
    Ok(Content {
        name,
        extension,
        bytes,
        metadata: metadata.as_object().cloned().unwrap_or_default(),
    })
}

fn rendered_markdown(html: &str, site: &str) -> Result<String> {
    let base = url::Url::parse(site)?;
    let converter = htmd::HtmlToMarkdown::builder()
        .skip_tags(vec!["script", "style", "noscript", "img"])
        .add_handler(
            vec!["a"],
            move |handlers: &dyn htmd::element_handler::Handlers, element: htmd::Element<'_>| {
                let content = handlers.walk_children(element.node).content;
                let Some(href) = element
                    .attrs
                    .iter()
                    .find(|attr| attr.name.local.as_ref() == "href")
                else {
                    return Some(content.into());
                };
                let href = base
                    .join(&href.value)
                    .map(|url| url.to_string())
                    .unwrap_or_else(|_| href.value.to_string());
                let href = href.replace('(', "%28").replace(')', "%29");
                let title = element
                    .attrs
                    .iter()
                    .find(|attr| attr.name.local.as_ref() == "title")
                    .map(|attr| format!(" \"{}\"", attr.value.replace('"', "\\\"")))
                    .unwrap_or_default();
                Some(format!("[{content}]({href}{title})").into())
            },
        )
        .build();
    Ok(converter.convert(html)?.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_pages_keep_links_and_structure_without_active_content() {
        let markdown = rendered_markdown(
            "<h1>Title</h1><p><a href='/docs'>Read</a><img src='x'></p><script>secret()</script>",
            "https://example.test",
        )
        .unwrap();
        assert!(markdown.contains("# Title"));
        assert!(markdown.contains("[Read](https://example.test/docs)"));
        assert!(!markdown.contains("secret"));
        assert!(!markdown.contains("!["));
    }
    #[test]
    fn locator_binding_rejects_cross_connection_and_changed_v2_resource() {
        let key = "[\"p\",\"main\",\"a.md\"]";
        let id = format!("v2:c:file:{:x}", Sha256::digest(key.as_bytes()));
        let sync = json!({"enabled":true,"connection_id":"c","adapter_type":"gitlab_repo","resource_kind":"file","resource_id":"a.md","resource_key":key,"path":"a.md","project_path":"p","branch":"main"});
        assert!(validate_identity(&id, &sync, "gitlab_repo").is_ok());
        let mut changed = sync.clone();
        changed["path"] = "b.md".into();
        assert!(validate_identity(&id, &changed, "gitlab_repo").is_err());
        assert!(
            validate_identity(
                "v1:other:4",
                &json!({"enabled":true,"connection_id":"c","resource_id":"4"}),
                "wikijs"
            )
            .is_err()
        );
    }
}
