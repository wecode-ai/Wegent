// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for `resource_library_listings::repository`.

use super::*;
use chrono::NaiveDate;

fn parts<'a>(
    kinds: &'a [&'a str],
    published: bool,
    installed: &'a [i64],
    cursor: Option<&'a CursorPosition>,
) -> QueryParts<'a> {
    QueryParts {
        kinds,
        published,
        resource_type: None,
        score_floor: true,
        installed_skill_ids: installed,
        keyword: None,
        tags: &[],
        cursor,
        batch_size: 21,
    }
}

fn time() -> NaiveDateTime {
    NaiveDate::from_ymd_opt(2026, 9, 11)
        .unwrap()
        .and_hms_opt(8, 30, 41)
        .unwrap()
}

#[test]
fn system_query_keeps_the_source_projection_and_filters() {
    let sql = build_discovery_query(&parts(&["Skill"], false, &[7, 3], None));
    assert!(sql.starts_with("SELECT kinds.id AS kinds_id"));
    assert!(
        sql.contains("kinds.user_id = 0 AND kinds.kind IN ('Skill') AND kinds.is_active = true")
    );
    assert!(sql.contains("AS SIGNED INTEGER) END >= 80"));
    assert!(sql.contains("AS SIGNED INTEGER) END AS recommendation_score"));
    assert!(sql.contains("(kinds.kind != 'Skill' OR (kinds.id NOT IN (7, 3)))"));
    assert!(sql.contains("ORDER BY CASE WHEN"));
    assert!(sql.contains("kinds.updated_at DESC, kinds.id DESC"));
    assert!(sql.ends_with("LIMIT 21"));
    assert!(!sql.contains("marketplace_resources"));
}

#[test]
fn published_query_adds_the_resource_type_and_score_filters() {
    let mut query = parts(&["Team"], true, &[], None);
    query.resource_type = Some("agent");
    let sql = build_discovery_query(&query);
    assert!(sql.contains(
        "FROM marketplace_resources INNER JOIN kinds ON kinds.id = marketplace_resources.kind_id"
    ));
    assert!(sql.contains("kinds.user_id != 0 AND kinds.kind IN ('Team')"));
    assert!(sql.contains("marketplace_resources.resource_type = 'agent'"));
    assert!(sql.contains("marketplace_resources.recommendation_score >= 80"));
    assert!(sql.contains(
        "ORDER BY marketplace_resources.recommendation_score DESC, marketplace_resources.updated_at DESC, kinds.id DESC"
    ));
    assert!(!sql.contains("kinds.kind != 'Skill'"));
}

#[test]
fn featured_only_omits_the_score_floor() {
    let mut query = parts(&["Skill"], false, &[], None);
    query.score_floor = false;
    let sql = build_discovery_query(&query);
    assert!(!sql.contains(">= 80"));
}

#[test]
fn keyword_and_tag_filters_escape_like_wildcards() {
    let tag = "daily_work".to_owned();
    let mut query = parts(&["Skill"], false, &[], None);
    query.keyword = Some("100%");
    query.tags = std::slice::from_ref(&tag);
    let sql = build_discovery_query(&query);
    assert!(sql.contains("lower(kinds.name) LIKE '%100\\\\%%' ESCAPE '\\\\'"));
    assert!(sql.contains("$.metadata.displayName"));
    assert!(sql.contains("LIKE '%\"daily\\\\_work\"%' ESCAPE '\\\\'"));
}

#[test]
fn cursor_predicate_follows_score_then_time_then_id() {
    let cursor = CursorPosition {
        recommendation_score: Some(80),
        updated_at: time(),
        kind_id: 12,
    };
    let sql = build_discovery_query(&parts(&["Skill"], false, &[], Some(&cursor)));
    // SQLAlchemy renders the nested `and_` operands without redundant
    // groups, so only the outer `or_` is parenthesized.
    assert!(sql.contains("AND (CASE WHEN"));
    assert!(sql.contains("END < 80 OR CASE WHEN"));
    assert!(sql.contains("END = 80 AND (kinds.updated_at < "));
    assert!(sql.contains("kinds.id < 12"));
    // `datetime.isoformat(" ")`: a whole second drops the fractional part.
    assert!(sql.contains("'2026-09-11 08:30:41'"));
    assert!(!sql.contains("'2026-09-11 08:30:41.000000'"));
}

