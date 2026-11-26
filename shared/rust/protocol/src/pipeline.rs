// SPDX-License-Identifier: Apache-2.0

/// Select the text a Team member explicitly passes to the next stage.
pub fn handoff_text(mode: &str, original: &str, previous: &str) -> String {
    let mut parts = Vec::new();
    if matches!(mode, "original_user" | "original_and_previous") && !original.trim().is_empty() {
        parts.push(format!("Original user request:\n{}", original.trim()));
    }
    if matches!(mode, "previous_bot" | "original_and_previous") && !previous.trim().is_empty() {
        parts.push(format!("Previous stage output:\n{}", previous.trim()));
    }
    parts.join("\n\n")
}
