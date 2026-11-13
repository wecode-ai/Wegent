// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Connector identities encoded in MCP tool names. Keep Python's
//! shared.utils.connector_tools equivalent at this wire boundary.

pub fn qualify_tool(slug: &str, tool: &str) -> String {
    format!("{}__{tool}", slug.replace('_', "_u"))
}

pub fn split_tool(name: &str) -> Option<(String, &str)> {
    let (encoded, tool) = name.split_once("__")?;
    let slug = encoded.replace("_u", "_");
    if slug.is_empty() || tool.is_empty() || qualify_tool(&slug, tool) != name {
        return None;
    }
    Some((slug, tool))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_remain_distinct_when_slugs_and_tools_share_the_separator() {
        for (slug, tool, expected) in [
            ("reports", "archive__lookup", "reports__archive__lookup"),
            ("reports__archive", "lookup", "reports_u_uarchive__lookup"),
            ("reports_u", "__lookup", "reports_uu____lookup"),
            ("reports-archive", "lookup", "reports-archive__lookup"),
        ] {
            assert_eq!(qualify_tool(slug, tool), expected);
            assert_eq!(split_tool(expected), Some((slug.to_string(), tool)));
        }
    }

    #[test]
    fn malformed_names_cannot_alias_another_identity() {
        for name in ["", "reports", "__lookup", "reports__", "reports_x__lookup"] {
            assert_eq!(split_tool(name), None, "{name}");
        }
    }
}
