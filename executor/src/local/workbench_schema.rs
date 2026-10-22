// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/// Read-only startup handshake. Keep this independent of config, logging and Homes.
pub fn response() -> serde_json::Value {
    serde_json::json!({
        "protocol_version": 1,
        "workbench_layout_versions": [1],
        "capability_manifest_versions": [2],
    })
}

pub fn is_query<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter();
    args.next()
        .is_some_and(|arg| arg.as_ref() == "--workbench-schema")
        && args.all(|arg| arg.as_ref() == "--version")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_read_only_schema_queries() {
        assert!(is_query(["--workbench-schema"]));
        assert!(is_query(["--workbench-schema", "--version"]));
        assert!(!is_query(["--version"]));
        assert!(!is_query(["--workbench-schema", "--upgrade"]));
        assert!(!is_query(["--config", "--workbench-schema"]));
    }
}
