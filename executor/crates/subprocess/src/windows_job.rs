//! Capture descendants before a background process can start running.

use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject,
};

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process: *mut std::ffi::c_void) -> i32;
}

pub(super) struct WindowsJob(OwnedHandle);

impl WindowsJob {
    pub(super) fn create() -> io::Result<Self> {
        // Null security attributes produce a non-inheritable, process-owned handle.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // The successful creation transferred one unique handle to this owner.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle) }))
    }

    pub(super) fn assign_and_resume(&self, child: &tokio::process::Child) -> io::Result<()> {
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("The suspended process handle is unavailable"))?;
        // Both borrowed handles remain owned throughout assignment and resumption.
        if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) } == 0 {
            return Err(io::Error::last_os_error());
        }
        // The child was created suspended, so it cannot create unowned descendants.
        let status = unsafe { NtResumeProcess(process) };
        if status < 0 {
            return Err(io::Error::other(format!(
                "Cannot resume contained process: NTSTATUS {status:#x}"
            )));
        }
        Ok(())
    }

    pub(super) fn terminate(&self) -> io::Result<()> {
        // The job retains its membership even after its root process has exited.
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
