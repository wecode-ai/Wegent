// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the selected-knowledge normalization and enrichment.
use super::*;
use crate::responses::create::kb_tool_access_mode::{FULL, RESTRICTED_SEARCH_ONLY};
use crate::responses::create::knowledge_prompt::{SelectedKnowledgeRef, SelectedKnowledgeResource};
use serde_json::json;

fn reference(id: &str, name: &str) -> SelectedKnowledgeRef {
    SelectedKnowledgeRef {
        provider: "wegent".to_string(),
        knowledge_base_id: id.to_string(),
        knowledge_base_name: name.to_string(),
        ..Default::default()
    }
}

#[test]
fn explicit_refs_override_the_same_source_and_set_evidence_required() {
    let task = vec![reference("239607", "task-name")];
    let explicit = vec![SelectedKnowledgeRef {
        knowledge_base_name: "explicit".to_string(),
        resources: vec![SelectedKnowledgeResource {
            scope_type: "document".to_string(),
            resource_id: Some("7".to_string()),
            ..Default::default()
        }],
        ..reference("239607", "explicit")
    }];
    let context = resolve_selected_knowledge_context(&task, &explicit);
    assert!(context.evidence_required);
    assert_eq!(context.refs.len(), 1);
    assert_eq!(context.refs[0].knowledge_base_name, "explicit");
    assert_eq!(context.refs[0].resources.len(), 1);
}

#[test]
fn an_empty_explicit_set_keeps_the_task_refs_and_clears_evidence() {
    let context = resolve_selected_knowledge_context(&[reference("1", "a")], &[]);
    assert!(!context.evidence_required);
    assert_eq!(context.refs.len(), 1);
}

#[test]
fn sanitize_replaces_unsafe_characters_and_truncates() {
    assert_eq!(sanitize_prompt_text("a{b}[c]%", "", 120), "a b c");
    assert_eq!(sanitize_prompt_text("  hi\nthere  ", "", 120), "hi there");
    assert_eq!(
        sanitize_prompt_text("x".repeat(300).as_str(), "", 200).len(),
        200
    );
    assert_eq!(sanitize_prompt_text("", "fallback", 120), "fallback");
}

#[test]
fn retrieval_capabilities_match_the_mode() {
    assert_eq!(
        derive_retrieval_capabilities(&json!({"retrieval_mode": "vector"})),
        json!({"retrieval_mode": "vector", "semantic_query": false, "keywords": false, "phrases": false})
    );
    assert_eq!(
        derive_retrieval_capabilities(&json!({"retrieval_mode": "hybrid"})),
        json!({"retrieval_mode": "hybrid", "semantic_query": true, "keywords": true, "phrases": true})
    );
    assert_eq!(
        derive_retrieval_capabilities(&json!({})),
        json!({"retrieval_mode": null, "semantic_query": false, "keywords": false, "phrases": false})
    );
}

#[test]
fn routing_summary_and_topics_follow_the_source_gates() {
    let manual = json!({"manual_long_summary": "long", "topics": ["t1", "t2"]});
    assert_eq!(routing_summary(&json!({}), &manual), "long");
    assert_eq!(
        routing_topics(&json!({}), &manual),
        vec![json!("t1"), json!("t2")]
    );

    let short = json!({"status": "completed", "short_summary": "s"});
    assert_eq!(
        routing_summary(&json!({"summaryEnabled": true}), &short),
        "s"
    );
    assert!(routing_topics(&json!({"summaryEnabled": false}), &short).is_empty());
    assert_eq!(
        routing_summary(&json!({"summaryEnabled": false}), &short),
        ""
    );
}

#[test]
fn int_values_ignore_booleans_and_non_positive_entries() {
    assert_eq!(
        int_values(&json!([1, "2", 0, -3, true, "x", 1])),
        vec![1, 2]
    );
    assert_eq!(positive_int(&json!("239607")), Some(239_607));
    assert_eq!(positive_int(&json!(0)), None);
    assert_eq!(positive_int(&json!(false)), None);
}

#[test]
fn index_refs_keeps_only_dicts_with_a_positive_id() {
    let indexed = index_refs_by_integer_id(&json!([
        {"id": 5, "name": "a"},
        {"id": "6", "name": "b"},
        {"name": "c"},
        "d",
    ]));
    assert_eq!(indexed.len(), 2);
    assert_eq!(indexed.get(&5).unwrap()["name"], json!("a"));
    assert_eq!(indexed.get(&6).unwrap()["name"], json!("b"));
}

