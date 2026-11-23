// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `find_skill_by_name` (`skill_resolution.py:28-110`) statement order. The
//! recorded reads return no rows, so the contract is the sequence, the
//! predicates and which side of the reference each parameter binds, not a
//! resolved Skill.

use super::*;

/// A Ghost Skill in a group team walks the owner's `default` scope, the team
/// namespace and the public scope. Steps 3 and 4 need the binding access
/// helpers, which this fixture omits (`access: None`), so their reads are not
/// part of this sequence.
#[tokio::test]
async fn a_group_team_reads_the_owner_default_then_the_team_then_public() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let skill = find_skill_by_name(
        &mysql,
        "weather-app-100d-analysis-glm",
        6499,
        "tqt-weather",
        None,
    )
    .await
    .expect("read");
    assert!(skill.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 3, "{queries:?}");
    assert!(
        queries[0].sql.contains(
            "WHERE kinds.user_id = ? AND kinds.kind = 'Skill' AND kinds.name = ? \
             AND kinds.namespace = ? AND kinds.is_active = true LIMIT 1"
        ),
        "{}",
        queries[0].sql
    );
    assert_eq!(queries[0].args, 3);
    assert_eq!(queries[0].first_integer, Some(6499));
    assert!(
        queries[1].sql.contains(
            "WHERE kinds.kind = 'Skill' AND kinds.name = ? AND kinds.namespace = ? \
             AND kinds.is_active = true LIMIT 1"
        ),
        "{}",
        queries[1].sql
    );
    assert_eq!(queries[1].args, 2);
    assert_eq!(queries[1].first_integer, None);
    assert!(queries[2].sql.contains("kinds.user_id = 0"), "{queries:?}");
    assert_eq!(queries[2].args, 1);
}

/// A `default`-namespace team has no team-namespace step, and the public read
/// is the last one that always runs.
#[tokio::test]
async fn a_default_team_skips_the_team_namespace_step() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    let skill = find_skill_by_name(
        &mysql,
        "weather-app-100d-analysis-glm",
        6499,
        "default",
        None,
    )
    .await
    .expect("read");
    assert!(skill.is_none());

    let queries = mysql.queries();
    assert_eq!(queries.len(), 2, "{queries:?}");
    assert_eq!(queries[0].first_integer, Some(6499));
    assert!(queries[1].sql.contains("kinds.user_id = 0"), "{queries:?}");
}
