// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Standalone skill acquisition. Codex remains responsible for discovery and execution.
use super::{
    codex_home::wework_codex_home_path, local_skills::parse_frontmatter,
    native_git::run_git_capture, plugin_import::extract_capability_archive,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    env, fs,
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MAX_BYTES: u64 = 200 * 1024 * 1024;
const MAX_FILES: usize = 5000;
const STAGE_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
const STAGE_CREATED_AT_FILE: &str = ".created-at";

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    action: String,
    source: Option<String>,
    source_kind: Option<String>,
    git_ref: Option<String>,
    token: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
    project_path: Option<String>,
    path: Option<String>,
}

#[derive(Serialize)]
struct Candidate {
    name: String,
    description: String,
    path: String,
}

pub async fn handle(value: Value) -> Result<Value, String> {
    let request: Request = serde_json::from_value(value).map_err(|_| "Invalid skill request")?;
    let home = wework_codex_home_path()?;
    if request.action == "preview" && request.source_kind.as_deref() == Some("git") {
        return preview_git(request, home).await;
    }
    tokio::task::spawn_blocking(move || dispatch(request, &home))
        .await
        .map_err(|_| "Skill operation interrupted".to_owned())?
}

fn required(value: &Option<String>) -> Result<&str, String> {
    value
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Missing required field".to_owned())
}

fn dispatch(request: Request, home: &Path) -> Result<Value, String> {
    fs::create_dir_all(home).map_err(io_error)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(home.join("skill-install.lock"))
        .map_err(io_error)?;
    lock.lock_exclusive().map_err(io_error)?;
    match request.action.as_str() {
        "preview" => preview_local(&request, home),
        "install" => install(&request, home),
        "discard" => {
            let stage = stage_path(home, required(&request.token)?)?;
            if stage.exists() {
                fs::remove_dir_all(stage).map_err(io_error)?;
            }
            Ok(json!({}))
        }
        "remove" => remove(&request, home),
        _ => Err("Unknown skill operation".to_owned()),
    }
}

fn io_error(error: std::io::Error) -> String {
    format!("Skill file operation failed: {error}")
}

fn stage_path(home: &Path, token: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(token).map_err(|_| "Invalid import token")?;
    let stage = home
        .canonicalize()
        .map_err(io_error)?
        .join("skill-imports")
        .join(token);
    reject_symlink_components(&stage)?;
    Ok(stage)
}

fn new_stage(home: &Path) -> Result<(String, PathBuf), String> {
    fs::create_dir_all(home).map_err(io_error)?;
    cleanup_expired_stages(home)?;
    let token = Uuid::new_v4().to_string();
    let stage = stage_path(home, &token)?;
    fs::create_dir_all(stage.join("content")).map_err(io_error)?;
    fs::write(
        stage.join(STAGE_CREATED_AT_FILE),
        unix_timestamp(SystemTime::now()).to_string(),
    )
    .map_err(io_error)?;
    Ok((token, stage))
}

fn unix_timestamp(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn cleanup_expired_stages(home: &Path) -> Result<(), String> {
    let root = home.join("skill-imports");
    if !root.exists() {
        return Ok(());
    }
    let now = SystemTime::now();
    for entry in fs::read_dir(root).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let is_stage = entry
            .file_name()
            .to_str()
            .is_some_and(|name| Uuid::parse_str(name).is_ok());
        if !entry.file_type().map_err(io_error)?.is_dir() || !is_stage {
            continue;
        }
        let path = entry.path();
        let created_at = fs::read_to_string(path.join(STAGE_CREATED_AT_FILE))
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .and_then(|seconds| UNIX_EPOCH.checked_add(Duration::from_secs(seconds)))
            .or_else(|| entry.metadata().ok()?.modified().ok());
        let expired = created_at
            .and_then(|created_at| now.duration_since(created_at).ok())
            .is_some_and(|age| age > STAGE_RETENTION);
        if expired {
            fs::remove_dir_all(path).map_err(io_error)?;
        }
    }
    Ok(())
}

fn validate_git_source(source: &str) -> Result<(), String> {
    let valid = if source.starts_with("https://") || source.starts_with("ssh://") {
        let url = reqwest::Url::parse(source).map_err(|_| "Invalid Git URL")?;
        url.host_str().is_some()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (url.scheme() == "ssh" || url.username().is_empty())
    } else {
        source.starts_with("git@") && source.contains(':') && !source.contains(char::is_whitespace)
    };
    if !valid {
        return Err("Use an HTTPS or SSH Git URL without embedded credentials".to_owned());
    }
    Ok(())
}

