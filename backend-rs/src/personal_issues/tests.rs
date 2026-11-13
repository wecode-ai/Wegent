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
        resource_participants: Vec::new(),
        assignee_resource: None,
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
        (
            http::Method::GET,
            "/api/v1/personal-issues/one/resources/agent/12",
        ),
    ] {
        assert!(routes.matches(&method, path), "{method} {path}");
    }
}

#[test]
fn resource_invitations_are_explicit_and_do_not_grant_human_access() {
    let mut row = issue();
    row.metadata
        .0
        .resource_participants
        .push(ResourceParticipant {
            kind: "agent".into(),
            id: 12,
            name: "Agent".into(),
            team_id: Some(12),
            ..Default::default()
        });
    let mut body = input();
    body.resource_participants = participants::references(&row.metadata.0.resource_participants);
    assert_eq!(admission(&row, 8, &body), Admission::Allowed);
    body.resource_participants.clear();
    assert_eq!(admission(&row, 8, &body), Admission::OwnerRequired);
    assert_eq!(admission(&row, 7, &body), Admission::Allowed);
    assert!(!row.can_read(12));
}

#[test]
fn resource_assignment_requires_an_invitation_and_never_accepts_credentials() {
    let mut body = input();
    body.assignee_resource = Some(ResourceInvitation {
        kind: "agent".into(),
        id: 12,
    });
    assert!(body.validate().is_err());
    body.resource_participants
        .push(body.assignee_resource.clone().unwrap());
    assert!(body.validate().is_ok());
    body.assignee_id = Some(8);
    assert!(body.validate().is_err());
    assert!(serde_json::from_value::<Input>(json!({"title":"Work","resource_participants":[{"kind":"agent","id":12,"credentials":"private"}]})).is_err());
}

#[test]
fn issue_serialization_does_not_disclose_resource_configuration() {
    let mut row = issue();
    row.metadata
        .0
        .resource_participants
        .push(ResourceParticipant {
            kind: "group".into(),
            id: 12,
            name: "Invited group".into(),
            instructions: "private instructions".into(),
            group_snapshot: Some(json!({"private":"configuration"})),
            ..Default::default()
        });
    let stored = serde_json::to_value(&row.metadata.0).unwrap();
    assert_eq!(
        stored["resource_participants"][0]["instructions"],
        "private instructions"
    );
    let public = serde_json::to_value(&row).unwrap();
    let descriptor = &public["metadata"]["resource_participants"][0];
    assert_eq!(descriptor["name"], "Invited group");
    assert!(descriptor.get("instructions").is_none());
    assert!(descriptor.get("group_snapshot").is_none());
}
