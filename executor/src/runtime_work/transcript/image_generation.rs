// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use image::ImageReader;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{item_type, string_field};
use crate::agents::runtime_capabilities::workspace_root;
use crate::logging::log_executor_event;

const GENERATED_IMAGE_DIRECTORY: &str = "outputs/generated-images";
const MAX_GENERATED_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

pub(super) struct ImageGenerationRenderContext<'a> {
    pub(super) device_id: &'a str,
    pub(super) workspace_path: &'a str,
}

pub(super) fn insert_image_generation_render_payload(
    object: &mut Map<String, Value>,
    item: &Value,
    context: ImageGenerationRenderContext<'_>,
) {
    if item_type(item) != "imagegeneration" {
        return;
    }

    let mut payload = Map::from_iter([(
        "kind".to_owned(),
        Value::String("image_generation".to_owned()),
    )]);
    if let Some(prompt) =
        string_field(item, "revisedPrompt").or_else(|| string_field(item, "revised_prompt"))
    {
        payload.insert("revisedPrompt".to_owned(), Value::String(prompt));
    }

    let saved_path = string_field(item, "savedPath").or_else(|| string_field(item, "saved_path"));
    if let Some(saved_path) = saved_path.as_deref() {
        match materialize_generated_image(saved_path, context.workspace_path) {
            Ok(artifact) => {
                payload.insert("mimeType".to_owned(), Value::String(artifact.mime_type));
                payload.insert("size".to_owned(), json!(artifact.size));
                payload.insert("width".to_owned(), json!(artifact.width));
                payload.insert("height".to_owned(), json!(artifact.height));
                payload.insert(
                    "source".to_owned(),
                    json!({
                        "type": "workspace_file",
                        "deviceId": context.device_id,
                        "workspacePath": artifact.workspace_path,
                        "path": artifact.relative_path,
                    }),
                );
            }
            Err(error) => {
                log_executor_event(
                    "image generation artifact materialization failed",
                    &[
                        ("saved_path", saved_path.to_owned()),
                        ("workspace_path", context.workspace_path.to_owned()),
                        ("error", error),
                    ],
                );
            }
        }
    }

    object.insert("render_payload".to_owned(), Value::Object(payload));
}

struct GeneratedImageArtifact {
    workspace_path: String,
    relative_path: String,
    mime_type: String,
    size: u64,
    width: u32,
    height: u32,
}

fn materialize_generated_image(
    saved_path: &str,
    workspace_path: &str,
) -> Result<GeneratedImageArtifact, String> {
    let workspace = canonical_workspace(workspace_path)?;
    let source = resolve_source_path(saved_path, &workspace)?;
    let source = source
        .canonicalize()
        .map_err(|error| format!("Failed to resolve generated image: {error}"))?;
    let metadata = source
        .metadata()
        .map_err(|error| format!("Failed to inspect generated image: {error}"))?;
    if !metadata.is_file() {
        return Err("Generated image source is not a file".to_owned());
    }
    if metadata.len() > MAX_GENERATED_IMAGE_BYTES {
        return Err("Generated image exceeds the 50 MiB limit".to_owned());
    }

    let extension = image_extension(&source)?;
    let (width, height) = image_dimensions(&source)?;
    let output_directory = workspace.join(GENERATED_IMAGE_DIRECTORY);
    fs::create_dir_all(&output_directory)
        .map_err(|error| format!("Failed to create generated image directory: {error}"))?;
    let output_directory = output_directory
        .canonicalize()
        .map_err(|error| format!("Failed to resolve generated image directory: {error}"))?;
    if !output_directory.starts_with(&workspace) {
        return Err("Generated image directory escapes the task workspace".to_owned());
    }

    let temporary_path = output_directory.join(format!(".{}.tmp", Uuid::new_v4()));
    let (digest, size) = match copy_and_digest(&source, &temporary_path) {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            return Err(error);
        }
    };
    let filename = format!("{digest}.{extension}");
    let destination = output_directory.join(&filename);
    if destination.exists() {
        fs::remove_file(&temporary_path)
            .map_err(|error| format!("Failed to remove generated image temporary file: {error}"))?;
    } else {
        fs::rename(&temporary_path, &destination)
            .map_err(|error| format!("Failed to publish generated image: {error}"))?;
    }

    Ok(GeneratedImageArtifact {
        workspace_path: workspace.display().to_string(),
        relative_path: format!("{GENERATED_IMAGE_DIRECTORY}/{filename}"),
        mime_type: image_mime_type(extension).to_owned(),
        size,
        width,
        height,
    })
}

fn canonical_workspace(workspace_path: &str) -> Result<PathBuf, String> {
    canonical_workspace_with_root(workspace_path, &workspace_root())
}