async fn preview_git(request: Request, home: PathBuf) -> Result<Value, String> {
    let source = required(&request.source)?.trim();
    validate_git_source(source)?;
    let (token, stage) = new_stage(&home)?;
    let checkout = stage.join("checkout");
    let mut args = vec![
        "-c".to_owned(),
        "core.hooksPath=".to_owned(),
        "clone".to_owned(),
        "--depth".to_owned(),
        "1".to_owned(),
    ];
    if let Some(reference) = request.git_ref.as_deref().filter(|r| !r.trim().is_empty()) {
        args.extend(["--branch".to_owned(), reference.to_owned()]);
    }
    args.extend([
        "--".to_owned(),
        source.to_owned(),
        checkout.to_string_lossy().into_owned(),
    ]);
    let mut environment: std::collections::HashMap<String, String> = env::vars().collect();
    environment.insert("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned());
    environment.insert(
        "GIT_SSH_COMMAND".to_owned(),
        "ssh -o BatchMode=yes".to_owned(),
    );
    let cloned = run_git_capture(&args, None, &environment, Duration::from_secs(45), 8192).await;
    if !cloned.is_ok_and(|result| result.success) {
        let _ = fs::remove_dir_all(&stage);
        return Err(
            "Cannot read repository. Check the address, ref and your Git login, then retry."
                .to_owned(),
        );
    }
    tokio::task::spawn_blocking(move || {
        let result = copy_tree(&checkout, &stage.join("content"), &mut (0, 0), 0)
            .and_then(|_| finish_preview(&stage, &token));
        let _ = fs::remove_dir_all(&checkout);
        if result.is_err() {
            let _ = fs::remove_dir_all(&stage);
        }
        result
    })
    .await
    .map_err(|_| "Repository preview interrupted".to_owned())?
}

fn preview_local(request: &Request, home: &Path) -> Result<Value, String> {
    let source = Path::new(required(&request.source)?);
    if !source.is_absolute() {
        return Err("Select an absolute local path".to_owned());
    }
    let (token, stage) = new_stage(home)?;
    let content = stage.join("content");
    let result = (|| {
        if fs::symlink_metadata(source)
            .map_err(io_error)?
            .file_type()
            .is_symlink()
        {
            return Err("Symbolic links cannot be imported".to_owned());
        }
        if source.is_dir() {
            copy_tree(source, &content, &mut (0, 0), 0)?;
        } else {
            if fs::metadata(source).map_err(io_error)?.len() > 50 * 1024 * 1024 {
                return Err("Skill ZIP exceeds 50 MB".to_owned());
            }
            extract_capability_archive(&fs::read(source).map_err(io_error)?, &content)?;
        }
        finish_preview(&stage, &token)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(stage);
    }
    result
}

fn copy_tree(
    source: &Path,
    destination: &Path,
    budget: &mut (usize, u64),
    depth: usize,
) -> Result<(), String> {
    if depth > 20 {
        return Err("Skill directory nesting exceeds the limit".to_owned());
    }
    let metadata = fs::symlink_metadata(source).map_err(io_error)?;
    if metadata.file_type().is_symlink() {
        return Err("Symbolic links are not allowed in imported skills".to_owned());
    }
    budget.0 += 1;
    if budget.0 > MAX_FILES {
        return Err("Skill import exceeds 5000 entries".to_owned());
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination).map_err(io_error)?;
        for entry in fs::read_dir(source).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            if matches!(
                entry.file_name().to_str(),
                Some(".git" | "node_modules" | ".DS_Store" | "__pycache__")
            ) {
                continue;
            }
            copy_tree(
                &entry.path(),
                &destination.join(entry.file_name()),
                budget,
                depth + 1,
            )?;
        }
    } else if metadata.is_file() {
        budget.1 += metadata.len();
        if budget.1 > MAX_BYTES {
            return Err("Skill import exceeds 200 MB".to_owned());
        }
        fs::copy(source, destination).map_err(io_error)?;
    } else {
        return Err("Only regular files and directories can be imported".to_owned());
    }
    Ok(())
}

