//! Package and initialize public Skills without replacing user-edited resources.

use anyhow::{Context, Result, ensure};
use brz_mysql::{FromMysqlRow, Json, MysqlService, MysqlTransaction};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
use zip::{ZipWriter, write::SimpleFileOptions};

pub(super) fn files(directory: &Path) -> Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() && !entry.file_type()?.is_symlink() {
            found.extend(files(&path)?);
        } else if path.is_file() {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

pub(super) fn package(entries: &[(String, Vec<u8>, u32)]) -> Result<Vec<u8>> {
    let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes, mode) in entries {
        ensure!(
            !name.starts_with('/') && !name.split('/').any(|part| part == ".."),
            "unsafe package path"
        );
        archive.start_file(
            name,
            SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(*mode),
        )?;
        archive.write_all(bytes)?;
    }
    Ok(archive.finish()?.into_inner())
}

pub(super) fn directory_entries(
    directory: &Path,
    prefix: &str,
) -> Result<Vec<(String, Vec<u8>, u32)>> {
    files(directory)?
        .into_iter()
        .map(|path| {
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                std::fs::metadata(&path)?.permissions().mode() & 0o777
            };
            #[cfg(not(unix))]
            let mode = 0o644;
            let relative = path
                .strip_prefix(directory)?
                .to_string_lossy()
                .replace('\\', "/");
            Ok((format!("{prefix}{relative}"), std::fs::read(&path)?, mode))
        })
        .collect()
}

fn frontmatter(text: &str) -> Result<(Value, String)> {
    let pattern = regex::Regex::new(r"(?ms)^---\s*\n(.*?)\n---\s*\n").unwrap();
    let captures = pattern
        .captures(text)
        .context("SKILL.md must contain YAML frontmatter")?;
    let documents = wegent_python_compat::yaml::documents(&captures[1])?;
    let metadata = documents
        .into_iter()
        .next()
        .context("empty Skill frontmatter")?;
    ensure!(
        metadata.is_object() && metadata.get("description").is_some(),
        "Skill frontmatter must include description"
    );
    Ok((metadata, pattern.replace_all(text, "").trim().to_owned()))
}

struct Skill {
    spec: Value,
    original: Vec<u8>,
    sanitized: Vec<u8>,
}

fn load(directory: &Path) -> Result<Skill> {
    let name = directory
        .file_name()
        .context("Skill directory name")?
        .to_string_lossy();
    let mut entries = directory_entries(directory, &format!("{name}/"))?;
    ensure!(
        !entries.iter().any(|(name, _, _)| name.contains("..")),
        "unsafe Skill package path"
    );
    let original = package(&entries)?;
    ensure!(
        original.len() <= 10 * 1024 * 1024,
        "Skill ZIP exceeds size limit"
    );
    let (metadata, body) = frontmatter(&std::fs::read_to_string(directory.join("SKILL.md"))?)?;
    let mut spec = json!({});
    for key in [
        "description",
        "displayName",
        "version",
        "author",
        "tags",
        "config",
        "tools",
        "provider",
        "runtime",
        "mcpServers",
    ] {
        spec[key] = metadata.get(key).cloned().unwrap_or(Value::Null);
    }
    spec["prompt"] = json!(body);
    spec["bindShells"] = metadata
        .get("bindShells")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(["ClaudeCode"]));
    spec["preload"] = json!(metadata["preload"].as_bool().unwrap_or(false));
    spec["source"] = Value::Null;
    let sanitized = if metadata.get("mcpServers").is_some() {
        let mut safe = metadata.clone();
        safe.as_object_mut().unwrap().remove("mcpServers");
        let text = format!(
            "---\n{}\n---\n\n{body}\n",
            serde_json::to_string_pretty(&safe)?
        );
        for (path, bytes, _) in &mut entries {
            if path == &format!("{name}/SKILL.md") {
                *bytes = text.as_bytes().to_vec();
            }
        }
        package(&entries)?
    } else {
        original.clone()
    };
    Ok(Skill {
        spec,
        original,
        sanitized,
    })
}

pub(super) async fn binary(
    tx: &mut impl MysqlTransaction,
    id: i64,
    bytes: &[u8],
    size: i64,
    hash: &str,
    filename: &str,
    kind: &str,
) -> brz_mysql::MysqlResult<()> {
    tx.execute("INSERT INTO skill_binaries (kind_id,binary_data,file_size,file_hash,type,file_name,created_at) VALUES (?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE binary_data=VALUES(binary_data),file_size=VALUES(file_size),file_hash=VALUES(file_hash),type=VALUES(type),file_name=VALUES(file_name)",(id,bytes,size,hash,kind,filename)).await?;
    Ok(())
}