#[test]
fn cursor_datetime_literal_keeps_nonzero_microseconds() {
    let cursor = CursorPosition {
        recommendation_score: Some(80),
        updated_at: time() + chrono::Duration::microseconds(123_000),
        kind_id: 12,
    };
    let sql = build_discovery_query(&parts(&["Skill"], false, &[], Some(&cursor)));
    assert!(sql.contains("'2026-09-11 08:30:41.123000'"), "{sql}");
}

#[test]
fn legacy_cursor_orders_by_time_only() {
    let cursor = CursorPosition {
        recommendation_score: None,
        updated_at: time(),
        kind_id: 12,
    };
    let sql = build_discovery_query(&parts(&["Skill"], false, &[], Some(&cursor)));
    assert!(
        sql.contains(
            "AND (kinds.updated_at < '2026-09-11 08:30:41' OR kinds.updated_at = \
             '2026-09-11 08:30:41' AND kinds.id < 12)"
        ),
        "{sql}"
    );
}

#[test]
fn cursor_predicate_reproduces_the_recorded_second_page_statement() {
    // Recorded statement (query_sequence 2972) from the zero-score cursor
    // at 2026-09-02 07:24:11 / kind_id 237510.
    let cursor = CursorPosition {
        recommendation_score: Some(0),
        updated_at: NaiveDate::from_ymd_opt(2026, 9, 2)
            .unwrap()
            .and_hms_opt(7, 24, 11)
            .unwrap(),
        kind_id: 237_510,
    };
    let sql = build_discovery_query(&parts(&["Skill"], false, &[], Some(&cursor)));
    assert!(
        sql.contains(
            "AND (CASE WHEN (coalesce(json_unquote(json_extract(kinds.json, \
             '$.spec.capability.marketplace.recommendationScore')), '') = '') THEN 0 ELSE \
             CAST(coalesce(json_unquote(json_extract(kinds.json, \
             '$.spec.capability.marketplace.recommendationScore')), '') AS SIGNED INTEGER) \
             END < 0 OR CASE WHEN (coalesce(json_unquote(json_extract(kinds.json, \
             '$.spec.capability.marketplace.recommendationScore')), '') = '') THEN 0 ELSE \
             CAST(coalesce(json_unquote(json_extract(kinds.json, \
             '$.spec.capability.marketplace.recommendationScore')), '') AS SIGNED INTEGER) \
             END = 0 AND (kinds.updated_at < '2026-09-02 07:24:11' OR kinds.updated_at = \
             '2026-09-02 07:24:11' AND kinds.id < 237510))"
        ),
        "{sql}"
    );
}

#[test]
fn installed_filter_renders_the_cpython_set_order() {
    // Case ba098165: the user's default bindings arrive in
    // `created_at DESC` order, and the source's `set[int]` renders the
    // recorded `NOT IN` list in CPython slot order.
    let mut ids = crate::py_set_order::SetOrder::new();
    for id in [
        283_712, 200_318, 269_285, 127_443, 237_510, 214_204, 187_623, 188_646, 187_624, 110_603,
        133_755, 133_269, 127_449, 273_990, 266_010, 127_444, 256_262,
    ] {
        ids.add(id);
    }
    assert_eq!(
        installed_skill_filter(&ids.order()).unwrap(),
        "(kinds.kind != 'Skill' OR (kinds.id NOT IN (283712, 269285, 237510, 187623, \
         188646, 187624, 273990, 110603, 256262, 127443, 127444, 133269, 127449, 266010, \
         133755, 214204, 200318)))"
    );
}

#[test]
fn quote_literal_matches_mysql_escaping() {
    assert_eq!(quote_literal("a'b\\c"), "'a\\'b\\\\c'");
    assert_eq!(escape_sql_like("50%_x"), "50\\%\\_x");
}

