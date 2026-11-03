// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub(super) const INSTRUCTIONS: &str = r#"Wework inline visualizations:
- Wework can render interactive HTML directly inside assistant messages. Use this when the user asks to explore something in the conversation, or when adjustable inputs, a calculator, simulation, or interactive chart materially improve the answer. Choose a useful visual proactively when appropriate. Keep simple answers and tables in Markdown, and static relationship diagrams in Mermaid. Requests to build or modify a website, application, or repository still require the actual project implementation.
- Create a self-contained HTML fragment in a durable, authorized task-owned directory, preferably `outputs/visualizations/` under the task's working directory. Use a unique descriptive filename for each new visualization or revision so earlier messages keep their original result. Do not use temporary directories or assume a personal Codex directory is writable. Use the absolute path on the execution device.
- Write literal UTF-8 markup with a unique root ID, root-scoped CSS, and inline JavaScript. Do not include doctype/html/head/body wrappers. Keep the file under 1 MiB, embed the required data, and make the initial state useful. Read the file back and check that every selected element exists and that the primary input updates the result.
- Render the result by placing this content reference on its own line in the same turn's final response, outside code fences: visualize{"path":"/absolute/task-owned/outputs/visualizations/calculator.html","title":"Calculator"}. Replace the example path and title with the actual file. Optional `"mode":"wide"` is for desktop application mockups or comparisons that require extra width. Ordinary calculators and charts should fit the normal message width. Do not emit the reference in progress messages or replace it with a Markdown file link.
- The host supplies `--background`, `--foreground`, `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--border`, `--input`, `--ring`, `--viz-series-1` through `--viz-series-6`, `--font-size-base`, and `--font-sans`. Use these theme-aware tokens, relative type sizes, responsive layouts, semantic labeled controls, visible focus, and touch targets at least 44px. Supply any utility classes and control styling yourself; the host does not provide a UI framework.
- The fragment runs in a sandbox with JavaScript enabled. Keep interactions local to its DOM; do not depend on `window.openai`, parent DOM access, Electron, local imports, external scripts, network requests, credentials, or browser storage. The host handles resizing. Use CSS, inline SVG, or canvas for graphics. Inline response fragments are conversation content, not downloadable artifact deliverables; declare an exported standalone file only when the user asks for one.
- Keep the surrounding prose concise and explain only what the user can learn or adjust. Do not expose the rendering protocol or repeat the visualization's data in prose unless requested."#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::codex::{
        thread_fork_params, thread_resume_params, thread_start_params, CodexLaunchConfig,
    };
    use crate::protocol::ExecutionRequest;
    use serde_json::json;

    #[test]
    fn inline_visualization_contract_reaches_new_resumed_and_forked_threads() {
        let request = ExecutionRequest {
            system_prompt: "Explain the user's data.".to_owned(),
            ..ExecutionRequest::default()
        };
        let launch = CodexLaunchConfig {
            user_developer_instructions: "Use Chinese.".to_owned(),
            ..CodexLaunchConfig::default()
        };

        for params in [
            thread_start_params(&request, &launch),
            thread_resume_params("existing-thread", &request, &launch),
            thread_fork_params("existing-thread", None, &request, &launch),
        ] {
            let instructions = params["developerInstructions"].as_str().unwrap();
            assert!(instructions.starts_with("Use Chinese.\n\nExplain the user's data."));
            assert_eq!(instructions.matches(INSTRUCTIONS).count(), 1);
            assert!(instructions.contains("visualize{\"path\":"));
            assert!(instructions.contains("outputs/visualizations/"));
            assert!(instructions.contains("unique descriptive filename"));
            assert!(instructions.contains("do not depend on `window.openai`"));
            assert!(instructions.contains("not downloadable artifact deliverables"));
        }
    }

    #[test]
    fn inline_visualizations_are_not_advertised_to_text_only_auxiliary_threads() {
        let mut request = ExecutionRequest::default();
        request.extra.insert("enable_tools".into(), json!(false));
        let launch = CodexLaunchConfig::default();

        for params in [
            thread_start_params(&request, &launch),
            thread_resume_params("existing-thread", &request, &launch),
            thread_fork_params("existing-thread", None, &request, &launch),
        ] {
            let instructions = params["developerInstructions"].as_str().unwrap();
            assert!(instructions.contains("Do not execute actions or call tools."));
            assert!(!instructions.contains("Wework inline visualizations:"));
            assert!(!instructions.contains("visualize"));
        }
    }
}
