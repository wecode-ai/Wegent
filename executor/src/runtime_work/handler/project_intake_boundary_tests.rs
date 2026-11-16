use super::*;

#[tokio::test]
async fn project_intake_validates_assignment_age_against_each_saved_project_connection() {
    for project_save in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"New connection"})).unwrap())
            .unwrap();
        let mut personal = store.personal_stand_in(7, "mac").unwrap();
        personal["roles"][0]["enabled"] = json!(true);
        personal["roles"][0]["collaboration"]["enabled"] = json!(true);
        personal["roles"][0]["collaboration"]["allProjects"] = json!(false);
        let mut saved = store.save_personal_stand_in(7, "mac", personal).unwrap();
        let old = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Previously assigned","assignee_user_id":7}))
                    .unwrap(),
            )
            .unwrap();
        if project_save {
            let config = project_role(&saved["roles"][0], 7, &project.id, "local");
            store
                .save_stand_in_settings(&project.id, 7, config)
                .unwrap();
        } else {
            saved["roles"][0]["collaboration"]["projects"] =
                json!([{"id":project.id,"store":"local"}]);
            store.save_personal_stand_in(7, "mac", saved).unwrap();
        }
        let fresh = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"New assignment","assignee_user_id":7}))
                    .unwrap(),
            )
            .unwrap();
        let role = &store.personal_stand_in(7, "mac").unwrap()["roles"][0];
        let handler = RuntimeWorkRpcHandler::new("mac", "unused");
        for (issue, eligible) in [(&old, false), (&fresh, true)] {
            let event = json!({"projectId":project.id,"projectStore":"local",
                "issueId":issue.id,"assignmentId":format!("{}-1",issue.id)});
            let result = handler
                .read_assignment_intake(&store, 7, role, &event)
                .await;
            if eligible {
                assert!(
                    result.is_ok(),
                    "New assignment must be accepted: {result:?}"
                );
            } else {
                assert_eq!(result.unwrap_err().code, "invalid_assignment");
            }
        }
    }
}