#[test]
fn wegent_scope_prefers_the_request_scope_only_when_asked() {
    let persisted =
        json!({"scopeRestricted": true, "folderIds": [7], "explicitDocumentIds": ["8"]});
    assert_eq!(
        resolve_wegent_scope(1, &persisted, &[], false),
        (true, vec![7], vec![8])
    );
    let scopes = vec![KnowledgeBaseScope {
        knowledge_base_id: 1,
        scope_restricted: false,
        document_ids: vec![9],
    }];
    assert_eq!(
        resolve_wegent_scope(1, &persisted, &scopes, true),
        (false, Vec::new(), vec![9])
    );
    // A non-matching request scope falls back to the persisted scope.
    assert_eq!(
        resolve_wegent_scope(2, &persisted, &scopes, true),
        (true, vec![7], vec![8])
    );
}

#[test]
fn knowledge_base_scopes_parse_from_the_request_list() {
    let scopes = parse_knowledge_base_scopes(&json!([
        {"knowledge_base_id": 239607, "scope_restricted": true, "document_ids": [1, "2"]},
        {"knowledge_base_id": 0},
    ]));
    assert_eq!(
        scopes,
        vec![KnowledgeBaseScope {
            knowledge_base_id: 239_607,
            scope_restricted: true,
            document_ids: vec![1, 2],
        }]
    );
}

/// `_build_wegent_refs_for_ids` reads the complete `db.query(Kind)` entity
/// with integer-bound ids and no kind/is_active filter, so the dependency
/// matches the recorded `SELECT <Kind entity> ... WHERE kinds.id IN (...)`.
#[tokio::test]
async fn knowledge_base_specs_read_the_full_kind_entity_with_integer_ids() {
    use crate::sql_test_support::KindQueryCapture;
    let mysql = KindQueryCapture::default();
    let specs = knowledge_base_specs_by_ids(&mysql, &[263_078])
        .await
        .unwrap();
    assert!(specs.is_empty());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    let sql = &queries[0].sql;
    for column in [
        "kinds.id AS kinds_id",
        "kinds.user_id AS kinds_user_id",
        "kinds.kind AS kinds_kind",
        "kinds.name AS kinds_name",
        "kinds.namespace AS kinds_namespace",
        "kinds.json AS kinds_json",
        "kinds.is_active AS kinds_is_active",
        "kinds.created_at AS kinds_created_at",
        "kinds.updated_at AS kinds_updated_at",
    ] {
        assert!(sql.contains(column), "missing {column}: {sql}");
    }
    assert!(sql.contains("FROM kinds WHERE kinds.id IN (?)"), "{sql}");
    assert!(!sql.contains("kinds.kind = 'KnowledgeBase'"), "{sql}");
    assert_eq!(queries[0].args, 1);
    assert_eq!(queries[0].first_integer, Some(263_078));
}

/// `get_knowledge_bases_by_ids` reads the same full entity but keeps the
/// `KnowledgeBase`/`is_active` predicates the route's enrichment applies.
/// `Kind.is_active == True` renders `= true` here; the ACL paths' `IS true`
/// belongs to their own `is_(True)` predicates.
#[tokio::test]
async fn routing_enrichment_reads_the_full_kind_entity_with_the_kb_filter() {
    use crate::sql_test_support::KindQueryCapture;
    let mysql = KindQueryCapture::default();
    let context = SelectedKnowledgeContext {
        refs: vec![reference("263078", "kb")],
        evidence_required: false,
    };
    enrich_wegent_routing_metadata(&mysql, &context)
        .await
        .unwrap();

    let queries = mysql.queries();
    let sql = &queries[0].sql;
    assert!(sql.contains("kinds.user_id AS kinds_user_id"), "{sql}");
    assert!(sql.contains("kinds.is_active AS kinds_is_active"), "{sql}");
    assert!(
        sql.contains(
            "WHERE kinds.id IN (?) AND kinds.kind = 'KnowledgeBase' AND kinds.is_active = true"
        ),
        "{sql}"
    );
    assert_eq!(queries[0].first_integer, Some(263_078));
}

/// `get_document_prompt_stats` takes `list[int]`; the recorded Source binds
/// the KB id as an integer in `WHERE knowledge_documents.kind_id IN (?)`. A
/// stringified id renders identical SQL text but a `string` parameter, which
/// the recorded exchange does not match.
#[tokio::test]
async fn document_prompt_stats_binds_knowledge_base_ids_as_integers() {
    use crate::sql_test_support::KindQueryCapture;
    let mysql = KindQueryCapture::default();
    let stats = document_prompt_stats(&mysql, &[263_078]).await.unwrap();
    assert!(stats.is_empty());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    let sql = &queries[0].sql;
    assert!(
        sql.contains("WHERE knowledge_documents.kind_id IN (?)"),
        "{sql}"
    );
    assert!(
        sql.contains("GROUP BY knowledge_documents.kind_id"),
        "{sql}"
    );
    assert_eq!(queries[0].args, 1);
    assert_eq!(
        queries[0].first_integer,
        Some(263_078),
        "the KB id must bind as an integer, not as a string"
    );
}

