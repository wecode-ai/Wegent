//! Capture descendants before a background process can start running.

use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    time::{Duration, Instant},
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
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
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        job.set_limits(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)?;
        Ok(job)
    }

    fn set_limits(&self, flags: u32) -> io::Result<()> {
        // This Win32 POD record accepts zeroes for every unused limit and counter.
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = flags;
        // The record remains live for the synchronous call and matches its declared size.
        if unsafe {
            SetInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn preserve_descendants(&self) -> io::Result<()> {
        self.set_limits(0)
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

    pub(super) fn active_processes(&self) -> io::Result<u32> {
        // This Win32 POD record is filled synchronously while the job handle is owned.
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                std::ptr::addr_of_mut!(accounting).cast(),
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }

    pub(super) fn terminate_and_wait(&self, timeout: Duration) -> io::Result<()> {
        self.terminate()?;
        let deadline = Instant::now() + timeout;
        loop {
            if self.active_processes()? == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "Owned process job remained active",
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    pub(super) fn terminate(&self) -> io::Result<()> {
        // The job retains its membership even after its root process has exited.
        if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
