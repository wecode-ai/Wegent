//! Public endpoint declarations contain authorization scopes, never private assistant settings.
use crate::task_runtime::{personal_stand_in::stand_in_identities, LocalTaskStore};
use serde_json::{json, Value};

pub(super) fn declaration(device: &str) -> Value {
    if device.trim().is_empty() {
        return json!({"version":1,"roles":[]});
    }
    let settings = LocalTaskStore::from_env_if_exists()
        .and_then(|store| {
            store
                .map(|store| store.declared_personal_stand_ins(device))
                .transpose()
        })
        .ok()
        .flatten()
        .unwrap_or_default();
    public_declaration(&settings, device)
}

fn public_declaration(settings: &[Value], device: &str) -> Value {
    let roles: Vec<Value> = settings
        .iter()
        .filter(|settings| settings["lifecycle"]["status"].is_null())
        .flat_map(stand_in_identities)
        .filter(|role| {
            role["id"] == "@primary"
                && role["executionDeviceId"]
                    .as_str()
                    .map_or(true, |owner| owner.is_empty() || owner == device)
        })
        .map(|role| {
            let collaboration = &role["collaboration"];
            let project_policies: Vec<Value> = collaboration["projectPolicies"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|row| {
                    json!({"id":row["id"],"store":row["store"],"policy":public_policy(&row["policy"])})
                })
                .collect();
            let policy = public_policy(&collaboration["policy"]);
            json!({
                "id":role["id"],"userId":role["userId"],"enabled":role["enabled"],
                "enabledSince":role["enabledAfter"],"version":role["version"],
                "collaboration":{
                    "enabled":collaboration["enabled"] == true,
                    "allProjects":collaboration["allProjects"] == true,
                    "projects":public_projects(&collaboration["projects"]),
                    "excludedProjects":public_projects(&collaboration["excludedProjects"]),
                    "tags":collaboration["tags"].as_array().cloned().unwrap_or_default(),
                    "policy":policy,
                    "projectPolicies":project_policies,
                },
                "handlingPolicy":policy,
            })
        })
        .collect();
    json!({"version":1,"roles":roles})
}

fn public_projects(projects: &Value) -> Vec<Value> {
    projects
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| json!({"id":row["id"],"store":row["store"]}))
        .collect()
}

fn public_policy(policy: &Value) -> Value {
    json!({"automatic":policy["automatic"] != false,"askBeforeAct":policy["askBeforeAct"] == true})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declaration_preserves_primary_authority_without_private_settings() {
        let settings = json!({"userId":7,"version":9,"executionDeviceId":"device",
            "roles":[{"id":"review","prompt":"private"}],
            "primary":{"enabled":true,"enabledAfter":"2026-11-16T00:00:00Z",
                "prompt":"private prompt","preferences":"private preferences","model":{"apiKey":"private"},
                "collaboration":{"enabled":true,"allProjects":true,"tags":["bug"],
                    "projects":[],"excludedProjects":[{"id":"excluded","store":"cloud","private":"secret"}],
                    "policy":{"automatic":true,"askBeforeAct":true},
                    "projectPolicies":[{"id":"manual","store":"cloud","policy":{"automatic":false,"askBeforeAct":true}}]}}});
        let declaration = public_declaration(&[settings], "device");
        let roles = declaration["roles"].as_array().unwrap();
        assert_eq!(roles.len(), 1);
        assert_eq!(roles[0]["id"], "@primary");
        assert_eq!(roles[0]["userId"], 7);
        assert_eq!(roles[0]["version"], 9);
        assert_eq!(roles[0]["enabledSince"], "2026-11-16T00:00:00Z");
        assert_eq!(
            roles[0]["collaboration"]["projectPolicies"][0]["policy"]["automatic"],
            false
        );
        assert_eq!(
            roles[0]["collaboration"]["excludedProjects"],
            json!([{"id":"excluded","store":"cloud"}])
        );
        assert!(!declaration.to_string().contains("private"));
        assert_eq!(
            public_declaration(&[], "device"),
            json!({"version":1,"roles":[]})
        );
    }

    #[test]
    fn declaration_reads_do_not_move_another_devices_authorization() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let mut settings = store.personal_stand_in(7, "owner-device").unwrap();
        settings["primary"] = json!({"enabled":true,"prompt":"private","preferences":"",
            "collaboration":{"enabled":true,"allProjects":true,"projects":[],"excludedProjects":[],"tags":[]}});
        store
            .save_personal_stand_in(7, "owner-device", settings)
            .unwrap();
        assert!(store
            .declared_personal_stand_ins("other-device")
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .declared_personal_stand_ins("owner-device")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store.personal_stand_in(7, "").unwrap()["executionDeviceId"],
            "owner-device"
        );
    }

    #[test]
    fn declaration_revokes_stopped_profiles_and_primary_roles_selected_on_another_device() {
        let mut settings = json!({"userId":7,"version":1,"executionDeviceId":"device","roles":[],
            "primary":{"enabled":true,"executionDeviceId":"other","collaboration":{"enabled":true,"allProjects":true}}});
        assert_eq!(
            public_declaration(&[settings.clone()], "device")["roles"],
            json!([])
        );
        settings["primary"]["executionDeviceId"] = json!("device");
        assert_eq!(
            public_declaration(&[settings.clone()], "device")["roles"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        settings["lifecycle"] = json!({"status":"stopped"});
        assert_eq!(
            public_declaration(&[settings], "device")["roles"],
            json!([])
        );
    }
}
