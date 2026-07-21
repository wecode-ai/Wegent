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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_patch_matches_canonical_and_compatible_aliases() {
        for pattern in ["^apply_patch$", "^Write$", "^Edit$"] {
            assert!(matches_tool(&Regex::new(pattern).unwrap(), "apply_patch"));
        }
        assert!(!matches_tool(&Regex::new("^Bash$").unwrap(), "apply_patch"));
    }

    #[test]
    fn unknown_tools_do_not_gain_apply_patch_aliases() {
        assert!(!matches_tool(&Regex::new("^Write$").unwrap(), "shell"));
    }
}
