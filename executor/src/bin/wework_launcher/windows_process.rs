// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use crate::launcher::Result;
use std::{
    ffi::OsString,
    mem,
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr, thread,
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND,
        ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        SystemServices::{JOB_OBJECT_QUERY, JOB_OBJECT_TERMINATE},
        Threading::{
            CreateProcessW, OpenProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
            CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
            PROCESS_SYNCHRONIZE, STARTUPINFOW,
        },
    },
};

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

pub struct Parent(Option<Handle>);

impl Parent {
    pub fn open(pid: u32) -> Result<Self> {
        if pid == 0 || pid == std::process::id() {
            return Err("Invalid update parent PID".into());
        }
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return Ok(Self(None));
            }
            return Err(format!("Cannot open desktop process: {error}"));
        }
        Ok(Self(Some(Handle(handle))))
    }

    pub fn wait(self) -> Result<()> {
        let Some(handle) = self.0 else { return Ok(()) };
        match unsafe { WaitForSingleObject(handle.0, 30_000) } {
            WAIT_OBJECT_0 => Ok(()),
            WAIT_TIMEOUT => Err("Timed out waiting for the desktop to exit".into()),
            _ => Err(std::io::Error::last_os_error().to_string()),
        }
    }
}

pub struct AppProcess {
    process: Handle,
    pid: u32,
    job: Option<Handle>,
}

impl AppProcess {
    pub fn spawn(
        executable: &Path,
        root: &Path,
        args: &[OsString],
        transaction: Option<(&str, &str)>,
    ) -> Result<Self> {
        let application = wide(executable.as_os_str());
        let cwd = wide(
            executable
                .parent()
                .ok_or("Executable has no directory")?
                .as_os_str(),
        );
        let mut arguments = vec![executable.as_os_str().to_os_string()];
        arguments.extend_from_slice(args);
        let mut command = command_line(&arguments);
        let mut environment = environment(root, transaction);
        let mut startup: STARTUPINFOW = unsafe { mem::zeroed() };
        startup.cb = mem::size_of::<STARTUPINFOW>() as u32;
        let mut information: PROCESS_INFORMATION = unsafe { mem::zeroed() };
        // Suspend before assigning the job so no descendant can escape trial ownership.
        if unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                0,
                CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | CREATE_SUSPENDED,
                environment.as_mut_ptr().cast(),
                cwd.as_ptr(),
                &startup,
                &mut information,
            )
        } == 0
        {
            return Err(format!(
                "Cannot launch desktop: {}",
                std::io::Error::last_os_error()
            ));
        }
        let process = Handle(information.hProcess);
        let thread = Handle(information.hThread);
        let mut result = Self {
            process,
            pid: information.dwProcessId,
            job: None,
        };
        let setup = (|| {
            if let Some((id, _)) = transaction {
                result.job = Some(create_trial_job(result.process.0, id)?);
            }
            if unsafe { ResumeThread(thread.0) } == u32::MAX {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(())
        })();
        if let Err(error) = setup {
            unsafe { TerminateProcess(result.process.0, 1) };
            return Err(error);
        }
        Ok(result)
    }

    pub fn id(&self) -> u32 {
        self.pid
    }

    pub fn exited(&mut self) -> Result<bool> {
        match unsafe { WaitForSingleObject(self.process.0, 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(std::io::Error::last_os_error().to_string()),
        }
    }

    pub fn disarm(&mut self) -> Result<()> {
        if let Some(job) = &self.job {
            set_job_limits(job.0, false)?;
        }
        self.job = None;
        Ok(())
    }

    pub fn terminate(&mut self) -> Result<()> {
        let success = unsafe {
            match &self.job {
                Some(job) => TerminateJobObject(job.0, 1),
                None => TerminateProcess(self.process.0, 1),
            }
        };
        if success == 0 && !self.exited()? {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if unsafe { WaitForSingleObject(self.process.0, 10_000) } != WAIT_OBJECT_0 {
            return Err("Failed trial desktop did not exit".into());
        }
        if let Some(job) = &self.job {
            wait_for_empty_job(job.0)?;
        }
        self.job = None;
        Ok(())
    }
}

fn wait_for_empty_job(job: HANDLE) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { mem::zeroed() };
        if unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                mem::size_of_val(&info) as u32,
                ptr::null_mut(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if info.ActiveProcesses == 0 {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Failed trial descendants did not exit".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn job_name(id: &str) -> Vec<u16> {
    wide(std::ffi::OsStr::new(&format!("Local\\WeworkUpdate-{id}")))
}

pub fn recover_trial(id: &str) -> Result<()> {
    let job = unsafe {
        OpenJobObjectW(
            JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE,
            0,
            job_name(id).as_ptr(),
        )
    };
    if job.is_null() {
        if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
            return Ok(());
        }
        return Err(std::io::Error::last_os_error().to_string());
    }
    let job = Handle(job);
    if unsafe { TerminateJobObject(job.0, 1) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    wait_for_empty_job(job.0)
}

fn create_trial_job(process: HANDLE, id: &str) -> Result<Handle> {
    let job = unsafe { CreateJobObjectW(ptr::null(), job_name(id).as_ptr()) };
    if job.is_null() {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let job = Handle(job);
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err("Update trial job already exists".into());
    }
    set_job_limits(job.0, true)?;
    if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
        return Err(format!(
            "Cannot own trial process tree: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(job)
}

fn set_job_limits(job: HANDLE, armed: bool) -> Result<()> {
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
    if armed {
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    }
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            mem::size_of_val(&info) as u32,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn command_line(args: &[OsString]) -> Vec<u16> {
    let mut result = Vec::new();
    for argument in args {
        if !result.is_empty() {
            result.push(b' ' as u16);
        }
        result.push(b'"' as u16);
        let mut slashes = 0;
        for unit in argument.encode_wide() {
            if unit == b'\\' as u16 {
                slashes += 1;
                continue;
            }
            let count = if unit == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            };
            result.extend(std::iter::repeat(b'\\' as u16).take(count));
            result.push(unit);
            slashes = 0;
        }
        result.extend(std::iter::repeat(b'\\' as u16).take(slashes * 2));
        result.push(b'"' as u16);
    }
    result.push(0);
    result
}

fn environment(root: &Path, transaction: Option<(&str, &str)>) -> Vec<u16> {
    let mut values: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| {
            ![
                "WEWORK_UPDATE_INSTALL_ROOT",
                "WEWORK_UPDATE_TRANSACTION_ID",
                "WEWORK_UPDATE_HEALTH_TOKEN",
            ]
            .iter()
            .any(|name| key.to_string_lossy().eq_ignore_ascii_case(name))
        })
        .collect();
    values.push((
        "WEWORK_UPDATE_INSTALL_ROOT".into(),
        root.as_os_str().to_os_string(),
    ));
    if let Some((id, token)) = transaction {
        values.push(("WEWORK_UPDATE_TRANSACTION_ID".into(), id.into()));
        values.push(("WEWORK_UPDATE_HEALTH_TOKEN".into(), token.into()));
    }
    values.sort_by_key(|(key, _)| key.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in values {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}
