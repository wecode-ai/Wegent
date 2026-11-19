use super::*;

#[test]
fn dingtalk_blacklist_rechecks_queued_events_before_dispatch_without_revoking_reads() {
    let handler = RuntimeWorkRpcHandler::new("mac", "unused");
    for kind in ["group", "direct"] {
        let source = json!({"providerId":crate::task_runtime::personal_stand_in::DINGTALK_PROVIDER,"profile":"corp","kind":kind,"id":"blocked","enabledAfter":"2026-11-01T00:00:00Z","policy":{"automatic":true,"askBeforeAct":true}});
        let mut all = source.clone();
        all["id"] = json!("*");
        all["scope"] = json!("all");
        let mut role = json!({"id":"role","connections":[all]});
        let event = json!({"kind":"connection","source":source,"roleIds":["role"],"message":{"at":"2026-11-02T00:00:00Z"}});
        assert!(handler.validate_intake_role(&role, &event).is_ok());
        role["connections"][0]["excludedResources"] = json!([{"id":"blocked","name":"Blocked"}]);
        assert_eq!(
            handler
                .validate_intake_role(&role, &event)
                .unwrap_err()
                .code,
            "source_removed"
        );
        assert!(stand_in_connection(&role, &source).is_some());
        role["connections"][0]["excludedResources"] = json!([]);
        assert!(handler.validate_intake_role(&role, &event).is_ok());
    }
}
