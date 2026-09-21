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

use crate::{BoxError, RouteRule, RouteTable, RoutesConfig};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    #[serde(default)]
    include: Vec<PathBuf>,
    #[serde(default)]
    routes: Vec<RouteRule>,
}

pub(super) fn load(path: &Path) -> Result<RouteTable, BoxError> {
    let mut seen = HashSet::new();
    let mut rules = Vec::new();
    load_rules(path, &mut seen, &mut rules)?;
    Ok(RouteTable::compile(RoutesConfig { routes: rules })?)
}

fn load_rules(
    path: &Path,
    seen: &mut HashSet<PathBuf>,
    rules: &mut Vec<RouteRule>,
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
    rules.extend(config.routes);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::Method;
    use std::collections::BTreeSet;

    #[test]
    fn public_cutover_file_selects_only_reviewed_registered_apis() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let source = std::fs::read_to_string(&path).unwrap();
        let file: FileConfig = toml::from_str(&source).unwrap();
        assert!(file.include.is_empty());

        let selected: BTreeSet<_> = file
            .routes
            .iter()
            .flat_map(|rule| {
                rule.methods
                    .iter()
                    .map(move |method| (method.to_owned(), rule.path.clone()))
            })
            .collect();
        assert_eq!(selected.len(), file.routes.len(), "duplicate cutover rule");

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
        assert!(selected.is_subset(&registered));
        assert!(selected.contains(&("GET".to_owned(), "/api/quota".to_owned())));
        assert!(selected.contains(&("GET".to_owned(), "/api/quota/*path".to_owned())));

        let table = load(&path).unwrap();
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
            assert!(
                table.matches(&method, &concrete),
                "cutover rule failed to match {method} {path}"
            );
        }
        assert!(!table.matches(&Method::GET, "/api/tasks/123/unmigrated"));
    }
}
