// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use super::git_stream::{self, GitStream, BUFFER_BYTES};

pub(super) fn materialize(
    workspace: &Path,
    before: &str,
    after: &str,
    directory: &Path,
) -> Result<Value, String> {
    private_directory(directory)?;
    let directory = directory.canonicalize().map_err(error)?;
    git_stream::block_on(async {
        let patch = patch(workspace, before, after, &directory).await?;
        let (files, totals) = file_list(workspace, before, after, &directory).await?;
        #[cfg(unix)]
        fs::File::open(&directory)
            .and_then(|file| file.sync_all())
            .map_err(error)?;
        Ok(json!({
            "version": 2,
            "status": "active",
            "workspace_path": workspace,
            "before_tree": before,
            "after_tree": after,
            "file_count": totals.files,
            "additions": totals.additions,
            "deletions": totals.deletions,
            "diff_artifact": patch,
            "files_artifact": files,
        }))
    })
}

async fn patch(
    workspace: &Path,
    before: &str,
    after: &str,
    directory: &Path,
) -> Result<Value, String> {
    let mut process = GitStream::diff(
        workspace,
        &["--binary", "--full-index", "--find-renames"],
        before,
        after,
    )?;
    let mut artifact = ArtifactWriter::new(directory, "changes.patch")?;
    let mut buffer = [0; BUFFER_BYTES];
    loop {
        let count = process.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        artifact.write(&buffer[..count])?;
    }
    process.finish().await?;
    artifact.publish("git-patch")
}

#[derive(Default)]
struct Totals {
    files: u64,
    additions: u64,
    deletions: u64,
}

async fn file_list(
    workspace: &Path,
    before: &str,
    after: &str,
    directory: &Path,
) -> Result<(Value, Totals), String> {
    // Two batched streams replace a Git subprocess for every changed file.
    let mut names = GitStream::diff(
        workspace,
        &["--name-status", "-z", "--find-renames"],
        before,
        after,
    )?;
    let mut stats = GitStream::diff(
        workspace,
        &["--numstat", "-z", "--find-renames"],
        before,
        after,
    )?;
    let mut artifact = ArtifactWriter::new(directory, "files.jsonl")?;
    let mut totals = Totals::default();
    while let Some(status) = names.token().await? {
        let first = required_token(&mut names).await?;
        let renamed = matches!(status.first(), Some(b'R' | b'C'));
        let (path, old_path) = if renamed {
            (required_token(&mut names).await?, Some(first))
        } else {
            (first, None)
        };
        let stat = parse_stat(&mut stats).await?;
        if stat.path != path || stat.old_path != old_path {
            return Err("Git metadata streams disagree".to_owned());
        }
        let mut record = json!({
            "path": String::from_utf8_lossy(&path),
            "old_path": old_path.as_deref().map(String::from_utf8_lossy),
            "change_type": change_type(&status)?,
            "additions": stat.additions,
            "deletions": stat.deletions,
            "binary": stat.binary,
        });
        preserve_path_bytes(&mut record, "path_bytes_hex", &path);
        if let Some(old_path) = &old_path {
            preserve_path_bytes(&mut record, "old_path_bytes_hex", old_path);
        }
        artifact.write(&serde_json::to_vec(&record).map_err(error)?)?;
        artifact.write(b"\n")?;
        totals.files = totals.files.checked_add(1).ok_or("file count overflow")?;
        totals.additions = totals
            .additions
            .checked_add(stat.additions)
            .ok_or("addition count overflow")?;
        totals.deletions = totals
            .deletions
            .checked_add(stat.deletions)
            .ok_or("deletion count overflow")?;
    }
    if stats.token().await?.is_some() {
        return Err("Unexpected trailing Git statistics".to_owned());
    }
    names.finish().await?;
    stats.finish().await?;
    Ok((artifact.publish("jsonl")?, totals))
}

struct Stat {
    path: Vec<u8>,
    old_path: Option<Vec<u8>>,
    additions: u64,
    deletions: u64,
    binary: bool,
}

async fn parse_stat(process: &mut GitStream) -> Result<Stat, String> {
    let token = required_token(process).await?;
    let mut fields = token.splitn(3, |byte| *byte == b'\t');
    let additions = fields.next().ok_or("Missing additions")?;
    let deletions = fields.next().ok_or("Missing deletions")?;
    let path = fields.next().ok_or("Missing stat path")?;
    let binary = additions == b"-" && deletions == b"-";
    let (path, old_path) = if path.is_empty() {
        let old = required_token(process).await?;
        (required_token(process).await?, Some(old))
    } else {
        (path.to_vec(), None)
    };
    Ok(Stat {
        path,
        old_path,
        additions: count(additions, binary)?,
        deletions: count(deletions, binary)?,
        binary,
    })
}

async fn required_token(process: &mut GitStream) -> Result<Vec<u8>, String> {
    process
        .token()
        .await?
        .ok_or_else(|| "Incomplete Git file metadata".to_owned())
}

fn count(bytes: &[u8], binary: bool) -> Result<u64, String> {
    if binary {
        return Ok(0);
    }
    std::str::from_utf8(bytes)
        .map_err(error)?
        .parse::<u64>()
        .map_err(error)
}

fn change_type(status: &[u8]) -> Result<&'static str, String> {
    match status.first() {
        Some(b'A') => Ok("added"),
        Some(b'D') => Ok("deleted"),
        Some(b'R') => Ok("renamed"),
        Some(b'C') => Ok("copied"),
        Some(b'M' | b'T') => Ok("modified"),
        _ => Err("Unsupported Git change status".to_owned()),
    }
}

fn preserve_path_bytes(record: &mut Value, field: &str, bytes: &[u8]) {
    if std::str::from_utf8(bytes).is_err() {
        record[field] = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
            .into();
    }
}

struct ArtifactWriter {
    temporary: NamedTempFile,
    destination: PathBuf,
    hash: Sha256,
    size: u64,
    buffer: Vec<u8>,
}

impl ArtifactWriter {
    fn new(directory: &Path, name: &str) -> Result<Self, String> {
        Ok(Self {
            temporary: NamedTempFile::new_in(directory).map_err(error)?,
            destination: directory.join(name),
            hash: Sha256::new(),
            size: 0,
            buffer: Vec::with_capacity(BUFFER_BYTES),
        })
    }

    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.hash.update(bytes);
        self.size += bytes.len() as u64;
        if self.buffer.len() + bytes.len() > BUFFER_BYTES {
            self.flush()?;
        }
        if bytes.len() >= BUFFER_BYTES {
            self.temporary.write_all(bytes).map_err(error)?;
        } else {
            self.buffer.extend_from_slice(bytes);
        }
        Ok(())
    }

    fn flush(&mut self) -> Result<(), String> {
        self.temporary.write_all(&self.buffer).map_err(error)?;
        self.buffer.clear();
        Ok(())
    }

    fn publish(mut self, format: &str) -> Result<Value, String> {
        self.flush()?;
        self.temporary.as_file().sync_all().map_err(error)?;
        self.temporary.persist(&self.destination).map_err(error)?;
        Ok(json!({"path": self.destination, "size_bytes": self.size,
            "sha256": format!("{:x}", self.hash.finalize()), "format": format}))
    }
}

fn private_directory(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(error)
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
