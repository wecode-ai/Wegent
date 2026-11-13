//! Assemble administrator-managed connector capabilities for execution.
//!
//! Read only the catalog and the caller's grants here. The MCP endpoint checks
//! authorization again and owns upstream discovery, refresh, and invocation.
use brz_mysql::Mysql;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

use super::dispatch::ExecutionRequest;
use crate::apps_installed::{db, service};
use crate::http_compat::FastApiError;

#[derive(Default, Deserialize)]
struct Keywords {
    #[serde(default, deserialize_with = "brz_json::adapters::null_as_default")]
    keywords: Vec<String>,
}

#[derive(Default, Deserialize)]
struct AppDocument {
    #[serde(default)]
    spec: Option<Keywords>,
}

struct App {
    config: service::ConnectorApp,
    keywords: Vec<String>,
    available: bool,
}

pub(super) async fn attach<M: Mysql>(
    mysql: &M,
    request: &mut ExecutionRequest,
    has_local_device: bool,
) -> Result<(), FastApiError> {
    let shell = request.bot[0]["shell_type"].as_str().unwrap_or("Chat");
    if !matches!(shell, "Chat" | "Codex" | "ClaudeCode") || request.auth_token.is_empty() {
        return Ok(());
    }
    let rows = db::list_connector_app_kinds(mysql)
        .await
        .map_err(super::request::dependency)?;
    if rows.is_empty() {
        return Ok(());
    }
    let user = db::find_user_by_id_and_name(mysql, request.user_id, &request.user_name)
        .await
        .map_err(super::request::dependency)?
        .filter(|user| user.users_is_active)
        .ok_or_else(FastApiError::internal)?;
    let mut apps = Vec::new();
    for row in rows {
        let config = service::row_to_app(&row);
        if !config.enabled
            || (config.visibility != "all" && !config.allowed_roles.contains(&user.users_role))
        {
            continue;
        }
        let available = service::app_connected(mysql, &config, request.user_id)
            .await
            .map_err(super::request::dependency)?;
        let keywords = row
            .kinds_json
            .0
            .project::<AppDocument>()
            .and_then(|doc| doc.spec)
            .unwrap_or_default()
            .keywords;
        apps.push(App {
            config,
            keywords,
            available,
        });
    }
    assemble(request, &apps, has_local_device);
    tracing::info!(
        user_id = request.user_id,
        visible_apps = apps.len(),
        available_apps = apps.iter().filter(|app| app.available).count(),
        has_local_device,
        "connector execution capabilities assembled"
    );
    Ok(())
}

fn assemble(request: &mut ExecutionRequest, apps: &[App], has_local_device: bool) {
    let shell = request.bot[0]["shell_type"]
        .as_str()
        .unwrap_or("Chat")
        .to_owned();
    let chat = shell == "Chat";
    let message = prompt_text(&request.prompt).to_lowercase();
    let selected: HashSet<String> = request
        .preload_skills
        .iter()
        .chain(&request.user_selected_skills)
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    let explicit = update_provider_skills(request, apps, &selected, has_local_device);
    let available: Vec<_> = apps.iter().filter(|app| app.available).collect();
    if chat || !has_local_device {
        if available
            .iter()
            .any(|app| app.config.tool_loading_mode == "static")
        {
            add_server(
                request,
                server(request, "wegent-connectors", None, false, chat),
                chat,
            );
        }
        for app in available
            .iter()
            .filter(|app| app.config.tool_loading_mode == "lazy")
        {
            if explicit.contains(&app.config.slug) {
                continue;
            }
            let name = format!("wegent-connector-{}", app.config.slug);
            let matched = keywords_match(&message, &app.keywords);
            let scoped = server(
                request,
                &name,
                Some(&app.config.slug),
                !chat && !matched,
                chat,
            );
            if chat {
                let mut skill = lazy_skill(&app.config);
                if matched {
                    add_server(request, scoped, true);
                    if !request.preload_skills.contains(&json!(name)) {
                        request.preload_skills.push(json!(name));
                    }
                } else {
                    skill["mcpServers"] =
                        json!({(name.clone()): skill_server(request, &app.config.slug)});
                }
                if !request.skill_names.contains(&json!(name)) {
                    request.skill_names.push(json!(name));
                    request.skill_configs.push(skill);
                }
            } else {
                add_server(request, scoped, false);
            }
        }
    }
    append_guidance(request, apps, &message, &selected);
}

