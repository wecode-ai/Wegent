use super::*;

fn issue() -> Issue {
    Issue {
        id: "i1".into(),
        title: "Independent".into(),
        description: String::new(),
        status: pending(),
        priority: medium(),
        creator_id: 7,
        assignee_id: None,
        version: 3,
        metadata: Json(Metadata {
            standalone: true,
            participants: vec![8],
            ..Default::default()
        }),
        people: Json(Default::default()),
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn input() -> Input {
    Input {
        title: "Independent".into(),
        description: String::new(),
        status: pending(),
        priority: medium(),
        assignee_id: None,
        participants: vec![8],
        archived: false,
        due_at: None,
        version: Some(3),
    }
}

#[test]
fn private_by_default_and_revocation_are_live() {
    let mut row = issue();
    row.metadata.0.participants.clear();
    assert!(row.can_read(7));
    assert!(!row.can_read(8));
    row.metadata.0.participants.push(8);
    assert!(row.can_read(8));
    assert!(!row.can_read(9));
    row.metadata.0.participants.clear();
    assert!(!row.can_read(8));
}

#[test]
fn invitations_require_creator_and_assignments_never_grant_access() {
    let row = issue();
    let mut body = input();
    assert_eq!(admission(&row, 8, &body), Admission::Allowed);
    body.participants.push(9);
    assert_eq!(admission(&row, 8, &body), Admission::OwnerRequired);
    assert_eq!(admission(&row, 7, &body), Admission::Allowed);
    body.assignee_id = Some(10);
    assert_eq!(admission(&row, 7, &body), Admission::InvalidPeople);
    assert_eq!(admission(&row, 9, &body), Admission::Missing);
}

#[test]
fn concurrent_edits_require_the_observed_version() {
    let mut body = input();
    body.version = None;
    assert_eq!(admission(&issue(), 7, &body), Admission::Conflict);
    body.version = Some(2);
    assert_eq!(admission(&issue(), 7, &body), Admission::Conflict);
}

#[test]
fn storage_creates_no_project_or_space() {
    let sql = insert_sql(&Default::default());
    assert!(!sql.contains("cloud_project_id"));
    assert!(!sql.contains("workspace_id"));
    assert!(sql.contains("'task'"));
}

#[test]
fn unknown_permission_fields_and_invalid_dates_are_rejected() {
    assert!(serde_json::from_value::<Input>(json!({"title":"Work","creator_id":9})).is_err());
    let mut body = input();
    body.due_at = Some("2026-02-30".into());
    assert!(body.validate().is_err());
    body.due_at = Some("2026-11-30".into());
    assert!(body.validate().is_ok());
}

#[test]
fn active_route_inventory_selects_all_independent_issue_operations() {
    let config = crate::load_routes_config(std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/config/routes.toml"
    )))
    .unwrap();
    let routes = crate::RouteTable::compile(config).unwrap();
    for (method, path) in [
        (http::Method::GET, "/api/v1/personal-issues"),
        (http::Method::POST, "/api/v1/personal-issues"),
        (http::Method::GET, "/api/v1/personal-issues/one"),
        (http::Method::PATCH, "/api/v1/personal-issues/one"),
        (http::Method::DELETE, "/api/v1/personal-issues/one"),
        (http::Method::GET, "/api/v1/personal-issues/one/comments"),
        (http::Method::POST, "/api/v1/personal-issues/one/comments"),
        (http::Method::POST, "/api/v1/personal-issues/one/project"),
    ] {
        assert!(routes.matches(&method, path), "{method} {path}");
    }
}