fn canonical_workspace_with_root(
    workspace_path: &str,
    relative_root: &Path,
) -> Result<PathBuf, String> {
    if workspace_path.trim().is_empty() {
        return Err("Task workspace path is unavailable".to_owned());
    }
    let requested = expand_home_path(workspace_path)?;
    if requested.is_absolute() {
        return requested
            .canonicalize()
            .map_err(|error| format!("Failed to resolve task workspace: {error}"));
    }
    if !requested
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err("Relative task workspace path contains unsupported components".to_owned());
    }
    let root = relative_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve executor workspace root: {error}"))?;
    let workspace = root
        .join(requested)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve task workspace: {error}"))?;
    if !workspace.starts_with(&root) {
        return Err("Task workspace escapes the executor workspace root".to_owned());
    }
    Ok(workspace)
}

fn expand_home_path(path: &str) -> Result<PathBuf, String> {
    let path = path.trim();
    if path == "~" {
        return dirs::home_dir().ok_or_else(|| "Home directory is unavailable".to_owned());
    }
    if let Some(relative) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return dirs::home_dir()
            .map(|home| home.join(relative))
            .ok_or_else(|| "Home directory is unavailable".to_owned());
    }
    Ok(PathBuf::from(path))
}

fn resolve_source_path(saved_path: &str, workspace: &Path) -> Result<PathBuf, String> {
    let path = expand_home_path(saved_path)?;
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(workspace.join(path))
    }
}

fn image_extension(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Ok("png"),
        Some("jpg" | "jpeg") => Ok("jpg"),
        Some("webp") => Ok("webp"),
        Some("gif") => Ok("gif"),
        Some("bmp") => Ok("bmp"),
        _ => Err("Generated image uses an unsupported file type".to_owned()),
    }
}

fn image_mime_type(extension: &str) -> &'static str {
    match extension {
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

fn image_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let reader = ImageReader::open(path)
        .map_err(|error| format!("Failed to open generated image metadata: {error}"))?;
    let reader = reader
        .with_guessed_format()
        .map_err(|error| format!("Failed to detect generated image format: {error}"))?;
    let dimensions = reader
        .into_dimensions()
        .map_err(|error| format!("Failed to read generated image dimensions: {error}"))?;
    if dimensions.0 == 0 || dimensions.1 == 0 {
        return Err("Generated image dimensions are invalid".to_owned());
    }
    Ok(dimensions)
}

fn copy_and_digest(source: &Path, destination: &Path) -> Result<(String, u64), String> {
    let mut source_file = fs::File::open(source)
        .map_err(|error| format!("Failed to open generated image: {error}"))?;
    let mut destination_file = fs::File::create(destination)
        .map_err(|error| format!("Failed to create generated image artifact: {error}"))?;
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];

    loop {
        let bytes_read = source_file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read generated image: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        size = size.saturating_add(bytes_read as u64);
        if size > MAX_GENERATED_IMAGE_BYTES {
            let _ = fs::remove_file(destination);
            return Err("Generated image exceeds the 50 MiB limit".to_owned());
        }
        digest.update(&buffer[..bytes_read]);
        destination_file
            .write_all(&buffer[..bytes_read])
            .map_err(|error| format!("Failed to write generated image artifact: {error}"))?;
    }
    Ok((format!("{:x}", digest.finalize()), size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn materializes_generated_images_inside_the_workspace() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source_directory = tempfile::tempdir().expect("source directory");
        let source = source_directory.path().join("generated.png");
        image::RgbaImage::from_pixel(4, 2, image::Rgba([0, 0, 0, 255]))
            .save(&source)
            .expect("image source");
        let mut block = Map::new();
        let item = json!({
            "id": "image-1",
            "type": "imageGeneration",
            "result": "aW1hZ2U=",
            "savedPath": source,
        });

        insert_image_generation_render_payload(
            &mut block,
            &item,
            ImageGenerationRenderContext {
                device_id: "device-1",
                workspace_path: workspace.path().to_str().expect("workspace path"),
            },
        );

        let payload = &block["render_payload"];
        assert_eq!(payload["source"]["type"], "workspace_file");
        assert_eq!(payload["source"]["deviceId"], "device-1");
        assert_eq!(
            payload["source"]["workspacePath"],
            workspace
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        );
        assert_eq!(payload["width"], 4);
        assert_eq!(payload["height"], 2);
        assert!(payload["source"]["path"]
            .as_str()
            .expect("relative path")
            .starts_with("outputs/generated-images/"));
        assert!(payload.get("imageBase64").is_none());
        assert!(workspace
            .path()
            .join(payload["source"]["path"].as_str().unwrap())
            .exists());
    }

    #[test]
    fn resolves_relative_workspaces_under_the_executor_workspace_root() {
        let root = tempfile::tempdir().expect("executor workspace root");
        let workspace = root.path().join("local-project");
        fs::create_dir(&workspace).expect("relative workspace");

        assert_eq!(
            canonical_workspace_with_root("local-project", root.path()).unwrap(),
            workspace.canonicalize().unwrap()
        );
    }

    #[test]
    fn expands_tilde_workspace_paths() {
        let home = dirs::home_dir().expect("home directory");

        assert_eq!(
            expand_home_path("~/Documents").unwrap(),
            home.join("Documents")
        );
    }
}
