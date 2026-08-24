/// Hide the console window that Windows would otherwise create when a GUI
/// process spawns a console-subsystem child (cmd, powershell, git, ...).
/// The flag is harmless for GUI-subsystem programs (explorer, Code.exe).
#[cfg(windows)]
pub fn hide_windows_console<C>(command: &mut C)
where
    C: std::os::windows::process::CommandExt,
{
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub fn hide_windows_console<C>(_command: &mut C) {}
