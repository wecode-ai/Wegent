// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route configuration loading for the hybrid listener.
//!
//! The route table is compiled once at startup by `brz-http-gateway` and is
//! shared by all requests. Paths containing `:name` or a terminal `*name`
//! are templates; every other path is exact.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::{BoxError, ExclusionRule, RouteRule, RouteTable, RoutesConfig};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    #[serde(default)]
    include: Vec<PathBuf>,
    #[serde(default)]
    routes: Vec<RouteRule>,
    #[serde(default)]
    exclude: Vec<ExclusionRule>,
}

pub(super) fn load(path: &Path) -> Result<RouteTable, BoxError> {
    Ok(RouteTable::compile(load_routes_config(path)?)?)
}

/// Loads route selection and exclusion rules, including child files.
///
/// # Errors
/// Returns an error for unreadable, invalid, cyclic or repeated route files.
pub fn load_routes_config(path: &Path) -> Result<RoutesConfig, BoxError> {
    let mut seen = HashSet::new();
    let mut config = RoutesConfig::default();
    load_rules(path, &mut seen, &mut config)?;
    Ok(config)
}

fn load_rules(
    path: &Path,
    seen: &mut HashSet<PathBuf>,
    rules: &mut RoutesConfig,
) -> Result<(), BoxError> {
    let canonical = path.canonicalize()?;
    if !seen.insert(canonical.clone()) {
        return Err(format!("route config included more than once: {}", path.display()).into());
    }
    let source = std::fs::read_to_string(&canonical)?;
    let config: FileConfig = toml::from_str(&source)?;
    for include in config.include {
        let child = canonical
            .parent()
            .expect("canonical file has a parent")
            .join(include);
        load_rules(&child, seen, rules)?;
    }
    rules.routes.extend(config.routes);
    rules.exclude.extend(config.exclude);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::Method;
    use std::collections::BTreeSet;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "wegent-route-exclusions-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn includes_preserve_exclusions_from_both_parent_and_child_files() {
        let fixture = Fixture::new();
        let root = fixture.0.join("routes.toml");
        std::fs::write(
            &root,
            "include = [\"child.toml\"]\n[[routes]]\npath = \"/api/*path\"\n\
             [[exclude]]\npath = \"/api/private\"",
        )
        .unwrap();
        std::fs::write(
            fixture.0.join("child.toml"),
            "[[routes]]\npath = \"/health\"\n\
             [[exclude]]\nmethods = [\"GET\"]\npath = \"/api/events\"",
        )
        .unwrap();
        let config = load_routes_config(&root).unwrap();
        assert_eq!(config.routes.len(), 2);
        assert_eq!(config.exclude.len(), 2);
        let table = load(&root).unwrap();
        assert!(!table.matches(&Method::GET, "/api/events"));
        assert!(table.matches(&Method::POST, "/api/events"));
        assert!(!table.matches(&Method::POST, "/api/private"));
        assert!(table.matches(&Method::GET, "/health"));
        assert!(table.matches(&Method::GET, "/api/other"));
    }

    #[test]
    fn invalid_exclusions_in_included_files_fail_loading() {
        let fixture = Fixture::new();
        let root = fixture.0.join("routes.toml");
        std::fs::write(&root, "include = [\"child.toml\"]").unwrap();
        for source in [
            "[[exclude]]\nmethods = [\"BAD METHOD\"]\npath = \"/api/events\"",
            "[[exclude]]\npath = \"/api/*path/child\"",
            "[[exclude]]\npath = \"/api/events\"\nadmission = {}",
        ] {
            std::fs::write(fixture.0.join("child.toml"), source).unwrap();
            assert!(load(&root).is_err());
        }
    }

    #[test]
    fn public_route_file_selects_all_configured_methods() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let source = std::fs::read_to_string(&path).unwrap();
        let file: FileConfig = toml::from_str(&source).unwrap();
        assert!(file.include.is_empty());
        assert!(!file.routes.is_empty());
        assert!(file.routes.iter().all(|rule| !rule.methods.is_empty()));
        let table = load(&path).unwrap();
        let selected: BTreeSet<_> = file
            .routes
            .iter()
            .flat_map(|rule| {
                rule.methods
                    .iter()
                    .map(move |method| (method.to_owned(), rule.path.clone()))
            })
            .collect();
        assert_eq!(
            selected.len(),
            file.routes
                .iter()
                .map(|rule| rule.methods.len())
                .sum::<usize>(),
            "duplicate cutover rule"
        );
        assert!(selected.contains(&("GET".to_owned(), "/api/quota".to_owned())));
        assert!(selected.contains(&("GET".to_owned(), "/api/quota/*path".to_owned())));
        let mut registered = BTreeSet::new();
        const METHODS: [&str; 7] = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
        macro_rules! collect {
            ($group:ident) => {
                for entry in brz_http_server::__private::inventory::iter::<crate::$group::Entry> {
                    for route in (entry.0.routes)() {
                        for (bit, method) in METHODS.into_iter().enumerate() {
                            if route.methods & (1 << bit) != 0 {
                                registered.insert((method.to_owned(), route.path.to_owned()));
                            }
                        }
                    }
                }
            };
        }
        collect!(__http_registry_http_apis);
        collect!(__http_registry_runtime_check);
        collect!(__http_registry_models_unified);
        collect!(__http_registry_remote_workspace_status);
        collect!(__http_registry_remote_workspace_tree);
        // The LLM proxy route forwards dynamic `x-wegent-upstream-header-*`
        // headers through a hand-written handler merged into the router, so it
        // is not discoverable through the macro inventory.
        registered.insert(("POST".to_owned(), crate::llm_proxy::ROUTE_PATH.to_owned()));
        assert!(selected.is_subset(&registered));
        let custom = Method::from_bytes(b"CUSTOM").unwrap();
        for (method, path) in &selected {
            let concrete = path
                .split('/')
                .map(|segment| {
                    if segment.starts_with(':') || segment.starts_with('*') {
                        "123"
                    } else {
                        segment
                    }
                })
                .collect::<Vec<_>>()
                .join("/");
            let method = Method::from_bytes(method.as_bytes()).unwrap();
            assert!(table.matches(&method, &concrete), "{method} {path}");
            assert!(!table.matches(&custom, &concrete));
            for sibling in METHODS {
                let expected = selected.iter().any(|(configured_method, configured_path)| {
                    configured_method == sibling
                        && brz_http_server::__private::match_route(&concrete, configured_path)
                            .is_some()
                });
                let sibling = Method::from_bytes(sibling.as_bytes()).unwrap();
                assert_eq!(
                    table.matches(&sibling, &concrete),
                    expected,
                    "{sibling} {path}"
                );
            }
        }
        // The cancel sibling is still a Python fallback.
        assert!(!table.matches(&Method::POST, "/api/v1/responses/resp_123/cancel"));
        assert!(!table.matches(&Method::GET, "/api/groups/engineering/members"));
        assert!(!table.matches(&Method::PUT, "/api/groups/engineering/members/batch/roles"));
        assert!(!table.matches(&Method::GET, "/api/tasks/123/unmigrated"));
    }

    /// The doubled-prefix skills download cutover must keep its Rust handler
    /// registered while every other method stays on the Python fallback.
    #[test]
    fn doubled_prefix_skills_download_selects_registered_handler() {
        const PATH: &str = "/api/api/v1/kinds/skills/:skill_id/download";
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = load(&path).unwrap();
        let concrete = "/api/api/v1/kinds/skills/125063/download";
        assert!(table.matches(&Method::GET, concrete));
        for other_method in [
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::HEAD,
            Method::OPTIONS,
        ] {
            assert!(
                !table.matches(&other_method, concrete),
                "unmigrated method selected: {other_method} {concrete}"
            );
        }

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }

    #[test]
    fn metrics_handler_is_registered_without_changing_release_ownership() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = load(&path).unwrap();
        assert!(!table.matches(&Method::GET, "/metrics"));
        assert!(!table.matches(&Method::POST, "/metrics"));
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == "/metrics" && route.methods & (1 << 1) != 0);
        assert!(
            registered,
            "GET /metrics must be registered in the shared group"
        );
    }

    /// The `GET /api/v1/kinds/skills/unified` cutover must serve only the
    /// recorded GET method and keep the handler registered.
    #[test]
    fn skills_unified_cutover_selects_registered_handler() {
        const PATH: &str = "/api/v1/kinds/skills/unified";
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = load(&path).unwrap();
        assert!(table.matches(&Method::GET, PATH));
        for other_method in [
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::HEAD,
            Method::OPTIONS,
        ] {
            assert!(
                !table.matches(&other_method, PATH),
                "unmigrated method selected: {other_method} {PATH}"
            );
        }

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }

    /// Both content methods stay Python-owned while their Rust handlers remain.
    #[test]
    fn knowledge_document_content_put_registration_keeps_python_ownership() {
        const PATH: &str = "/api/knowledge/documents/:document_id/content";
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = load(&path).unwrap();
        let concrete = "/api/knowledge/documents/43199/content";
        assert!(!table.matches(&Method::GET, concrete));
        assert!(!table.matches(&Method::PUT, concrete));
        assert!(!table.matches(&Method::POST, concrete));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const PUT: u16 = 1 << 6;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & PUT != 0);
        assert!(registered, "PUT {PATH} must be registered by the router");
    }

    /// A low-volume scanner probe keeps Python ownership even with a registered handler.
    #[test]
    fn method_call_anon_get_policy_registration_keeps_python_ownership() {
        const PATH: &str = "/api/v1/method.callAnon/getPasswordPolicy";
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = load(&path).unwrap();
        assert!(!table.matches(&Method::POST, PATH));
        for other_method in [
            Method::GET,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::HEAD,
            Method::OPTIONS,
        ] {
            assert!(
                !table.matches(&other_method, PATH),
                "unmigrated method selected: {other_method} {PATH}"
            );
        }

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");
    }

    /// A low-volume scanner probe keeps Python ownership even with a registered handler.
    #[test]
    fn method_call_anon_send_forgot_email_registration_keeps_python_ownership() {
        const PATH: &str = "/api/v1/method.callAnon/sendForgotPasswordEmail";
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = load(&path).unwrap();
        assert!(!table.matches(&Method::POST, PATH));
        for other_method in [
            Method::GET,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::HEAD,
            Method::OPTIONS,
        ] {
            assert!(
                !table.matches(&other_method, PATH),
                "unmigrated method selected: {other_method} {PATH}"
            );
        }

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");
    }
    #[test]
    fn deferred_routes_keep_python_ownership() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = load(&path).unwrap();
        assert!(!table.matches(&Method::GET, "/api/knowledge-bases/123"));
        assert!(table.matches(&Method::GET, "/api/teams/default"));
        assert!(table.matches(&Method::GET, "/api/sites/app-types"));
        for path in [
            "/api/knowledge-bases/accessible",
            "/api/knowledge-bases/all-grouped",
            "/api/knowledge-bases/code-wiki-retrieval-profile",
            "/api/knowledge-bases/code-wikis",
            "/api/knowledge-bases/config",
            "/api/knowledge-bases/multimodal-default-prompts",
            "/api/knowledge-bases/organization-namespace",
            "/api/subscriptions/executions",
            "/api/tasks/123/remote-workspace/file",
        ] {
            assert!(!table.matches(&Method::GET, path), "deferred GET {path}");
        }
        assert!(!table.matches(&Method::DELETE, "/api/tasks/123"));
        assert!(!table.matches(&Method::DELETE, "/api/tasks/bulk"));
        assert!(!table.matches(&Method::PUT, "/api/users/me"));
    }

    #[test]
    fn knowledge_routes_keep_registered_handlers_without_cutover() {
        const PREFIXES: [&str; 8] = [
            "/api/knowledge-bases",
            "/api/knowledge",
            "/api/mcp/knowledge",
            "/api/mcp/knowledge-external",
            "/api/share/KnowledgeBase",
            "/api/wiki",
            "/api/dingtalk-wikispace",
            "/api/admin/public-retrievers",
        ];
        let in_scope = |path: &str| {
            PREFIXES.iter().any(|prefix| {
                path == *prefix
                    || path
                        .strip_prefix(prefix)
                        .is_some_and(|tail| tail.starts_with('/'))
            })
        };
        assert!(!in_scope("/api/knowledge-documents/123"));
        assert!(!in_scope("/api/knowledge-bases-other"));
        assert!(!in_scope("/api/mcp/knowledge-external-other"));
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = load_routes_config(&path).unwrap();
        assert!(config.routes.iter().all(|rule| !in_scope(&rule.path)));
        let table = load(&path).unwrap();
        let registered: BTreeSet<_> =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .filter(|route| in_scope(route.path) && route.methods & (1 << 1) != 0)
                .map(|route| route.path.to_owned())
                .collect();
        for path in [
            "/api/knowledge-bases/:knowledge_base_id/document-protection",
            "/api/knowledge-bases/:knowledge_base_id/artifacts",
            "/api/knowledge/documents",
            "/api/knowledge/documents/:document_id/content",
            "/api/knowledge-bases/:kb_id/documents/:doc_id/detail",
            "/api/knowledge-bases/:knowledge_base_id/folders",
            "/api/mcp/knowledge-external/documents/:document_id/file",
            "/api/share/KnowledgeBase/:resource_id/my-permission",
            "/api/wiki/connections",
        ] {
            assert!(registered.contains(path), "Rust handler lost: GET {path}");
        }
        for path in registered.iter().map(String::as_str).chain(PREFIXES) {
            let concrete = path
                .split('/')
                .map(|part| if part.starts_with(':') { "123" } else { part })
                .collect::<Vec<_>>()
                .join("/");
            for method in [
                Method::GET,
                Method::HEAD,
                Method::POST,
                Method::PUT,
                Method::PATCH,
                Method::DELETE,
                Method::OPTIONS,
            ] {
                assert!(!table.matches(&method, &concrete), "{method} {path}");
            }
        }
        // Existing non-knowledge cutovers keep the same method selection.
        assert!(table.matches(&Method::GET, "/api/users/me"));
        assert!(table.matches(&Method::PUT, "/api/runtime-work/im-notifications/presence"));
        assert!(!table.matches(&Method::POST, "/api/users/me"));
    }
}
