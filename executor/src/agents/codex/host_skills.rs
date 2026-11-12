//! Host workflows use the native bundled-plugin and progressive skill loader.

pub(super) const INSTRUCTIONS: &str = "Wework host workflows:\nUse the default-enabled wework-runtime plugin's relevant skill before browser, desktop, GitHub, connector authorization, conversation/schedule, visualization, workbench or artifact-delivery work. For workbenches and small desktop utilities, read workbenches and use the task-bound WEWORK_CLI_PATH. Both lightweight and extended workbenches use DSH. Read only the relevant skill. Browser work uses Wework's built-in browser_* tools, desktop work uses wework_computer, GitHub uses gh, and personal Wework operations use wework_control. Skills do not grant permissions. After compaction, reload a relevant skill if its instructions are no longer in context. Do not substitute ChatGPT Browser/Chrome runtimes or bypass a tool's access denial.";

#[cfg(test)]
pub(super) const BROWSER: &str = include_str!("../../../../wework/resources/bundled-plugins/wework-personal/plugins/wework-runtime/skills/browser/SKILL.md");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entrypoint_is_small_and_browser_details_are_loaded_from_a_skill() {
        assert!(INSTRUCTIONS.len() < 850);
        assert!(!INSTRUCTIONS.contains("browser_take_screenshot"));
        assert!(BROWSER.contains("browser_take_screenshot"));
        assert!(BROWSER.contains("stop all further browser actions immediately"));
        assert!(BROWSER.contains("read-only diagnostics"));
    }

    #[test]
    fn uses_unified_dsh_workbenches_for_desktop_utilities() {
        assert!(INSTRUCTIONS.contains("Both lightweight and extended workbenches use DSH"));
        assert!(INSTRUCTIONS.contains("task-bound WEWORK_CLI_PATH"));
        let workflow = include_str!("../../../../wework/resources/bundled-plugins/wework-personal/plugins/wework-runtime/skills/workbenches/SKILL.md");
        assert!(workflow.contains("request_user_input_async"));
        assert!(workflow.contains("Do not bypass the confirmation"));
        let commands: Vec<_> = workflow
            .lines()
            .filter(|line| line.starts_with('"') && line.contains(" workbench "))
            .collect();
        assert!(commands
            .iter()
            .any(|line| line.contains(" workbench install ")));
        assert!(commands
            .iter()
            .any(|line| line.contains(" workbench launch ")));
        assert!(commands
            .iter()
            .all(|line| line.starts_with("\"$WEWORK_CLI_PATH\" workbench ")));
        assert!(!workflow.lines().any(|line| line.starts_with("wework ")));
    }
}
