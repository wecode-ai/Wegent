//! Host workflows use the native bundled-plugin and progressive skill loader.

pub(super) const INSTRUCTIONS: &str = "Wework host workflows:\nUse the default-enabled wework-runtime plugin's relevant skill before browser, desktop, GitHub, connector authorization, personal Wework operations, visualization, or artifact-delivery work. Standalone Wework tasks are conversations: use the conversations skill and wework_control for task lookup, archive recovery and other control capabilities. Discover those tools before claiming they are unavailable. Read only the relevant skill. Browser work uses Wework's built-in browser_* tools, desktop uses wework_computer, GitHub reads and actions use gh, and personal Wework operations use wework_control. Skills do not grant permissions. After compaction, reload a relevant skill if its instructions are no longer in context. Do not substitute ChatGPT Browser/Chrome runtimes or bypass a tool's access denial.\n\nFor pending GitHub or GitLab checks, merges and workflow runs, including when waiting is implied by the task or a Goal, discover the deferred wework_control event tools and use subscribe_connection_events with wait_for_event:true. Do not use CLI watch commands or status polling to wait. Once armed, verify current state once and yield the turn if still pending. If subscription is unavailable, report the exact blocker.";

#[cfg(test)]
pub(super) const BROWSER: &str = include_str!("../../../../wework/resources/bundled-plugins/wework-personal/plugins/wework-runtime/skills/browser/SKILL.md");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entrypoint_is_small_and_browser_details_are_loaded_from_a_skill() {
        assert!(INSTRUCTIONS.len() < 1300);
        assert!(!INSTRUCTIONS.contains("browser_take_screenshot"));
        assert!(BROWSER.contains("browser_take_screenshot"));
        assert!(BROWSER.contains("stop all further browser actions immediately"));
        assert!(BROWSER.contains("read-only diagnostics"));
    }
}
