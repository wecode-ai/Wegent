// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/dingtalk-wikispace` — the current user's synced DingTalk
//! wikispace (knowledge base) nodes rendered as a tree
//! (`app.api.endpoints.dingtalk_wikispace.get_wikispace_nodes`).
//!
//! Source pipeline:
//!
//! 1. `security.get_current_user` — the session user by bearer token with the
//!    labeled `users` by-name lookup;
//! 2. `DingTalkWikiSpaceService.get_wikispace_nodes` — every active
//!    `dingtalk_synced_nodes` row of the user with `source = 'wikispace'`,
//!    ordered by `node_type, name`;
//! 3. `DingtalkDocNode.model_validate` per row (the `extension` member is the
//!    model property projecting `raw_metadata.extension` lowercased);
//! 4. `build_dingtalk_tree` — a `dingtalk_node_id` map built over the whole
//!    list first, children nested under the mapped `parent_node_id`, a
//!    missing parent (including the empty root marker) leaving the node as a
//!    root, every level sorted by `(type_order[node_type], name.lower())`
//!    with unknown types ordered last and stable order among equals;
//! 5. `DingtalkDocTreeResponse { nodes, total_count }` where `total_count` is
//!    the flat list length, not the root count.
//!
//! Recorded source evidence (`api-dingtalk-wikispace/920aba21` of run
//! `20261016030056`): the authenticated `users` lookup by user name, the
//! `dingtalk_synced_nodes` scan returning zero rows, then two `ROLLBACK`
//! session cleanups at request end. The driver's read-only session lets
//! Replay classify those ROLLBACKs as optional cleanup, so no rollback
//! statements are issued here.
//!
//! The route was previously forwarded to the Python fallback and answered
//! `502 fallback upstream unavailable`; selecting it for Rust serves the
//! recorded `200 {"nodes":[],"total_count":0}` instead.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `DingTalkNodeSource.WIKISPACE.value`.
const WIKISPACE_SOURCE: &str = "wikispace";

/// `build_dingtalk_tree`'s `type_order` prefix (folder, doc, file); any other
/// node type sorts last by name.
const TYPE_ORDER: [(&str, u8); 3] = [("folder", 0), ("doc", 1), ("file", 2)];

/// One `dingtalk_synced_nodes` row as selected by the source
/// `db.query(DingtalkSyncedNode)` (SQLAlchemy labels every mapped column
/// `<table>_<name>`). `raw_metadata` is nullable in the model, so the JSON
/// column is optional here.
#[derive(Debug, FromMysqlRow)]
struct SyncedNodeRow {
    #[mysql(rename = "dingtalk_synced_nodes_id")]
    id: i64,
    #[mysql(rename = "dingtalk_synced_nodes_dingtalk_node_id")]
    dingtalk_node_id: String,
    #[mysql(rename = "dingtalk_synced_nodes_name")]
    name: String,
    #[mysql(rename = "dingtalk_synced_nodes_doc_url")]
    doc_url: String,
    #[mysql(rename = "dingtalk_synced_nodes_parent_node_id")]
    parent_node_id: String,
    #[mysql(rename = "dingtalk_synced_nodes_node_type")]
    node_type: String,
    #[mysql(rename = "dingtalk_synced_nodes_workspace_id")]
    workspace_id: String,
    #[mysql(rename = "dingtalk_synced_nodes_content_type")]
    content_type: String,
    #[mysql(rename = "dingtalk_synced_nodes_raw_metadata")]
    raw_metadata: Option<brz_mysql::Json<RawMetadata>>,
    #[mysql(rename = "dingtalk_synced_nodes_content_updated_at")]
    content_updated_at: NaiveDateTime,
    #[mysql(rename = "dingtalk_synced_nodes_is_active")]
    is_active: i8,
    #[mysql(rename = "dingtalk_synced_nodes_last_synced_at")]
    last_synced_at: NaiveDateTime,
    #[mysql(rename = "dingtalk_synced_nodes_created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "dingtalk_synced_nodes_updated_at")]
    updated_at: NaiveDateTime,
}

/// The `raw_metadata` members the `DingtalkDocNode.extension` model property
/// reads; every other key is ignored.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct RawMetadata {
    extension: Option<String>,
}