#[test]
fn quote_literal_keeps_multi_byte_characters_intact() {
    // Case ebae75e7: the recorded statement keeps the UTF-8 keyword
    // `微博` whole; escaping byte-by-byte would Latin-1-mangle it into
    // `å¾®å` and break MySQL dependency matching.
    assert_eq!(quote_literal("微博"), "'微博'");
    assert_eq!(
        quote_literal("a'b微博"),
        "'a\\'b微博'",
        "escaping must not disturb surrounding multi-byte text"
    );
}

#[test]
fn keyword_filter_renders_the_recorded_non_ascii_pattern() {
    // The recorded system discovery statement (query_sequence 2142) for
    // `keyword=微博`: `LIKE '%微博%' ESCAPE '\\'`.
    let mut query = parts(&["Skill"], false, &[], None);
    query.score_floor = false;
    query.keyword = Some("微博");
    let sql = build_discovery_query(&query);
    assert!(
        sql.contains("LIKE '%微博%' ESCAPE '\\\\'"),
        "keyword must stay UTF-8, not Latin-1 mangled: {sql}"
    );
    assert!(!sql.contains('å'), "{sql}");
    // The source guards this field with `case((Kind.kind != "Skill", ...))`.
    assert!(
        sql.contains(
            "CASE WHEN (kinds.kind != 'Skill') THEN coalesce(json_unquote(\
        json_extract(kinds.json, '$.spec.capability.description')), '') ELSE '' END)"
        ),
        "{sql}"
    );
}

// The exact statements captured for `20261016025404`, case
// 22ccab10 (`resource_type=agent`, `page=1`, `limit=100`, owner 238).
const RECORDED_COUNT_SQL: &str = "SELECT count(*) AS count_1 \n\
    FROM (SELECT marketplace_resources.kind_id AS marketplace_resources_kind_id, \
    marketplace_resources.owner_user_id AS marketplace_resources_owner_user_id, \
    marketplace_resources.resource_type AS marketplace_resources_resource_type, \
    marketplace_resources.recommendation_score AS \
    marketplace_resources_recommendation_score, marketplace_resources.install_count AS \
    marketplace_resources_install_count, marketplace_resources.published_at AS \
    marketplace_resources_published_at, marketplace_resources.updated_at AS \
    marketplace_resources_updated_at \nFROM marketplace_resources \n\
    WHERE marketplace_resources.owner_user_id = 238 AND \
    marketplace_resources.resource_type = 'agent') AS anon_1";

const RECORDED_PAGE_SQL: &str = "SELECT marketplace_resources.kind_id AS \
    marketplace_resources_kind_id, marketplace_resources.owner_user_id AS \
    marketplace_resources_owner_user_id, marketplace_resources.resource_type AS \
    marketplace_resources_resource_type, marketplace_resources.recommendation_score AS \
    marketplace_resources_recommendation_score, marketplace_resources.install_count AS \
    marketplace_resources_install_count, marketplace_resources.published_at AS \
    marketplace_resources_published_at, marketplace_resources.updated_at AS \
    marketplace_resources_updated_at \nFROM marketplace_resources \n\
    WHERE marketplace_resources.owner_user_id = 238 AND \
    marketplace_resources.resource_type = 'agent' ORDER BY \
    marketplace_resources.updated_at DESC, marketplace_resources.kind_id DESC \
    \n LIMIT 0, 100";

#[test]
fn published_count_matches_the_recorded_statement() {
    assert_eq!(published_count_sql(238, Some("agent")), RECORDED_COUNT_SQL);
}

#[test]
fn published_page_matches_the_recorded_statement() {
    assert_eq!(
        published_page_sql(238, Some("agent"), 0, 100),
        RECORDED_PAGE_SQL
    );
}

#[test]
fn published_filter_drops_the_resource_type_when_unset() {
    let sql = published_page_sql(238, None, 20, 20);
    assert!(sql.contains("WHERE marketplace_resources.owner_user_id = 238 ORDER BY"));
    assert!(sql.ends_with("\n LIMIT 20, 20"));
    assert!(!sql.contains("resource_type ="));
}

#[test]
fn published_kinds_skips_the_query_for_an_empty_id_list() {
    assert!(published_kinds_sql(&[]).is_none());
    let sql = published_kinds_sql(&[11, 7]).unwrap();
    assert!(sql.contains("WHERE kinds.id IN (11, 7) AND kinds.is_active = true"));
}
