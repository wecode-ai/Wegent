// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, path::PathBuf, sync::OnceLock, time::Duration};

use tokio::{process::Command, time::timeout};

const DEFAULT_TIMEOUT_SECONDS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreExecuteHook {
    command: Option<String>,
    timeout: Duration,
}

impl PreExecuteHook {
    pub fn new(command: Option<String>, timeout: Duration) -> Self {
        Self { command, timeout }
    }

    pub fn from_env() -> Self {
        let env = std::env::vars().collect::<BTreeMap<_, _>>();
        Self::from_env_map(&env)
    }

    pub fn from_env_map(env: &BTreeMap<String, String>) -> Self {
        let command = env
            .get("WEGENT_HOOK_PRE_EXECUTE")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let timeout_seconds = env
            .get("WEGENT_HOOK_PRE_EXECUTE_TIMEOUT")
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS);

        Self {
            command,
            timeout: Duration::from_secs(timeout_seconds),
        }
    }

    pub fn enabled(&self) -> bool {
        self.command.is_some()
    }

    pub fn timeout_seconds(&self) -> u64 {
        self.timeout.as_secs()
    }

    pub async fn execute(&self, context: PreExecuteContext) -> HookExit {
        let Some(script) = self.command.as_deref() else {
            return HookExit::success();
        };

        let mut command = Command::new("bash");
        command.arg(script).arg(&context.task_dir);
        command.env("WEGENT_TASK_DIR", &context.task_dir);
        if let Some(task_id) = context.task_id {
            command.env("WEGENT_TASK_ID", task_id.to_string());
        }
        if let Some(git_url) = &context.git_url {
            command.env("WEGENT_GIT_URL", git_url);
        }
        command.kill_on_drop(true);

        match timeout(self.timeout, command.output()).await {
            Err(_) => HookExit {
                code: -1,
                stdout: String::new(),
                stderr: format!(
                    "pre-execute hook timed out after {}s",
                    self.timeout_seconds()
                ),
            },
            Ok(Ok(output)) => HookExit {
                code: output.status.code().unwrap_or(-1),
                stdout: decode_output(output.stdout),
                stderr: decode_output(output.stderr),
            },
            Ok(Err(error)) => HookExit {
                code: -1,
                stdout: String::new(),
                stderr: error.to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreExecuteContext {
    pub task_dir: PathBuf,
    pub task_id: Option<i64>,
    pub git_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookExit {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl HookExit {
    fn success() -> Self {
        Self {
            code: 0,
            stdout: String::new(),
            stderr: String::new(),
        }
    }
}

pub fn get_pre_execute_hook() -> &'static PreExecuteHook {
    static HOOK: OnceLock<PreExecuteHook> = OnceLock::new();
    HOOK.get_or_init(PreExecuteHook::from_env)
}

fn decode_output(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_owned()
}