/// `DingtalkDocNodeWithChildren` (`app/schemas/dingtalk_doc.py`) in pydantic
/// field order. `source` is always `wikispace` on this route, and the
/// datetimes render pydantic-style (`YYYY-MM-DDTHH:MM:SS`, microseconds only
/// when non-zero).
#[derive(Debug, Serialize)]
struct TreeNode {
    dingtalk_node_id: String,
    name: String,
    doc_url: String,
    parent_node_id: String,
    node_type: String,
    workspace_id: String,
    content_type: String,
    extension: String,
    source: &'static str,
    content_updated_at: String,
    id: i64,
    is_active: bool,
    last_synced_at: String,
    created_at: String,
    updated_at: String,
    children: Vec<TreeNode>,
}

/// `DingtalkDocTreeResponse`.
#[derive(Debug, Serialize)]
struct TreeResponse {
    nodes: Vec<TreeNode>,
    total_count: usize,
}

/// GET /api/dingtalk-wikispace: the wikispace tree free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/dingtalk-wikispace")]
async fn get_wikispace_nodes(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<TreeResponse, FastApiError> {
    let nodes = fetch_nodes(&state.mysql, current_user.id)
        .await
        .map_err(internal)?;
    let total_count = nodes.len();
    Ok(TreeResponse {
        nodes: build_tree(nodes),
        total_count,
    })
}

/// `DingTalkWikiSpaceService.get_wikispace_nodes`: the active wikispace rows
/// of the user ordered by `node_type, name`. The source driver renders the
/// filter values as inline literals inside `COM_QUERY`, so the statement is
/// built the same way instead of prepared-statement parameters. The user id
/// comes from the authenticated `users` row, never from request text.
async fn fetch_nodes<M: Mysql>(mysql: &M, user_id: i32) -> MysqlResult<Vec<SyncedNodeRow>> {
    mysql.fetch_all(nodes_sql(user_id), ()).await
}

/// The scan statement the source session renders.
fn nodes_sql(user_id: i32) -> String {
    format!(
        "SELECT dingtalk_synced_nodes.id AS dingtalk_synced_nodes_id, \
         dingtalk_synced_nodes.user_id AS dingtalk_synced_nodes_user_id, \
         dingtalk_synced_nodes.dingtalk_node_id AS \
         dingtalk_synced_nodes_dingtalk_node_id, \
         dingtalk_synced_nodes.name AS dingtalk_synced_nodes_name, \
         dingtalk_synced_nodes.doc_url AS dingtalk_synced_nodes_doc_url, \
         dingtalk_synced_nodes.parent_node_id AS \
         dingtalk_synced_nodes_parent_node_id, \
         dingtalk_synced_nodes.node_type AS dingtalk_synced_nodes_node_type, \
         dingtalk_synced_nodes.workspace_id AS dingtalk_synced_nodes_workspace_id, \
         dingtalk_synced_nodes.source AS dingtalk_synced_nodes_source, \
         dingtalk_synced_nodes.content_type AS dingtalk_synced_nodes_content_type, \
         dingtalk_synced_nodes.raw_metadata AS dingtalk_synced_nodes_raw_metadata, \
         dingtalk_synced_nodes.content_updated_at AS \
         dingtalk_synced_nodes_content_updated_at, \
         dingtalk_synced_nodes.is_active AS dingtalk_synced_nodes_is_active, \
         dingtalk_synced_nodes.last_synced_at AS \
         dingtalk_synced_nodes_last_synced_at, \
         dingtalk_synced_nodes.created_at AS dingtalk_synced_nodes_created_at, \
         dingtalk_synced_nodes.updated_at AS dingtalk_synced_nodes_updated_at \
         \nFROM dingtalk_synced_nodes \nWHERE dingtalk_synced_nodes.user_id = {user_id} \
         AND dingtalk_synced_nodes.source = '{WIKISPACE_SOURCE}' \
         AND dingtalk_synced_nodes.is_active = true \
         ORDER BY dingtalk_synced_nodes.node_type, dingtalk_synced_nodes.name"
    )
}

/// `build_dingtalk_tree` over the validated flat node list: link children by
/// the complete id map, then sort every level by the source `sort_key`.
fn build_tree(rows: Vec<SyncedNodeRow>) -> Vec<TreeNode> {
    let nodes: Vec<TreeNode> = rows.into_iter().map(tree_node).collect();
    let ids: Vec<&str> = nodes
        .iter()
        .map(|node| node.dingtalk_node_id.as_str())
        .collect();
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); nodes.len()];
    let mut roots: Vec<usize> = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        // `node_map.get(node.parent_node_id)`: the empty root marker and any
        // id missing from the map both leave the node as a root.
        match ids.iter().position(|id| *id == node.parent_node_id) {
            Some(parent) => children[parent].push(index),
            None => roots.push(index),
        }
    }
    let mut tree: Vec<TreeNode> = roots
        .into_iter()
        .map(|root| assemble(&nodes, root, &mut children))
        .collect();
    tree.sort_by_key(sort_key);
    tree
}

