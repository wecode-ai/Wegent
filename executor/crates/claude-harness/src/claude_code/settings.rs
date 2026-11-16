//! Claude settings and pre-execution hooks.
use super::*;

pub fn restore_claude_plugin_cache(request: &ExecutionRequest, spec: &CommandSpec) {
    let Some(config_dir) = spec
        .envs()
        .get("CLAUDE_CONFIG_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    else {
        return;
    };

    let mut fields = task_fields(&request.task_id, &request.subtask_id);
    fields.push(("config_dir", config_dir.display().to_string()));
    match restore_enabled_claude_plugin_cache(&config_dir) {
        Ok(restored) if !restored.is_empty() => {
            fields.push(("restored_count", restored.len().to_string()));
            log_executor_event("claude plugin cache restored", &fields);
        }
        Ok(_) => {}
        Err(error) => {
            fields.push(("error_len", error.to_string().len().to_string()));
            log_executor_event("claude plugin cache restore failed", &fields);
        }
    }
}

pub fn configure_claude_file_edit_hooks(request: &ExecutionRequest, spec: &CommandSpec) {
    let Some(command) = env::var(FILE_EDIT_HOOK_COMMAND_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let Some(config_dir) = spec
        .envs()
        .get("CLAUDE_CONFIG_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    let settings_path = PathBuf::from(config_dir).join("settings.json");
    let mut fields = task_fields(&request.task_id, &request.subtask_id);
    fields.push(("settings", settings_path.display().to_string()));

    match write_claude_file_edit_hook_settings(&settings_path, &command) {
        Ok(()) => log_executor_event("claude file edit hooks configured", &fields),
        Err(error) => {
            fields.push(("error_len", error.len().to_string()));
            log_executor_event("claude file edit hooks failed", &fields);
        }
    }
}

pub fn configure_claude_default_settings(request: &ExecutionRequest, spec: &CommandSpec) {
    let Some(config_dir) = spec
        .envs()
        .get("CLAUDE_CONFIG_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        return;
    };

    let settings_path = PathBuf::from(config_dir).join("settings.json");
    let fields = task_fields(&request.task_id, &request.subtask_id);

    match write_claude_default_settings(&settings_path) {
        Ok(()) => log_executor_event("claude default settings configured", &fields),
        Err(error) => {
            let mut failed_fields = fields;
            failed_fields.push(("error_len", error.len().to_string()));
            log_executor_event("claude default settings failed", &failed_fields);
        }
    }
}

pub(super) fn write_claude_default_settings(settings_path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut settings = read_claude_settings(settings_path);
    let Some(settings_object) = settings.as_object_mut() else {
        return Err("Claude settings root must be an object".to_owned());
    };
    settings_object.insert("includeCoAuthoredBy".to_owned(), Value::Bool(true));
    settings_object.insert(
        "skipDangerousModePermissionPrompt".to_owned(),
        Value::Bool(false),
    );

    let env = object_field(&mut settings, "env");
    for key in DEFAULT_CLAUDE_SETTINGS_ENV {
        env.insert(
            (*key).to_owned(),
            Value::String(claude_settings_env_value(key)),
        );
    }

    let content = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(settings_path, format!("{content}\n")).map_err(|error| error.to_string())
}

pub(super) fn claude_settings_env_value(key: &str) -> String {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_claude_settings_env_value(key).to_owned())
}

pub(super) fn default_claude_settings_env_value(key: &str) -> &'static str {
    match key {
        "ENABLE_TOOL_SEARCH" => "true",
        _ => "0",
    }
}

pub(super) fn write_claude_file_edit_hook_settings(
    settings_path: &PathBuf,
    command: &str,
) -> Result<(), String> {
    if let Some(parent) = settings_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut settings = read_claude_settings(settings_path);
    let hooks = object_field(&mut settings, "hooks");
    ensure_file_edit_hook(hooks, "PreToolUse", command);
    ensure_file_edit_hook(hooks, "PostToolUse", command);

    let content = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(settings_path, format!("{content}\n")).map_err(|error| error.to_string())
}

pub(super) fn read_claude_settings(settings_path: &PathBuf) -> Value {
    fs::read_to_string(settings_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

pub(super) fn object_field<'a>(parent: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if !parent.is_object() {
        *parent = Value::Object(Map::new());
    }
    let object = parent.as_object_mut().expect("parent object initialized");
    let value = object
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("child object initialized")
}

pub(super) fn ensure_file_edit_hook(hooks: &mut Map<String, Value>, event: &str, command: &str) {
    let value = hooks
        .entry(event.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if !value.is_array() {
        *value = Value::Array(Vec::new());
    }
    let groups = value.as_array_mut().expect("event hooks initialized");
    groups.retain(|group| !file_edit_hook_group_matches(group));
    groups.push(json!({
        "matcher": CLAUDE_FILE_EDIT_HOOK_MATCHER,
        "hooks": [
            {
                "type": "command",
                "command": command
            }
        ]
    }));
}

pub(super) fn file_edit_hook_group_matches(group: &Value) -> bool {
    group
        .get("matcher")
        .and_then(Value::as_str)
        .is_some_and(|matcher| matcher == CLAUDE_FILE_EDIT_HOOK_MATCHER)
        || group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| hooks.iter().any(is_wegent_file_edit_hook))
}

pub(super) fn is_wegent_file_edit_hook(hook: &Value) -> bool {
    hook.get("type").and_then(Value::as_str) == Some("command")
        && hook
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains("/api/file-edit-log"))
}

pub async fn run_pre_execute_hook(request: &ExecutionRequest, spec: &CommandSpec) {
    let hook = PreExecuteHook::from_env();
    if !hook.enabled() {
        return;
    }

    let task_dir = spec
        .current_dir()
        .cloned()
        .or_else(|| request.cwd().map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = fs::create_dir_all(&task_dir);

    let mut fields = task_fields(&request.task_id, &request.subtask_id);
    fields.push(("cwd", task_dir.display().to_string()));
    log_executor_event("pre-execute hook started", &fields);
    let exit = hook
        .execute(PreExecuteContext {
            task_dir,
            task_id: (!request.task_id.trim().is_empty()).then_some(request.task_id.clone()),
            git_url: request.git_url(),
        })
        .await;
    fields.push(("exit_code", exit.code.to_string()));
    fields.push(("stdout_len", exit.stdout.len().to_string()));
    fields.push(("stderr_len", exit.stderr.len().to_string()));
    if exit.code == 0 {
        log_executor_event("pre-execute hook finished", &fields);
    } else {
        log_executor_event("pre-execute hook failed", &fields);
    }
}
