// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::erp_provider::NoopErpProvider;
use crate::sql_test_support::KindQueryCapture;
use http::StatusCode;

fn membership(name: &str, role: &str) -> GroupMembership {
    GroupMembership {
        group_name: name.to_owned(),
        role: role.to_owned(),
    }
}

fn assert_denied(error: HttpError) {
    assert_eq!(error.status(), StatusCode::FORBIDDEN);
    assert_eq!(error.detail(), "Group access denied");
    let response = crate::http_compat::FastApiError::from(error);
    assert_eq!(response.validation_detail(), r#""Group access denied""#);
}

fn test_resolvers() -> crate::permissions::EntityResolvers<brz_redis::RedisService> {
    crate::permissions::EntityResolvers::public(
        brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test")
            .expect("lazy mysql"),
    )
}

#[tokio::test]
async fn default_group_request_is_denied_before_any_private_team_lookup() {
    let mysql = KindQueryCapture::default();
    let erp = ErpContext::<brz_redis::RedisService> {
        erp: &NoopErpProvider,
        redis: None,
    };
    // Different authenticated users must both be denied access to the group
    // branch, regardless of which user owns a personal team in `default`.
    for user_id in [7, 229] {
        let result = resolve_namespace_context(
            &mysql,
            &erp,
            &test_resolvers(),
            user_id,
            "group",
            Some("default"),
        )
        .await;
        assert_denied(result.err().expect("default is not a group"));
    }
    assert!(mysql.queries().is_empty());
}

#[tokio::test]
async fn non_member_group_request_is_denied_before_team_queries() {
    let mysql = KindQueryCapture::default();
    let erp = ErpContext::<brz_redis::RedisService> {
        erp: &NoopErpProvider,
        redis: None,
    };
    let result = resolve_namespace_context(
        &mysql,
        &erp,
        &test_resolvers(),
        7,
        "group",
        Some("private-group"),
    )
    .await;
    assert_denied(result.err().expect("the user has no group memberships"));
    let queries = mysql.queries();
    // `get_user_group_roles` always loads the active namespace names first;
    // the empty result then makes `get_effective_roles_in_groups` return
    // before the membership batch. `KindQueryCapture` returns no rows, so the
    // only recorded statement is that namespace-name read.
    assert_eq!(
        queries
            .iter()
            .filter(|query| query.sql.contains("FROM namespace"))
            .count(),
        1,
        "the active namespace-name read still runs: {queries:?}"
    );
    assert!(
        queries
            .iter()
            .all(|query| !query.sql.contains("resource_members")
                && !query.sql.contains("FROM kinds")),
        "an empty active-namespace set skips the membership batch and team queries: {queries:?}"
    );
    assert!(
        queries
            .iter()
            .all(|query| !query.sql.contains("FROM kinds"))
    );
}

#[test]
fn default_cannot_be_used_as_a_group_to_read_other_users_private_teams() {
    // Even a namespace membership named `default` cannot authorize the group
    // branch, which would otherwise return every owner's personal teams.
    let memberships = [membership("default", "Owner")];
    for scope in ["group", "all", "personal"] {
        assert_denied(
            select_group_namespaces(scope, Some("default"), &memberships, &[]).unwrap_err(),
        );
    }
}

#[test]
fn non_member_group_is_denied_regardless_of_scope() {
    let memberships = [membership("my-group", "Owner")];
    for scope in ["group", "all", "personal"] {
        assert_denied(
            select_group_namespaces(scope, Some("private-group"), &memberships, &[]).unwrap_err(),
        );
    }
}

#[test]
fn explicit_group_keeps_direct_and_inherited_team_use_permissions() {
    for role in [
        "Owner",
        "Maintainer",
        "Developer",
        "Reporter",
        "RestrictedAnalyst",
    ] {
        let memberships = [membership("parent", role)];
        for group in ["parent", "parent/child"] {
            let (names, roles) =
                select_group_namespaces("group", Some(group), &memberships, &[]).unwrap();
            assert_eq!(names, [group]);
            assert_eq!(roles.get(group).map(String::as_str), Some(role));
        }
    }
}

#[test]
fn unknown_roles_do_not_authorize_group_access() {
    assert_denied(
        select_group_namespaces(
            "group",
            Some("private-group"),
            &[membership("private-group", "Unknown")],
            &[],
        )
        .unwrap_err(),
    );
}

#[test]
fn unnamed_scopes_keep_personal_isolation_and_only_accessible_groups() {
    let memberships = [membership("parent", "RestrictedAnalyst")];
    let active_names = ["parent/child", "unrelated", "parent", "default"].map(str::to_owned);
    let (names, roles) =
        select_group_namespaces("personal", None, &memberships, &active_names).unwrap();
    assert!(names.is_empty());
    assert!(roles.is_empty());

    for scope in ["all", "group"] {
        for group_name in [None, Some("")] {
            let (names, roles) =
                select_group_namespaces(scope, group_name, &memberships, &active_names).unwrap();
            assert_eq!(names, ["parent", "parent/child"]);
            assert_eq!(roles.len(), 2);
        }
    }
}
