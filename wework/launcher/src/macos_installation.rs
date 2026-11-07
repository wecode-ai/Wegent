//! Materialize the selected signed host at its original macOS application URL.
use std::{
    ffi::{c_char, c_void, CString, OsString},
    fs, io,
    os::unix::ffi::OsStrExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn LSCopyApplicationURLsForBundleIdentifier(
        identifier: *const c_void,
        error: *mut *const c_void,
    ) -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(
        allocator: *const c_void,
        value: *const c_char,
        encoding: u32,
    ) -> *const c_void;
    fn CFArrayGetCount(array: *const c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    fn CFURLGetFileSystemRepresentation(
        url: *const c_void,
        absolute: bool,
        buffer: *mut u8,
        size: isize,
    ) -> bool;
    fn CFURLCopyResourcePropertyForKey(
        url: *const c_void,
        key: *const c_void,
        value: *mut *const c_void,
        error: *mut *const c_void,
    ) -> bool;
    static kCFURLVolumeIsReadOnlyKey: *const c_void;
    fn CFGetTypeID(value: *const c_void) -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: *const c_void) -> bool;
    fn CFRelease(value: *const c_void);
}

unsafe extern "C" {
    fn renamex_np(from: *const c_char, to: *const c_char, flags: u32) -> i32;
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub fn applications(identifier: OsString) -> io::Result<()> {
    let identifier =
        CString::new(identifier.as_bytes()).map_err(|_| invalid("Invalid bundle ID"))?;
    let string =
        unsafe { CFStringCreateWithCString(std::ptr::null(), identifier.as_ptr(), 0x0800_0100) };
    if string.is_null() {
        return Err(invalid("Invalid macOS application identifier"));
    }
    let mut error = std::ptr::null();
    let array = unsafe { LSCopyApplicationURLsForBundleIdentifier(string, &mut error) };
    unsafe { CFRelease(string) };
    if !error.is_null() {
        unsafe { CFRelease(error) };
    }
    if array.is_null() {
        return Err(io::Error::other(
            "Launch Services application lookup failed",
        ));
    }
    let result = (|| {
        for index in 0..unsafe { CFArrayGetCount(array) } {
            let url = unsafe { CFArrayGetValueAtIndex(array, index) };
            if let Some(path) = application_path(url)? {
                println!("{path}");
            }
        }
        Ok(())
    })();
    unsafe { CFRelease(array) };
    result
}

fn application_path(url: *const c_void) -> io::Result<Option<String>> {
    // An installer image is not an installation destination. External writable
    // volumes remain valid; their location under /Volumes is not a rejection reason.
    if read_only_volume(url)? {
        return Ok(None);
    }
    let mut buffer = [0u8; 4096];
    if !unsafe {
        CFURLGetFileSystemRepresentation(url, true, buffer.as_mut_ptr(), buffer.len() as isize)
    } {
        return Err(invalid("Launch Services returned an invalid application URL"));
    }
    let length = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    let path = std::str::from_utf8(&buffer[..length])
        .map_err(|_| invalid("Application path is not UTF-8"))?;
    if path.contains(['\r', '\n']) {
        return Err(invalid("Application path contains a newline"));
    }
    Ok(Some(path.to_owned()))
}

fn read_only_volume(url: *const c_void) -> io::Result<bool> {
    let mut value = std::ptr::null();
    let mut error = std::ptr::null();
    let success = unsafe {
        CFURLCopyResourcePropertyForKey(url, kCFURLVolumeIsReadOnlyKey, &mut value, &mut error)
    };
    if !error.is_null() {
        unsafe { CFRelease(error) };
    }
    if value.is_null() {
        return Err(invalid("The application volume cannot be identified"));
    }
    let result = if success && unsafe { CFGetTypeID(value) == CFBooleanGetTypeID() } {
        Ok(unsafe { CFBooleanGetValue(value) })
    } else {
        Err(invalid("The application volume cannot be identified"))
    };
    unsafe { CFRelease(value) };
    result
}

fn application(executable: &Path) -> io::Result<PathBuf> {
    let bundle = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| invalid("Invalid installed application executable"))?;
    if bundle
        .extension()
        .is_none_or(|extension| extension != "app")
        || executable.parent() != Some(bundle.join("Contents/MacOS").as_path())
    {
        return Err(invalid(
            "Installed executable is not inside a macOS application",
        ));
    }
    Ok(bundle.to_owned())
}