fn references(payload: &Value, name: &str, id: i64) -> bool {
    let spec = &payload["spec"];
    let refs = [&spec["skill_refs"], &spec["preload_skill_refs"]];
    if refs.iter().any(|r| {
        r.get(name)
            .and_then(|v| v.get("skill_id"))
            .and_then(Value::as_i64)
            == Some(id)
    }) {
        return true;
    }
    if refs
        .iter()
        .any(|r| r.as_object().is_some_and(|r| r.contains_key(name)))
    {
        return false;
    }
    ["skills", "preload_skills"].iter().any(|key| {
        spec[*key]
            .as_array()
            .is_some_and(|v| v.iter().any(|v| v.as_str() == Some(name)))
    })
}

async fn apply_one(mysql: &MysqlService, directory: &Path, force: bool) -> Result<()> {
    let name = directory
        .file_name()
        .context("Skill name")?
        .to_string_lossy()
        .into_owned();
    let input = directory.to_owned();
    let skill = tokio::task::spawn_blocking(move || load(&input)).await??;
    let existing = mysql
        .with_transaction(async |tx| super::kind(tx, "Skill", &name, "default").await)
        .await?;
    let active = existing.as_ref().is_some_and(|r| r.is_active == Some(true));
    let newer = existing
        .as_ref()
        .and_then(|r| r.payload.0["spec"]["version"].as_str())
        .and_then(|v| v.parse::<pep440_rs::Version>().ok())
        .zip(
            skill.spec["version"]
                .as_str()
                .and_then(|v| v.parse::<pep440_rs::Version>().ok()),
        )
        .is_some_and(|(old, new)| new > old);
    if active && !force && !newer {
        return Ok(());
    }
    if active && force {
        #[derive(FromMysqlRow)]
        struct Ghost {
            payload: Json<Value>,
        }
        let ghosts:Vec<Ghost>=mysql.fetch_all("SELECT json AS payload FROM kinds WHERE kind='Ghost' AND is_active=1 AND user_id=0",()).await?;
        let id = existing.as_ref().unwrap().id;
        ensure!(
            !ghosts.iter().any(|g| references(&g.payload.0, &name, id)),
            "Skill {name} is referenced by Ghosts"
        );
        mysql
            .with_transaction(async |tx| {
                tx.execute("DELETE FROM skill_binaries WHERE kind_id=?", (id,))
                    .await?;
                tx.execute(
                    "UPDATE kinds SET is_active=0,updated_at=NOW() WHERE id=?",
                    (id,),
                )
                .await?;
                Ok(())
            })
            .await?;
    }
    let hash = format!("{:x}", Sha256::digest(&skill.original));
    let size = skill.original.len() as i64;
    let mut payload = if active && !force {
        existing.as_ref().unwrap().payload.0.clone()
    } else {
        json!({"apiVersion":"agent.wecode.io/v1","kind":"Skill","metadata":{"name":name,"namespace":"default"},"spec":{},"status":{"state":"Available"}})
    };
    let target = payload["spec"]
        .as_object_mut()
        .context("invalid stored Skill spec")?;
    for (key, value) in skill.spec.as_object().unwrap() {
        if key != "source" || !active || force {
            target.insert(key.clone(), value.clone());
        }
    }
    payload["status"]["fileSize"] = json!(size);
    payload["status"]["fileHash"] = json!(hash);
    mysql
        .with_transaction(async |tx| {
            let id = if let Some(existing) = &existing {
                tx.execute(
                    "UPDATE kinds SET json=?,is_active=1,updated_at=NOW() WHERE id=?",
                    (Json(&payload), existing.id),
                )
                .await?;
                existing.id
            } else {
                super::insert_kind(tx, "Skill", &name, "default", &payload).await?
            };
            binary(
                tx,
                id,
                &skill.sanitized,
                size,
                &hash,
                &format!("{name}.zip"),
                "",
            )
            .await
        })
        .await?;
    Ok(())
}

pub(super) async fn apply(mysql: &MysqlService, directory: &Path, force: bool) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if !path.is_dir() || !path.join("SKILL.md").is_file() {
            continue;
        }
        if let Err(error) = apply_one(mysql, &path, force).await {
            tracing::error!(path=%path.display(),%error,"Skill initialization failed");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_skill_identity_takes_precedence_over_legacy_names() {
        assert!(references(&json!({"spec":{"skills":["test"]}}), "test", 1));
        assert!(!references(
            &json!({"spec":{"skills":["test"],"skill_refs":{"test":{"skill_id":2}}}}),
            "test",
            1
        ));
        assert!(references(
            &json!({"spec":{"skill_refs":{"test":{"skill_id":1}}}}),
            "test",
            1
        ));
    }
    #[test]
    fn packaged_resources_preserve_mcp_metadata_but_strip_it_from_zip() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("init_data/skills/skill-creator");
        let skill = load(&path).unwrap();
        assert!(skill.spec["description"].is_string());
        assert!(skill.spec["prompt"].as_str().is_some_and(|s| !s.is_empty()));
        assert!(!skill.original.is_empty());
    }
}