fn discover(root: &Path, current: &Path, result: &mut Vec<Candidate>) -> Result<(), String> {
    if current
        .strip_prefix(root)
        .map_err(|_| "Invalid skill path")?
        .components()
        .count()
        > 20
    {
        return Err("Skill directory nesting exceeds the limit".to_owned());
    }
    let skill = current.join("SKILL.md");
    if skill.is_file() {
        let content = fs::read_to_string(&skill).map_err(io_error)?;
        let mut lines = content.lines();
        if lines.next().map(str::trim) != Some("---") || !lines.any(|l| l.trim() == "---") {
            return Err("SKILL.md requires closed YAML frontmatter".to_owned());
        }
        let meta = parse_frontmatter(&skill);
        let name = meta
            .get("name")
            .filter(|s| !s.trim().is_empty())
            .ok_or("SKILL.md requires a name")?;
        let description = meta
            .get("description")
            .filter(|s| !s.trim().is_empty())
            .ok_or("SKILL.md requires a description")?;
        if !safe_name(name) {
            return Err("Skill names must use letters, numbers, hyphens or underscores".to_owned());
        }
        result.push(Candidate {
            name: name.clone(),
            description: description.clone(),
            path: current
                .strip_prefix(root)
                .map_err(|_| "Invalid skill path")?
                .to_string_lossy()
                .replace('\\', "/"),
        });
        return Ok(());
    }
    for entry in fs::read_dir(current).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if entry.file_type().map_err(io_error)?.is_dir() {
            discover(root, &entry.path(), result)?;
        }
    }
    Ok(())
}

fn finish_preview(stage: &Path, token: &str) -> Result<Value, String> {
    let mut skills = Vec::new();
    discover(&stage.join("content"), &stage.join("content"), &mut skills)?;
    if skills.is_empty() {
        return Err("No SKILL.md found in this source".to_owned());
    }
    skills.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(json!({"token": token, "skills": skills}))
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn reject_symlink_components(path: &Path) -> Result<(), String> {
    let mut cursor = PathBuf::new();
    for part in path.components() {
        if matches!(part, Component::ParentDir) {
            return Err("Parent path traversal is not allowed".to_owned());
        }
        cursor.push(part);
        match fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("Symbolic link destinations are not allowed".to_owned())
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn destination_root(home: &Path, project: &Option<String>) -> Result<PathBuf, String> {
    let root = if let Some(project) = project {
        let project = Path::new(project);
        if !project.is_absolute() || !project.is_dir() {
            return Err("Select an existing project directory".to_owned());
        }
        project
            .canonicalize()
            .map_err(io_error)?
            .join(".agents/skills")
    } else {
        home.canonicalize().map_err(io_error)?.join("skills")
    };
    reject_symlink_components(&root)?;
    Ok(root)
}

fn install(request: &Request, home: &Path) -> Result<Value, String> {
    let stage = stage_path(home, required(&request.token)?)?;
    let root = destination_root(home, &request.project_path)?;
    let preview = finish_preview(&stage, required(&request.token)?)?;
    if request.paths.is_empty() {
        return Err("Select at least one skill".to_owned());
    }
    let mut names = HashSet::new();
    let mut selected = Vec::new();
    for path in &request.paths {
        let candidate = preview["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["path"].as_str() == Some(path))
            .ok_or("Skill is not in this preview")?;
        let name = candidate["name"].as_str().unwrap();
        if !names.insert(name.to_lowercase()) || root.join(name).exists() {
            return Err(format!("Skill already exists: {name}. Remove the existing installation or choose another scope."));
        }
        selected.push((stage.join("content").join(path), root.join(name)));
    }
    fs::create_dir_all(&root).map_err(io_error)?;
    // Stage on the destination filesystem, then rename; failed batches roll back only our new paths.
    let prepared = tempfile::tempdir_in(&root).map_err(io_error)?;
    for (index, (source, _)) in selected.iter().enumerate() {
        copy_tree(
            source,
            &prepared.path().join(index.to_string()),
            &mut (0, 0),
            0,
        )?;
    }
    let mut installed = Vec::new();
    for (index, (_, target)) in selected.iter().enumerate() {
        if target.exists() || fs::rename(prepared.path().join(index.to_string()), target).is_err() {
            for created in &installed {
                let _ = fs::remove_dir_all(created);
            }
            return Err("Skill installation failed; no selected skills were installed".to_owned());
        }
        installed.push(target.clone());
    }
    let _ = fs::remove_dir_all(stage);
    Ok(json!({"installed": installed}))
}

fn remove(request: &Request, home: &Path) -> Result<Value, String> {
    let skill = Path::new(required(&request.path)?);
    let root = destination_root(home, &request.project_path)?;
    reject_symlink_components(skill)?;
    let directory = skill.parent().ok_or("Invalid skill path")?;
    if skill.file_name().and_then(|s| s.to_str()) != Some("SKILL.md")
        || directory.parent() != Some(root.as_path())
        || !directory
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(safe_name)
        || !skill.is_file()
    {
        return Err("Only direct personal or selected-project skills can be removed".to_owned());
    }
    fs::remove_dir_all(directory).map_err(io_error)?;
    Ok(json!({}))
}

#[cfg(test)]
mod tests;
