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
        additional_instructions: crate::python_runtime::managed_python_bridge_configured()
            .then_some(crate::plugin_python::INSTRUCTIONS),
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
mod tests {
    use super::*;
    use serde_json::Value;

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
}