fn command(program: &str, args: &[&Path]) -> io::Result<bool> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.success());
        }
        if Instant::now() >= deadline {
            super::terminate_runtime_tree(&mut child)?;
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "macOS host verification timed out",
            ));
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn same_bundle(payload: &Path, installed: &Path) -> io::Result<bool> {
    if !installed.is_file() {
        return Ok(false);
    }
    let info = |executable: &Path| -> io::Result<PathBuf> {
        Ok(application(executable)?.join("Contents/Info.plist"))
    };
    Ok(
        command("/usr/bin/cmp", &[Path::new("-s"), payload, installed])?
            && command(
                "/usr/bin/cmp",
                &[Path::new("-s"), &info(payload)?, &info(installed)?],
            )?,
    )
}

pub fn install(root: &Path, id: &str) -> io::Result<Option<PathBuf>> {
    let slot = root.join("slots").join(super::release_id(id)?);
    let installed = match super::read(slot.join("installed-executable")) {
        Ok(path) => PathBuf::from(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let payload = PathBuf::from(super::read(slot.join("payload-executable"))?);
    if !installed.is_absolute()
        || !fs::canonicalize(&payload)?.starts_with(fs::canonicalize(&slot)?)
    {
        return Err(invalid("The macOS payload is outside the selected release"));
    }
    if same_bundle(&payload, &installed)? {
        return Ok(Some(installed));
    }
    let bundle = application(&installed)?;
    let name = bundle
        .file_name()
        .ok_or_else(|| invalid("Missing application name"))?;
    let stage = bundle
        .parent()
        .ok_or_else(|| invalid("Missing installation directory"))?
        .join(format!(".{}.wework-{id}", name.to_string_lossy()))
        .join(name);
    let staged_executable = stage.join("Contents/MacOS").join(
        payload
            .file_name()
            .ok_or_else(|| invalid("Missing payload executable"))?,
    );
    for directory in [
        &bundle,
        &bundle.join("Contents"),
        &stage,
        &stage.join("Contents"),
    ] {
        if !fs::symlink_metadata(directory)?.is_dir() {
            return Err(invalid(
                "The macOS installation requires physical bundle directories",
            ));
        }
    }
    if !same_bundle(&payload, &staged_executable)? {
        return Err(invalid(
            "The staged macOS host does not match the selected payload",
        ));
    }
    if !command(
        "/usr/bin/codesign",
        &[
            Path::new("--verify"),
            Path::new("--deep"),
            Path::new("--strict"),
            &stage,
        ],
    )? {
        return Err(invalid("The staged macOS host signature is invalid"));
    }
    let from = CString::new(stage.join("Contents").as_os_str().as_bytes())
        .map_err(|_| invalid("Invalid stage path"))?;
    let to = CString::new(bundle.join("Contents").as_os_str().as_bytes())
        .map_err(|_| invalid("Invalid installed path"))?;
    // Both directories are on the installation volume. The outer .app inode and
    // its Dock bookmark remain unchanged; a crash never leaves Contents missing.
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 2) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Some(installed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    unsafe extern "C" {
        fn CFURLCreateFromFileSystemRepresentation(
            allocator: *const c_void,
            buffer: *const u8,
            length: isize,
            is_directory: bool,
        ) -> *const c_void;
    }

    struct MountedImage {
        root: PathBuf,
        mount: PathBuf,
        mounted: bool,
    }

    impl MountedImage {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "wework-volume-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let application = root.join("source/Installed.app/Contents");
            fs::create_dir_all(&application).unwrap();
            fs::write(application.join("Info.plist"), "volume detection fixture").unwrap();
            let mount = root.join("mounted");
            fs::create_dir_all(&mount).unwrap();
            assert!(Command::new("/usr/bin/hdiutil")
                .args(["create", "-quiet", "-format", "UDRW", "-fs", "HFS+"])
                .arg("-srcfolder")
                .arg(root.join("source"))
                .arg(root.join("installer.dmg"))
                .status()
                .unwrap()
                .success());
            Self {
                root,
                mount,
                mounted: false,
            }
        }

        fn attach(&mut self, read_only: bool) {
            assert!(Command::new("/usr/bin/hdiutil")
                .args(["attach", "-quiet", "-nobrowse"])
                .arg(if read_only { "-readonly" } else { "-readwrite" })
                .arg("-mountpoint")
                .arg(&self.mount)
                .arg(self.root.join("installer.dmg"))
                .status()
                .unwrap()
                .success());
            self.mounted = true;
        }

        fn detach(&mut self) {
            assert!(Command::new("/usr/bin/hdiutil")
                .args(["detach", "-quiet"])
                .arg(&self.mount)
                .status()
                .unwrap()
                .success());
            self.mounted = false;
        }
    }

    impl Drop for MountedImage {
        fn drop(&mut self) {
            if self.mounted {
                let _ = Command::new("/usr/bin/hdiutil")
                    .args(["detach", "-quiet"])
                    .arg(&self.mount)
                    .status();
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn candidate(path: &Path) -> io::Result<Option<String>> {
        let bytes = path.as_os_str().as_bytes();
        let url = unsafe {
            CFURLCreateFromFileSystemRepresentation(
                std::ptr::null(),
                bytes.as_ptr(),
                bytes.len() as isize,
                true,
            )
        };
        assert!(!url.is_null());
        let result = application_path(url);
        unsafe { CFRelease(url) };
        result
    }

    #[test]
    fn installer_volumes_are_excluded_but_writable_volumes_remain_candidates() {
        let mut image = MountedImage::new();
        let installed = image.root.join("source/Installed.app");
        assert_eq!(
            candidate(&installed).unwrap(),
            Some(installed.to_string_lossy().into_owned())
        );
        image.attach(true);
        let mounted = image.mount.join("Installed.app");
        assert!(mounted.is_dir());
        assert_eq!(candidate(&mounted).unwrap(), None);
        image.detach();
        image.attach(false);
        assert_eq!(
            candidate(&mounted).unwrap(),
            Some(mounted.to_string_lossy().into_owned())
        );
        image.detach();
    }

    struct Fixture {
        root: PathBuf,
        installed: PathBuf,
        payload: PathBuf,
        stage: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn bundle(path: &Path, version: &str) {
        fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
        fs::create_dir_all(path.join("Contents/Resources")).unwrap();
        fs::copy(
            std::env::current_exe().unwrap(),
            path.join("Contents/MacOS/Host"),
        )
        .unwrap();
        fs::write(path.join("Contents/Resources/value"), version).unwrap();
        fs::write(path.join("Contents/Info.plist"), format!(
            "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>io.wecode.wework.installation-test</string><key>CFBundleExecutable</key><string>Host</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>"
        )).unwrap();
        assert!(Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(path)
            .status()
            .unwrap()
            .success());
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "wework-macos-installation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let installed = root.join("Installed.app");
        let payload = root.join("slots/next/host/Installed.app");
        let stage = root.join(".Installed.app.wework-next/Installed.app");
        bundle(&installed, "1.0");
        bundle(&payload, "2.0");
        fs::create_dir_all(stage.parent().unwrap()).unwrap();
        assert!(Command::new("/usr/bin/ditto")
            .arg(&payload)
            .arg(&stage)
            .status()
            .unwrap()
            .success());
        fs::write(
            root.join("slots/next/installed-executable"),
            installed.join("Contents/MacOS/Host").as_os_str().as_bytes(),
        )
        .unwrap();
        fs::write(
            root.join("slots/next/payload-executable"),
            payload.join("Contents/MacOS/Host").as_os_str().as_bytes(),
        )
        .unwrap();
        Fixture {
            root,
            installed,
            payload,
            stage,
        }
    }

    #[test]
    fn an_unknown_application_identifier_returns_a_lookup_error() {
        let identifier = OsString::from(format!(
            "io.wecode.wework.missing-installation.{}",
            std::process::id()
        ));
        assert_eq!(
            applications(identifier).unwrap_err().to_string(),
            "Launch Services application lookup failed"
        );
    }

    #[test]
    fn activation_preserves_the_installed_bundle_identity_and_signature() {
        let f = fixture();
        let inode = fs::metadata(&f.installed).unwrap().ino();
        let executable = install(&f.root, "next").unwrap().unwrap();
        assert_eq!(executable, f.installed.join("Contents/MacOS/Host"));
        assert_eq!(fs::metadata(&f.installed).unwrap().ino(), inode);
        assert_eq!(
            fs::read_to_string(f.installed.join("Contents/Resources/value")).unwrap(),
            "2.0"
        );
        assert_eq!(
            fs::read_to_string(f.stage.join("Contents/Resources/value")).unwrap(),
            "1.0"
        );
        assert!(command(
            "/usr/bin/codesign",
            &[
                Path::new("--verify"),
                Path::new("--deep"),
                Path::new("--strict"),
                &f.installed
            ]
        )
        .unwrap());
        // A crash after the exchange is detected from the delivered executable,
        // so replay cannot exchange the old staged Contents back into service.
        install(&f.root, "next").unwrap();
        assert_eq!(
            fs::read_to_string(f.installed.join("Contents/Resources/value")).unwrap(),
            "2.0"
        );
        assert_eq!(
            fs::read_to_string(f.stage.join("Contents/Resources/value")).unwrap(),
            "1.0"
        );
    }

    #[test]
    fn tampered_staged_resources_never_replace_the_installed_host() {
        let f = fixture();
        fs::write(f.stage.join("Contents/Resources/value"), "tampered").unwrap();
        let error = install(&f.root, "next").unwrap_err();
        assert!(error.to_string().contains("signature is invalid"));
        assert_eq!(
            fs::read_to_string(f.installed.join("Contents/Resources/value")).unwrap(),
            "1.0"
        );
    }

    #[test]
    fn absent_staging_keeps_the_previous_host_usable() {
        let f = fixture();
        fs::remove_dir_all(&f.stage).unwrap();
        assert!(install(&f.root, "next").is_err());
        assert_eq!(
            fs::read_to_string(f.installed.join("Contents/Resources/value")).unwrap(),
            "1.0"
        );
    }

    #[test]
    fn symlink_staging_cannot_move_immutable_payload_contents() {
        let f = fixture();
        fs::remove_dir_all(&f.stage).unwrap();
        std::os::unix::fs::symlink(&f.payload, &f.stage).unwrap();
        assert!(install(&f.root, "next")
            .unwrap_err()
            .to_string()
            .contains("physical bundle"));
        assert_eq!(
            fs::read_to_string(f.payload.join("Contents/Resources/value")).unwrap(),
            "2.0"
        );
        assert_eq!(
            fs::read_to_string(f.installed.join("Contents/Resources/value")).unwrap(),
            "1.0"
        );
    }

    #[test]
    fn a_payload_outside_its_release_cannot_be_installed() {
        let f = fixture();
        fs::write(
            f.root.join("slots/next/payload-executable"),
            f.installed
                .join("Contents/MacOS/Host")
                .as_os_str()
                .as_bytes(),
        )
        .unwrap();
        assert!(install(&f.root, "next")
            .unwrap_err()
            .to_string()
            .contains("outside"));
        assert_eq!(
            fs::read_to_string(f.payload.join("Contents/Resources/value")).unwrap(),
            "2.0"
        );
    }
}