/// Assemble one node with its recursively assembled children, each level
/// sorted by the source `sort_key` (stable, so equals keep insertion order).
fn assemble(nodes: &[TreeNode], index: usize, children: &mut [Vec<usize>]) -> TreeNode {
    let source = &nodes[index];
    let mut node = TreeNode {
        dingtalk_node_id: source.dingtalk_node_id.clone(),
        name: source.name.clone(),
        doc_url: source.doc_url.clone(),
        parent_node_id: source.parent_node_id.clone(),
        node_type: source.node_type.clone(),
        workspace_id: source.workspace_id.clone(),
        content_type: source.content_type.clone(),
        extension: source.extension.clone(),
        source: WIKISPACE_SOURCE,
        content_updated_at: source.content_updated_at.clone(),
        id: source.id,
        is_active: source.is_active,
        last_synced_at: source.last_synced_at.clone(),
        created_at: source.created_at.clone(),
        updated_at: source.updated_at.clone(),
        children: Vec::new(),
    };
    for child in std::mem::take(&mut children[index]) {
        node.children.push(assemble(nodes, child, children));
    }
    node.children.sort_by_key(sort_key);
    node
}

/// One flat row projected through `DingtalkDocNode.model_validate`.
fn tree_node(row: SyncedNodeRow) -> TreeNode {
    TreeNode {
        dingtalk_node_id: row.dingtalk_node_id,
        name: row.name,
        doc_url: row.doc_url,
        parent_node_id: row.parent_node_id,
        node_type: row.node_type,
        workspace_id: row.workspace_id,
        content_type: row.content_type,
        // The model property: `str((raw_metadata or {}).get("extension")
        // or "").strip().lower()`.
        extension: row
            .raw_metadata
            .as_ref()
            .and_then(|metadata| metadata.0.extension.as_deref())
            .unwrap_or("")
            .trim()
            .to_lowercase(),
        source: WIKISPACE_SOURCE,
        content_updated_at: pydantic_datetime(row.content_updated_at),
        id: row.id,
        is_active: row.is_active != 0,
        last_synced_at: pydantic_datetime(row.last_synced_at),
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
        children: Vec::new(),
    }
}

/// `sort_key`'s tuple: unknown node types order after folder/doc/file.
fn sort_key(node: &TreeNode) -> (u8, String) {
    let order = TYPE_ORDER
        .iter()
        .find(|(kind, _)| *kind == node.node_type)
        .map_or(3, |(_, order)| *order);
    (order, node.name.to_lowercase())
}

/// Pydantic v2 naive `datetime` serialization: `YYYY-MM-DDTHH:MM:SS` (six-digit
/// microseconds appended only when non-zero).
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

