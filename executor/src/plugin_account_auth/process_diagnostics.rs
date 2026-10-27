//! CI-only milestones without changing adapter stdout or stderr ownership.

use std::{fs::File, io::Read};
use tempfile::NamedTempFile;

const STAGES: [&str; 5] = ["imported", "ready", "nonce_read", "connected", "nonce_sent"];

pub(super) fn create_trace() -> Option<NamedTempFile> {
    if std::env::var("WEGENT_PLUGIN_AUTH_DIAGNOSTICS").as_deref() == Ok("1") {
        return NamedTempFile::new().ok();
    }
    None
}

pub(super) fn stage_name(trace: Option<&NamedTempFile>) -> &'static str {
    let Some(trace) = trace else {
        return "not_observed";
    };
    let mut bytes = Vec::new();
    if File::open(trace.path())
        .and_then(|file| file.take(32).read_to_end(&mut bytes))
        .is_err()
    {
        return "not_observed";
    }
    STAGES
        .iter()
        .copied()
        .find(|stage| stage.as_bytes() == bytes)
        .unwrap_or("not_observed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_fixed_milestones() {
        assert_eq!(stage_name(None), "not_observed");
        let trace = NamedTempFile::new().unwrap();
        for stage in STAGES {
            std::fs::write(trace.path(), stage).unwrap();
            assert_eq!(stage_name(Some(&trace)), stage);
        }
        for invalid in ["synthetic-secret", "nonce_sent\n", "connected\r\n", ""] {
            std::fs::write(trace.path(), invalid).unwrap();
            assert_eq!(stage_name(Some(&trace)), "not_observed");
        }
        std::fs::write(trace.path(), "synthetic-secret".repeat(1000)).unwrap();
        assert_eq!(stage_name(Some(&trace)), "not_observed");
    }
}
