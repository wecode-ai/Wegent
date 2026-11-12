//! Private journal storage using the shared atomic replacement primitive.

use std::{fs, io, path::Path};

pub(super) fn private_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    if !fs::symlink_metadata(path)?.file_type().is_dir() {
        return Err(io::Error::other(
            "Terminal journal requires a real directory",
        ));
    }
    set_private_mode(path, 0o700)
}

pub(super) fn private_file(path: &Path) -> io::Result<()> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(io::Error::other("Terminal journal requires a regular file"));
    }
    set_private_mode(path, 0o600)
}

pub(super) fn write_event(path: &Path, bytes: &[u8]) -> io::Result<()> {
    wegent_filesystem::atomic_file::write_atomic_file(path, bytes).map_err(|error| error.source)?;
    #[cfg(unix)]
    fs::File::open(
        path.parent()
            .ok_or_else(|| io::Error::other("Missing journal directory"))?,
    )?
    .sync_all()?;
    Ok(())
}

fn set_private_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}