fn update_provider_skills(
    request: &mut ExecutionRequest,
    apps: &[App],
    selected: &HashSet<String>,
    local: bool,
) -> HashSet<String> {
    let mut explicit = HashSet::new();
    let coding = request.bot[0]["shell_type"] != "Chat";
    let token = if coding {
        "${{task_token}}".into()
    } else {
        request.auth_token.clone()
    };
    let connector_url = if coding {
        "${{backend_api_url}}/mcp/connectors/sse".into()
    } else {
        connector_mcp_url(&request.backend_url)
    };
    for skill in &mut request.skill_configs {
        let Some(slug) = skill["connector_slug"].as_str().map(str::to_owned) else {
            continue;
        };
        let app = apps
            .iter()
            .find(|app| app.config.slug == slug && app.available);
        let available = app.is_some();
        skill["connector_available"] = json!(available);
        if available {
            skill.as_object_mut().unwrap().remove("mcpServers");
            if !local
                && selected.contains(skill["name"].as_str().unwrap_or(""))
                && app.is_some_and(|app| app.config.tool_loading_mode == "lazy")
            {
                skill["mcpServers"] = json!({
                    (format!("wegent-connector-{slug}")): scoped_skill_server(&connector_url, &token, &slug)
                });
                explicit.insert(slug);
            }
        }
    }
    explicit
}

fn server(
    request: &ExecutionRequest,
    name: &str,
    slug: Option<&str>,
    lazy: bool,
    chat: bool,
) -> Value {
    let mut headers = json!({"Authorization": if chat {
        format!("Bearer {}", request.auth_token)
    } else { "Bearer ${{task_token}}".into() }});
    if let Some(slug) = slug {
        headers["X-Connector-App"] = json!(slug);
    }
    if lazy {
        headers["X-Connector-Loading"] = json!("lazy");
    }
    let mut entry = json!({
        "name": name,
        "type": "streamable-http",
        "url": if chat { connector_mcp_url(&request.backend_url) } else { "${{backend_api_url}}/mcp/connectors/sse".into() },
        "timeout": 180
    });
    entry[if chat { "auth" } else { "headers" }] = headers;
    entry
}

/// The connector MCP endpoint on the backend that owns it.
///
/// Chat receives concrete URLs; coding uses the normalized runtime API context
/// so the executor can rebind the backend for its own network position.
fn connector_mcp_url(backend: &str) -> String {
    let base = backend.trim_end_matches('/');
    let root = base.strip_suffix("/api").unwrap_or(base);
    format!("{root}/api/mcp/connectors/sse")
}

fn skill_server(request: &ExecutionRequest, slug: &str) -> Value {
    scoped_skill_server(
        &connector_mcp_url(&request.backend_url),
        &request.auth_token,
        slug,
    )
}

fn scoped_skill_server(url: &str, token: &str, slug: &str) -> Value {
    json!({
        "type": "streamable-http",
        "url": url,
        "headers": {"Authorization": format!("Bearer {token}"), "X-Connector-App": slug},
        "timeout": 180
    })
}

