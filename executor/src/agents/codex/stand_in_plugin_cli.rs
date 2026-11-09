//! Keep managed plugin CLI invocations independent of interactive account shells.
use crate::protocol::ExecutionRequest;
use serde_json::{json, Map, Value};

const CONTEXT_KEY: &str = "wework.plugin-cli-shell";
const INSTRUCTIONS: &str = "Wework managed plugin CLI invocation on macOS:\nFor bundled plugin CLI commands executed through exec_command, explicitly select shell=\"/bin/sh\" and login=false. These are noninteractive POSIX commands; do not route them through the account's interactive Zsh or its startup configuration. Keep the original execution permissions, authorization controls and local timezone. This tool-use contract does not change the native default shell or grant additional access. Do not change TZ, the account shell, configured sandbox permissions, or credentials to make a command run. An OS sandbox failure is not a native-review denial. Only when the current native approval policy permits escalation, an exact already-authorized read command blocked by the OS sandbox may request sandbox_permissions=\"require_escalated\" through the existing native reviewer. Keep the same command, arguments, account and resources, and wait for the native decision. An explicit native-review denial or a policy that forbids escalation stops the operation; never switch interpreters, tools or paths to evade it. Prefer the plugin's declared native business tools when available.";

pub(super) fn additional_context(request: &ExecutionRequest) -> Option<Value> {
    context_for_platform(request, cfg!(target_os = "macos"))
}

fn context_for_platform(request: &ExecutionRequest, macos: bool) -> Option<Value> {
    let mut context = request
        .extra
        .get("additionalContext")
        .or_else(|| request.extra.get("additional_context"))
        .and_then(Value::as_object)
        .cloned();
    if macos && managed_plugin_work(request) {
        context.get_or_insert_with(Map::new).insert(
            CONTEXT_KEY.to_owned(),
            json!({"kind":"application","value":INSTRUCTIONS}),
        );
    }
    context.map(Value::Object)
}