/// The recorded prompt-stat row for KB `263078` is
/// `[263078, 7, 7.0, 3.0]` with `total_count` as `BIGINT` and both
/// `sum(CASE ...)` columns as `DECIMAL` (`NEWDECIMAL`, value text `7.0` /
/// `3.0`). Decoding the sums as integers makes the driver reject the row
/// (`DECIMAL` is not compatible with `BIGINT`), which turned the whole create
/// request into a 500 after every dependency had matched. The source runs
/// `int(searchable_count or 0)` on the `Decimal`, truncating `7.0` to 7.
///
/// The fields are `Option<DecimalCount>` because the derive reads them with
/// `MysqlRow::get`: SQL NULL (a `sum()` over no rows) yields `None` there, and
/// `counts` applies `or 0`. This test covers that mapping; the driver's
/// NULL→`None` step itself is brz-mysql's and needs a real row, which this
/// crate's unit harness cannot construct.
#[test]
fn prompt_stats_decode_the_decimal_sum_columns_as_counts() {
    let stats = KbPromptStats {
        kind_id: 263_078,
        total: Some(7),
        searchable: Some(DecimalCount(7)),
        spreadsheet: Some(DecimalCount(3)),
    };
    assert_eq!(stats.counts(), (7, 7, 3));

    // What the derive produces for a row whose `sum()` columns are SQL NULL.
    let empty = KbPromptStats {
        kind_id: 263_078,
        total: Some(0),
        searchable: None,
        spreadsheet: None,
    };
    assert_eq!(empty.counts(), (0, 0, 0));
}

/// A non-`wegent` ref, e.g. the external Provider sources `build_selected_
/// knowledge_refs` appends after the internal ones.
fn external_reference(provider: &str, id: &str) -> SelectedKnowledgeRef {
    SelectedKnowledgeRef {
        provider: provider.to_string(),
        knowledge_base_id: id.to_string(),
        knowledge_base_name: format!("{provider}-name"),
        ..Default::default()
    }
}

#[test]
fn wegent_ids_come_from_the_context_refs_in_ref_order() {
    let context = resolve_selected_knowledge_context(
        &[
            reference("239607", "kb-a"),
            external_reference("dingtalk", "7"),
            reference("263078", "kb-b"),
            reference("not-an-int", "kb-c"),
            reference("0", "kb-d"),
        ],
        &[],
    );
    // Only the positive `wegent` ids, in ref order, ignoring other providers
    // and unparseable ids; nothing is hardcoded.
    assert_eq!(wegent_knowledge_base_ids(&context), vec![239_607, 263_078]);
}

#[test]
fn a_restricted_analyst_drops_every_wegent_ref() {
    let context = resolve_selected_knowledge_context(
        &[
            reference("263078", "kb-a"),
            external_reference("dingtalk", "7"),
        ],
        &[reference("263078", "effective")],
    );
    assert!(context.evidence_required);

    let filtered = filter_native_refs(context, RESTRICTED_SEARCH_ONLY);

    assert_eq!(filtered.refs.len(), 1);
    assert_eq!(filtered.refs[0].provider, "dingtalk");
    // `_filter_native_refs` rebuilds the context, so the evidence flag survives.
    assert!(filtered.evidence_required);
}

#[test]
fn an_unrestricted_access_mode_keeps_the_native_refs() {
    let context = resolve_selected_knowledge_context(
        &[
            reference("263078", "kb-a"),
            external_reference("dingtalk", "7"),
        ],
        &[],
    );
    let filtered = filter_native_refs(context, FULL);
    assert_eq!(filtered.refs.len(), 2);
    assert_eq!(filtered.refs[0].provider, "wegent");
    assert!(!filtered.evidence_required);
}

#[tokio::test]
async fn an_empty_wegent_id_list_returns_full_without_querying() {
    let mysql =
        brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").expect("lazy");
    let resolvers = crate::permissions::EntityResolvers::public(mysql.clone());
    let context = resolve_selected_knowledge_context(&[external_reference("dingtalk", "7")], &[]);

    let mode = resolve_effective_wegent_access_mode(
        &mysql,
        &resolvers,
        None::<&brz_redis::RedisService>,
        &context,
        5831,
    )
    .await
    .expect("the empty wegent id list short-circuits before any query");

    assert_eq!(mode, FULL);
}
