//! A trial's writers must be stopped even if the Electron parent has already exited.
use std::{
    ffi::c_void,
    io,
    mem::{size_of, zeroed},
    os::windows::{io::AsRawHandle, process::CommandExt},
    process::{Child, Command},
    ptr::{null, null_mut},
    thread,
    time::{Duration, Instant},
};

type Handle = *mut c_void;

#[repr(C)]
struct ThreadEntry {
    size: u32,
    usage: u32,
    id: u32,
    owner: u32,
    base_priority: i32,
    delta_priority: i32,
    flags: u32,
}

#[repr(C)]
struct JobAccounting {
    user_time: i64,
    kernel_time: i64,
    period_user_time: i64,
    period_kernel_time: i64,
    page_faults: u32,
    processes: u32,
    active_processes: u32,
    terminated_processes: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    fn QueryInformationJobObject(
        job: Handle,
        class: u32,
        output: *mut c_void,
        size: u32,
        written: *mut u32,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
    fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
    fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry) -> i32;
    fn OpenThread(access: u32, inherit: i32, id: u32) -> Handle;
    fn ResumeThread(thread: Handle) -> u32;
}

pub struct Trial(Handle);

impl Drop for Trial {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

impl Trial {
    pub fn new() -> io::Result<Self> {
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(job))
    }

    pub fn spawn(&self, command: &mut Command) -> io::Result<Child> {
        const CREATE_SUSPENDED: u32 = 4;
        let mut child = command.creation_flags(CREATE_SUSPENDED).spawn()?;
        let result = (|| {
            if unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            resume_process(child.id())
        })();
        if let Err(error) = result {
            child.kill()?;
            child.wait()?;
            return Err(error);
        }
        Ok(child)
    }

    pub fn stop(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut info: JobAccounting = unsafe { zeroed() };
            // JobObjectBasicAccountingInformation
            if unsafe {
                QueryInformationJobObject(
                    self.0,
                    1,
                    (&mut info as *mut JobAccounting).cast(),
                    size_of::<JobAccounting>() as u32,
                    null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if info.active_processes == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::other("Supervised writers are still running"));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

fn resume_process(pid: u32) -> io::Result<()> {
    const TH32CS_SNAPTHREAD: u32 = 4;
    const THREAD_SUSPEND_RESUME: u32 = 2;
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    let snapshot = Trial(snapshot);
    let mut entry: ThreadEntry = unsafe { zeroed() };
    entry.size = size_of::<ThreadEntry>() as u32;
    let mut found = unsafe { Thread32First(snapshot.0, &mut entry) };
    while found != 0 {
        if entry.owner == pid {
            let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.id) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let handle = Trial(handle);
            if unsafe { ResumeThread(handle.0) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        entry.size = size_of::<ThreadEntry>() as u32;
        found = unsafe { Thread32Next(snapshot.0, &mut entry) };
    }
    Err(io::Error::other(
        "Cannot locate the suspended Wework host thread",
    ))
}