/// Dependent-query failure mapped to the source `python_exception_handler`
/// body (`{"error_code": 500, "detail": "Internal server error"}`).
fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "dingtalk wikispace nodes database dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(day: u32, hour: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, day)
            .unwrap()
            .and_hms_opt(hour, 10, 30)
            .unwrap()
    }

    fn row(
        id: i64,
        dingtalk_node_id: &str,
        name: &str,
        parent_node_id: &str,
        node_type: &str,
        extension: Option<&str>,
    ) -> SyncedNodeRow {
        SyncedNodeRow {
            id,
            dingtalk_node_id: dingtalk_node_id.to_owned(),
            name: name.to_owned(),
            doc_url: format!("https://example.test/{dingtalk_node_id}"),
            parent_node_id: parent_node_id.to_owned(),
            node_type: node_type.to_owned(),
            workspace_id: "kb-1".to_owned(),
            content_type: "ALIDOC".to_owned(),
            raw_metadata: extension.map(|value| {
                brz_mysql::Json(RawMetadata {
                    extension: Some(value.to_owned()),
                })
            }),
            content_updated_at: at(12, 9),
            is_active: 1,
            last_synced_at: at(12, 10),
            created_at: at(12, 11),
            updated_at: at(12, 12),
        }
    }

    #[test]
    fn empty_scan_matches_the_recorded_body() {
        let response = build_tree_value(Vec::new());
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"nodes":[],"total_count":0}"#
        );
    }

    /// `get_wikispace_nodes`'s response assembly without a database.
    fn build_tree_value(rows: Vec<SyncedNodeRow>) -> TreeResponse {
        let total_count = rows.len();
        TreeResponse {
            nodes: build_tree(rows),
            total_count,
        }
    }

    #[test]
    fn tree_nests_children_and_sorts_each_level() {
        let rows = vec![
            row(1, "doc-b", "Beta", "", "doc", None),
            row(2, "folder-b", "zeta", "", "folder", None),
            row(3, "doc-child", "Child", "doc-b", "doc", None),
            row(4, "folder-a", "Alpha", "folder-b", "folder", None),
            row(5, "doc-a", "alpha", "", "doc", None),
            row(6, "weird", "Weird", "", "unknown", None),
        ];
        let tree = build_tree(rows);
        // folder (zeta) before doc (alpha, Beta) before the unknown type, and
        // the empty parent marker leaves a node as a root like the source's
        // `node_map.get("")` miss.
        let names: Vec<&str> = tree.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, ["zeta", "alpha", "Beta", "Weird"]);
        assert_eq!(tree[0].children[0].name, "Alpha");
        assert_eq!(tree[2].children[0].name, "Child");
    }

    #[test]
    fn a_parent_later_in_the_flat_list_still_nests_its_child() {
        // The source builds the whole id map before linking parents.
        let rows = vec![
            row(1, "child", "Child", "parent", "doc", None),
            row(2, "parent", "Parent", "", "folder", None),
        ];
        let tree = build_tree(rows);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "Parent");
        assert_eq!(tree[0].children[0].name, "Child");
    }

    #[test]
    fn a_missing_parent_leaves_the_node_as_a_root() {
        let rows = vec![row(1, "orphan", "Orphan", "gone", "doc", None)];
        let tree = build_tree(rows);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name, "Orphan");
        assert!(tree[0].children.is_empty());
    }

    #[test]
    fn extension_projects_raw_metadata_lowercased() {
        let node = tree_node(row(7, "doc-x", "X", "", "doc", Some("PDF")));
        assert_eq!(node.extension, "pdf");
        let node = tree_node(row(8, "doc-y", "Y", "", "doc", None));
        assert_eq!(node.extension, "");
    }

    #[test]
    fn datetimes_render_pydantic_style() {
        let node = tree_node(row(9, "doc-z", "Z", "", "doc", None));
        assert_eq!(node.content_updated_at, "2026-10-12T09:10:30");
        assert_eq!(node.last_synced_at, "2026-10-12T10:10:30");
    }

    #[test]
    fn recorded_scan_sql_is_reproduced() {
        let sql = nodes_sql(3452);
        assert!(sql.contains(
            "WHERE dingtalk_synced_nodes.user_id = 3452 \
             AND dingtalk_synced_nodes.source = 'wikispace' \
             AND dingtalk_synced_nodes.is_active = true"
        ));
        assert!(
            sql.ends_with("ORDER BY dingtalk_synced_nodes.node_type, dingtalk_synced_nodes.name")
        );
        assert!(sql.contains(
            "dingtalk_synced_nodes.raw_metadata AS \
             dingtalk_synced_nodes_raw_metadata"
        ));
    }

    #[test]
    fn registered_route_keeps_python_ownership() {
        const PATH: &str = "/api/dingtalk-wikispace";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::GET, "/api/dingtalk-wikispace"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
