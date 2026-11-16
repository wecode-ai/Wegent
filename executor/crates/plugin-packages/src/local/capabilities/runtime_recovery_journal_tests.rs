// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::io::Read;

struct InterruptedRead(PathBuf);

impl Read for InterruptedRead {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for entry in fs::read_dir(&self.0)? {
                assert_eq!(entry?.metadata()?.permissions().mode() & 0o077, 0);
            }
        }
        #[cfg(not(unix))]
        let _ = &self.0;
        Err(io::Error::other("interrupted snapshot copy"))
    }
}

#[test]
fn failed_snapshot_copy_does_not_expose_partial_configuration() {
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("config.toml");
    let permissions = fs::metadata(temp.path()).unwrap().permissions();
    let mut source =
        io::Cursor::new(b"sensitive configuration").chain(InterruptedRead(temp.path().to_owned()));

    let error = copy_file_synced(&mut source, &target, permissions).unwrap_err();

    assert!(error.to_string().contains("interrupted snapshot copy"));
    assert!(
        !target.exists(),
        "Partial configuration must not be published"
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn snapshot_copy_preserves_configuration_contents_and_permissions() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.toml");
    let target = temp.path().join("restored.toml");
    fs::write(&source, b"private configuration").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&source, fs::Permissions::from_mode(0o600)).unwrap();
    }

    copy_entry(&source, &target).unwrap();

    assert_eq!(fs::read(&target).unwrap(), b"private configuration");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
