// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use regex::Regex;

const APPLY_PATCH_CANDIDATES: [&str; 3] = ["apply_patch", "Write", "Edit"];

pub fn matches_tool(matcher: &Regex, canonical_tool: &str) -> bool {
    if canonical_tool == "apply_patch" {
        return APPLY_PATCH_CANDIDATES
            .iter()
            .any(|candidate| matcher.is_match(candidate));
    }
    matcher.is_match(canonical_tool)
}