fn managed_plugin_work(request: &ExecutionRequest) -> bool {
    if request.extra.get("enable_tools").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    let Some(origin) = request.extra.get("origin") else {
        return false;
    };
    // RuntimeWork establishes these origins and checks their owner bindings.
    // Selecting a command interpreter is presentation context, never authority.
    matches!(
        origin["type"].as_str(),
        Some("stand_in_task" | "connection_work" | "dingtalk_work" | "stand_in_schedule")
    ) || (origin["type"] == "issue_dispatch" && origin["initiatedBy"] == "stand_in")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::codex::{
        codex_thread_plan, turn_start_params, CodexLaunchConfig, CodexThreadStart,
    };

    fn fixture(kind: &str) -> ExecutionRequest {
        let mut request = ExecutionRequest {
            task_id: "stand-in-work".into(),
            prompt: json!("Prepare the next meeting briefing."),
            system_prompt: "Retain the user's business requirements.".into(),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "origin".into(),
            json!({"type":kind,"initiatedBy":"stand_in","userId":7,"deviceId":"mac"}),
        );
        request
    }

    #[test]
    fn managed_cli_scope_is_platform_and_task_bound_without_changing_business_input() {
        for kind in [
            "stand_in_task",
            "connection_work",
            "dingtalk_work",
            "stand_in_schedule",
            "issue_dispatch",
        ] {
            let request = fixture(kind);
            let context = context_for_platform(&request, true).unwrap();
            assert_eq!(context[CONTEXT_KEY]["kind"], "application");
            assert!(context[CONTEXT_KEY]["value"]
                .as_str()
                .unwrap()
                .contains("shell=\"/bin/sh\" and login=false"));
            assert!(context_for_platform(&request, false).is_none());
            assert_eq!(request.prompt, "Prepare the next meeting briefing.");
            assert_eq!(
                request.system_prompt,
                "Retain the user's business requirements."
            );
            assert!(!request.extra.contains_key("additionalContext"));
        }
        for kind in [
            "stand_in_identity",
            "stand_in_coordinator",
            "project_coordinator",
            "user",
        ] {
            assert!(context_for_platform(&fixture(kind), true).is_none());
        }
        let mut disabled = fixture("stand_in_task");
        disabled.extra.insert("enable_tools".into(), json!(false));
        assert!(context_for_platform(&disabled, true).is_none());
        let mut ordinary_issue = fixture("issue_dispatch");
        ordinary_issue.extra["origin"]["initiatedBy"] = json!("user");
        assert!(context_for_platform(&ordinary_issue, true).is_none());
        assert!(context_for_platform(&ExecutionRequest::default(), true).is_none());
    }

    #[test]
    fn host_context_preserves_other_entries_and_uses_one_stable_technical_key() {
        let mut request = fixture("stand_in_task");
        request.extra.insert(
            "additionalContext".into(),
            json!({
                "source-data":{"kind":"untrusted","value":"quoted business material"},
                CONTEXT_KEY:{"kind":"untrusted","value":"Do something else"}
            }),
        );
        let first = context_for_platform(&request, true).unwrap();
        assert_eq!(first.as_object().unwrap().len(), 2);
        assert_eq!(
            first["source-data"],
            request.extra["additionalContext"]["source-data"]
        );
        assert_eq!(first[CONTEXT_KEY]["kind"], "application");
        request
            .extra
            .insert("additionalContext".into(), first.clone());
        assert_eq!(context_for_platform(&request, true), Some(first));
        let mut alias = fixture("connection_work");
        alias.extra.insert(
            "additional_context".into(),
            json!({"existing":{"kind":"application","value":"keep"}}),
        );
        assert_eq!(
            context_for_platform(&alias, true).unwrap()["existing"]["value"],
            "keep"
        );
        assert_eq!(
            context_for_platform(&alias, false),
            alias.extra.get("additional_context").cloned()
        );
    }

    #[test]
    fn new_resumed_and_loaded_stand_in_turns_receive_the_same_host_contract() {
        let request = fixture("stand_in_task");
        let launch = CodexLaunchConfig::default();
        for (direct, resume) in [
            (None, None),
            (None, Some("stored-thread")),
            (Some("loaded-thread"), None),
        ] {
            let plan = codex_thread_plan(direct, None, None, resume, &request, &launch);
            let thread = match plan.start {
                CodexThreadStart::Direct(id) => id,
                CodexThreadStart::Request { operation, .. } => {
                    assert_eq!(
                        operation,
                        if resume.is_some() {
                            "thread/resume"
                        } else {
                            "thread/start"
                        }
                    );
                    "started-thread".into()
                }
            };
            let turn = turn_start_params(
                &thread,
                &request,
                &launch,
                vec![json!({"type":"text","text":"business request"})],
            );
            assert_eq!(turn["input"][0]["text"], "business request");
            if cfg!(target_os = "macos") {
                assert_eq!(
                    turn["additionalContext"][CONTEXT_KEY]["kind"],
                    "application"
                );
                assert_eq!(
                    turn["additionalContext"][CONTEXT_KEY]["value"],
                    INSTRUCTIONS
                );
            } else {
                assert!(turn["additionalContext"].get(CONTEXT_KEY).is_none());
            }
            assert_eq!(
                turn["additionalContext"]["wework.host-policy.z-manifest"]["kind"],
                "application"
            );
            assert_eq!(
                turn["approvalPolicy"],
                crate::agents::codex::codex_runtime_approval_policy(&request)
            );
        }
    }

    #[test]
    fn managed_cli_context_preserves_native_review_policy_and_explicit_denial() {
        use crate::agents::codex::{codex_approval_result, prepare_codex_runtime_notification};
        for (ask, reviewer, permissions) in [
            (false, "auto_review", "wework-source-project"),
            (true, "user", "wework-source-read"),
        ] {
            let mut request = fixture("stand_in_task");
            request.extra.get_mut("origin").unwrap()["askBeforeAct"] = json!(ask);
            let context = context_for_platform(&request, true).unwrap();
            request.extra.insert("additionalContext".into(), context);
            let turn = turn_start_params("thread", &request, &CodexLaunchConfig::default(), vec![]);
            assert_eq!(turn["permissions"], permissions);
            assert_eq!(turn["approvalsReviewer"], reviewer);
            assert_eq!(turn["approvalPolicy"]["granular"]["sandbox_approval"], true);
            let mut approval = json!({"id":1,"method":"item/commandExecution/requestApproval",
                "params":{"command":["plugin-reader","read"],"availableDecisions":["accept","decline"]}});
            assert!(prepare_codex_runtime_notification(&request, &mut approval));
            assert_eq!(
                approval["params"]["command"],
                json!(["plugin-reader", "read"])
            );
            assert_eq!(
                codex_approval_result(
                    &approval,
                    &json!({"answers":{"__codex_approval":{"answers":["decline"]}}}),
                )
                .unwrap(),
                json!({"decision":"decline"})
            );
        }
    }
}