fn add_server(request: &mut ExecutionRequest, server: Value, chat: bool) {
    if chat {
        if !request
            .mcp_servers
            .iter()
            .any(|entry| entry["name"] == server["name"])
        {
            request.mcp_servers.push(server);
        }
        return;
    }
    let mut servers = request.bot[0]["mcp_servers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let scope = server["headers"]["X-Connector-App"].as_str();
    if !servers.iter().any(|entry| {
        entry["name"] == server["name"]
            || (scope.is_some() && entry["headers"]["X-Connector-App"].as_str() == scope)
    }) {
        servers.push(server);
    }
    request.bot[0]["mcp_servers"] = json!(servers);
}

fn lazy_skill(app: &service::ConnectorApp) -> Value {
    let name = &app.name;
    let slug = &app.slug;
    json!({
        "name": format!("wegent-connector-{slug}"),
        "displayName": name,
        "description": format!("Use the administrator-managed {name} connector app. {}", app.description),
        "prompt": format!(
            "# Connector app: {name}\n\nUse the tools exposed for `{slug}` and their declared JSON argument types. \
             Authentication is managed by Wegent. Never request or expose credentials. If a tool reports \
             `connector_auth_required`, or the tool list is empty or missing, tell the user to authorize with \
             [打开 {name} 授权](wegent://modal/connector-oauth?slug={slug})."
        )
    })
}

fn prompt_text(prompt: &Value) -> String {
    if let Some(text) = prompt.as_str() {
        return text.to_owned();
    }
    prompt
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| matches!(part["type"].as_str(), Some("text" | "input_text")))
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn keywords_match(text: &str, keywords: &[String]) -> bool {
    keywords.iter().any(|keyword| {
        let lower = keyword.to_lowercase();
        let terms: Vec<_> = lower.split_whitespace().collect();
        !terms.is_empty() && terms.iter().all(|term| text.contains(term))
    })
}

fn append_guidance(
    request: &mut ExecutionRequest,
    apps: &[App],
    message: &str,
    selected: &HashSet<String>,
) {
    let selected_slugs: HashSet<_> = request
        .skill_configs
        .iter()
        .filter(|skill| selected.contains(skill["name"].as_str().unwrap_or("")))
        .filter_map(|skill| skill["connector_slug"].as_str())
        .collect();
    let personal_slugs: HashSet<_> = request
        .skill_configs
        .iter()
        .filter(|skill| skill.get("mcpServers").is_some())
        .filter_map(|skill| skill["connector_slug"].as_str())
        .collect();
    let pending: Vec<_> = apps
        .iter()
        .filter(|app| {
            !app.available
                && !personal_slugs.contains(app.config.slug.as_str())
                && (app.config.tool_loading_mode == "static"
                    || selected_slugs.contains(app.config.slug.as_str())
                    || message.contains(&app.config.slug.to_lowercase())
                    || message.contains(&app.config.name.to_lowercase())
                    || keywords_match(message, &app.keywords))
        })
        .collect();
    let in_use = apps.iter().any(|app| {
        app.available
            && (app.config.tool_loading_mode == "static"
                || selected_slugs.contains(app.config.slug.as_str())
                || message.contains(&app.config.slug.to_lowercase())
                || message.contains(&app.config.name.to_lowercase())
                || keywords_match(message, &app.keywords))
    });
    if pending.is_empty() && !in_use {
        return;
    }
    let links = pending
        .iter()
        .map(|app| {
            format!(
                "- {} (`{}`): [打开 {} 授权](wegent://modal/connector-oauth?slug={})",
                app.config.name, app.config.slug, app.config.name, app.config.slug
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let authorization = if links.is_empty() {
        String::new()
    } else {
        format!(
            "## Connector apps\n\nThese apps need authorization before their tools are available:\n\
         {links}\n\nDo not claim access before authorization. When needed, repeat the authorization link. \
         Never request or expose credentials. After authorization, continue the original task."
        )
    };
    let link_rules = if in_use {
        "\n\n## Connector tool links\n\nPresent links exactly as returned by the tool. \
         Never decode deep links, derive another URL, or invent a web version. \
         If asked for a web link, explain that the upstream publishes only the returned link."
    } else {
        ""
    };
    let block =
        format!("<wegent_connector_apps>\n{authorization}{link_rules}\n</wegent_connector_apps>");
    if let Some(text) = request.prompt.as_str() {
        request.prompt = json!(format!("{text}\n\n{block}"));
    } else if let Some(parts) = request.prompt.as_array_mut() {
        parts.push(json!({"type": "text", "text": block}));
    }
}

#[cfg(test)]
#[path = "connectors_tests.rs"]
mod tests;
