// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route selection for the hybrid listener. The gateway dependency supports
//! exact and prefix paths; API handlers also export named and catch-all paths.
//! Keep selection explicit so an unrelated Python route beneath the same
//! prefix is never captured by Rust.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use http::Method;
use serde::Deserialize;

use crate::{BoxError, PathMatch, RouteRule, RouteTable, RoutesConfig};

#[derive(Clone, Debug, Default)]
pub(super) struct TemplateRoutes(Arc<[TemplateRoute]>);

#[derive(Clone, Debug)]
struct TemplateRoute {
    methods: Vec<Method>,
    segments: Vec<Segment>,
}

#[derive(Clone, Debug)]
enum Segment {
    Literal(String),
    Parameter,
    Rest,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    #[serde(default)]
    include: Vec<PathBuf>,
    #[serde(default)]
    routes: Vec<FileRule>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRule {
    #[serde(default)]
    methods: Vec<String>,
    path: String,
    #[serde(default)]
    match_kind: MatchKind,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MatchKind {
    #[default]
    Exact,
    Prefix,
    Template,
}

impl TemplateRoutes {
    pub(super) fn load(path: &Path) -> Result<(RouteTable, Self), BoxError> {
        let mut seen = HashSet::new();
        let mut rules = Vec::new();
        Self::load_rules(path, &mut seen, &mut rules)?;
        let mut regular = Vec::new();
        let mut templates = Vec::new();
        for (index, rule) in rules.into_iter().enumerate() {
            match rule.match_kind {
                MatchKind::Exact | MatchKind::Prefix => regular.push(RouteRule {
                    methods: rule.methods,
                    path: rule.path,
                    match_kind: if matches!(rule.match_kind, MatchKind::Exact) {
                        PathMatch::Exact
                    } else {
                        PathMatch::Prefix
                    },
                }),
                MatchKind::Template => templates.push(TemplateRoute::compile(index, rule)?),
            }
        }
        let regular = RouteTable::compile(RoutesConfig { routes: regular })?;
        Ok((regular, Self(templates.into())))
    }

    fn load_rules(
        path: &Path,
        seen: &mut HashSet<PathBuf>,
        rules: &mut Vec<FileRule>,
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
            Self::load_rules(&child, seen, rules)?;
        }
        rules.extend(config.routes);
        Ok(())
    }

    #[must_use]
    pub(super) fn len(&self) -> usize {
        self.0.len()
    }

    #[must_use]
    pub(super) fn matches(&self, method: &Method, path: &str) -> bool {
        self.0.iter().any(|route| route.matches(method, path))
    }
}

impl TemplateRoute {
    fn compile(index: usize, rule: FileRule) -> Result<Self, BoxError> {
        if !rule.path.starts_with('/') {
            return Err(format!("route {index} path must start with '/': {}", rule.path).into());
        }
        let mut segments = Vec::new();
        for (position, segment) in rule.path.split('/').enumerate() {
            let parsed = if segment.starts_with(':') {
                if segment.len() == 1 {
                    return Err(format!("route {index} has an empty parameter name").into());
                }
                Segment::Parameter
            } else if segment.starts_with('*') {
                if segment.len() == 1 || position != rule.path.split('/').count() - 1 {
                    return Err(
                        format!("route {index} has an invalid catch-all: {}", rule.path).into(),
                    );
                }
                Segment::Rest
            } else {
                Segment::Literal(segment.to_owned())
            };
            segments.push(parsed);
        }
        let methods = rule
            .methods
            .into_iter()
            .map(|method| Method::from_bytes(method.as_bytes()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { methods, segments })
    }

    fn matches(&self, method: &Method, path: &str) -> bool {
        if !self.methods.is_empty() && !self.methods.contains(method) {
            return false;
        }
        let mut actual = path.split('/');
        for segment in &self.segments {
            match segment {
                Segment::Literal(expected) => {
                    if actual.next() != Some(expected.as_str()) {
                        return false;
                    }
                }
                Segment::Parameter => {
                    if !actual.next().is_some_and(|value| !value.is_empty()) {
                        return false;
                    }
                }
                Segment::Rest => return actual.next().is_some(),
            }
        }
        actual.next().is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn route(path: &str) -> TemplateRoute {
        TemplateRoute::compile(
            0,
            FileRule {
                methods: vec!["GET".to_owned()],
                path: path.to_owned(),
                match_kind: MatchKind::Template,
            },
        )
        .unwrap()
    }

    #[test]
    fn named_paths_capture_one_nonempty_segment_only() {
        let route = route("/api/tasks/:task_id/skills");
        assert!(route.matches(&Method::GET, "/api/tasks/123/skills"));
        assert!(!route.matches(&Method::GET, "/api/tasks/123/details"));
        assert!(!route.matches(&Method::GET, "/api/tasks//skills"));
        assert!(!route.matches(&Method::GET, "/api/tasks/123/skills/extra"));
        assert!(!route.matches(&Method::POST, "/api/tasks/123/skills"));
    }

    #[test]
    fn catch_all_requires_a_remaining_segment() {
        let route = route("/api/quota/*path");
        assert!(route.matches(&Method::GET, "/api/quota/claude/quota"));
        assert!(route.matches(&Method::GET, "/api/quota/"));
        assert!(!route.matches(&Method::GET, "/api/quota"));
        assert!(!route.matches(&Method::GET, "/api/quotas/example"));
    }

    #[test]
    fn invalid_templates_fail_at_startup() {
        assert!(
            TemplateRoute::compile(
                0,
                FileRule {
                    methods: vec!["GET".to_owned()],
                    path: "relative".to_owned(),
                    match_kind: MatchKind::Template,
                }
            )
            .is_err()
        );
        assert!(
            TemplateRoute::compile(
                0,
                FileRule {
                    methods: vec!["GET".to_owned()],
                    path: "/api/*rest/other".to_owned(),
                    match_kind: MatchKind::Template,
                }
            )
            .is_err()
        );
    }

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
        // The checked-in cutover is partial: a route is enabled only after its
        // behavior is verified, so the file selects a subset of the registered
        // public routes. No rule may select a route this crate does not
        // implement.
        assert!(selected.is_subset(&registered));
        assert!(selected.contains(&("GET".to_owned(), "/api/quota".to_owned())));
        assert!(!selected.contains(&("GET".to_owned(), "/api/quota/*path".to_owned())));

        let (regular, templates) = TemplateRoutes::load(&path).unwrap();
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
                regular.matches(&method, &concrete) || templates.matches(&method, &concrete),
                "cutover rule failed to match {method} {path}"
            );
        }
        assert!(!regular.matches(&Method::GET, "/api/tasks/123/unmigrated"));
        assert!(!templates.matches(&Method::GET, "/api/tasks/123/unmigrated"));
    }
}
