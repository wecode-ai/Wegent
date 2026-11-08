//! Application-owned task identity and instruction eligibility for Claude.
use crate::process::CommandSpec;
use crate::protocol::ExecutionRequest;
pub(crate) use wegent_claude_harness::claude_code::{
    claude_config_dir, claude_task_dir, configure_claude_default_settings,
    configure_claude_file_edit_hooks, has_task_skill_names, model_id, prompt_text,
    restore_claude_plugin_cache, run_pre_execute_hook,
};

fn launch_context(
    request: &ExecutionRequest,
) -> wegent_claude_harness::claude_code::ClaudeLaunchContext<'static> {
    wegent_claude_harness::claude_code::ClaudeLaunchContext {
        task_identity_environment: super::task_identity::task_identity_env(request),
        artifact_instructions: crate::artifact_cli::AGENT_INSTRUCTIONS,
        control_instructions: crate::workbench_control::ControlContext::from_request(request)
            .map(|_| crate::workbench_control::INSTRUCTIONS),
    }
}

pub fn build_claude_command(request: &ExecutionRequest, binary: &str) -> CommandSpec {
    wegent_claude_harness::claude_code::build_claude_command(
        request,
        binary,
        &launch_context(request),
    )
}

#[cfg(test)]
fn execution_system_prompt(request: &ExecutionRequest) -> Option<String> {
    wegent_claude_harness::claude_code::execution_system_prompt(request, &launch_context(request))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn claude_command_uses_configured_desktop_permission_mode() {
        let mut request = ExecutionRequest {
            prompt: Value::String("inspect the project".to_owned()),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "claude_permission_mode".to_owned(),
            Value::String("plan".to_owned()),
        );

        let command = build_claude_command(&request, "claude");
        let permission_index = command
            .args()
            .iter()
            .position(|argument| argument == "--permission-mode")
            .expect("permission mode flag");

        assert_eq!(command.args()[permission_index + 1], "plan");
    }

    #[test]
    fn claude_command_uses_non_interactive_default_permission_mode() {
        let mut request = ExecutionRequest {
            prompt: Value::String("inspect the project".to_owned()),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "claude_permission_mode".to_owned(),
            Value::String("default".to_owned()),
        );

        let command = build_claude_command(&request, "claude");
        let permission_index = command
            .args()
            .iter()
            .position(|argument| argument == "--permission-mode")
            .expect("permission mode flag");

        assert_eq!(command.args()[permission_index + 1], "bypassPermissions");
    }

    #[test]
    fn claude_command_rejects_unknown_permission_mode() {
        let mut request = ExecutionRequest {
            prompt: Value::String("inspect the project".to_owned()),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "claude_permission_mode".to_owned(),
            Value::String("unsafe-custom-mode".to_owned()),
        );

        let command = build_claude_command(&request, "claude");
        let permission_index = command
            .args()
            .iter()
            .position(|argument| argument == "--permission-mode")
            .expect("permission mode flag");

        assert_eq!(command.args()[permission_index + 1], "bypassPermissions");
    }

    #[test]
    fn execution_prompt_tells_tool_enabled_agents_to_declare_deliverables() {
        let request = ExecutionRequest {
            system_prompt: "Follow the user request".to_owned(),
            ..ExecutionRequest::default()
        };

        let prompt = execution_system_prompt(&request).unwrap();

        assert!(prompt.contains("Follow the user request"));
        assert!(prompt.contains("artifact declare --path"));
        assert!(prompt.contains("sends metadata only"));
    }

    #[test]
    fn legacy_ghost_keeps_stored_rules_and_appends_runtime_declaration_rules() {
        let legacy = "Create files in mnt/outputs and share computer://path/to/file links.";
        let request = ExecutionRequest {
            system_prompt: legacy.to_owned(),
            ..ExecutionRequest::default()
        };

        let command = build_claude_command(&request, "claude");
        let index = command
            .args()
            .iter()
            .position(|argument| argument == "--append-system-prompt")
            .expect("append system prompt flag");
        let instructions = &command.args()[index + 1];

        assert_eq!(request.system_prompt, legacy);
        assert!(instructions.starts_with(legacy));
        assert!(instructions.ends_with(crate::artifact_cli::AGENT_INSTRUCTIONS));
        assert!(instructions.contains("artifact declare --path"));
    }

    #[test]
    fn execution_prompt_skips_artifact_command_when_tools_are_disabled() {
        let mut request = ExecutionRequest {
            system_prompt: "Generate text only".to_owned(),
            ..ExecutionRequest::default()
        };
        request
            .extra
            .insert("enable_tools".to_owned(), Value::Bool(false));

        let prompt = execution_system_prompt(&request).unwrap();

        assert_eq!(prompt, "Generate text only");
        assert!(!prompt.contains("artifact declare --path"));
    }

    #[test]
    fn execution_prompt_preserves_artifact_and_personal_control_instructions() {
        let mut request = ExecutionRequest {
            system_prompt: "Follow the project rules".to_owned(),
            extra: serde_json::Map::from_iter([
                ("runtimeDeviceId".into(), json!("prompt-device")),
                ("runtimeLocalTaskId".into(), json!("prompt-task")),
            ]),
            ..Default::default()
        };
        let prompt = execution_system_prompt(&request).unwrap();
        assert!(prompt.starts_with("Follow the project rules"));
        assert!(prompt.contains(crate::artifact_cli::AGENT_INSTRUCTIONS));
        assert!(prompt.contains(crate::workbench_control::INSTRUCTIONS));

        request
            .extra
            .insert("origin".into(), json!({"dispatchRole":"executor"}));
        let prompt = execution_system_prompt(&request).unwrap();
        assert!(prompt.contains(crate::artifact_cli::AGENT_INSTRUCTIONS));
        assert!(!prompt.contains(crate::workbench_control::INSTRUCTIONS));

        request.extra.remove("origin");
        request.extra.insert("enable_tools".into(), json!(false));
        assert_eq!(
            execution_system_prompt(&request).unwrap(),
            "Follow the project rules"
        );
    }
}
