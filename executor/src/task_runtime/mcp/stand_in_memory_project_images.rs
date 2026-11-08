//! Native image interpretations are bound to exact authorized project file snapshots.
use super::*;

fn cached_observation(state: &Value, hash: &Value) -> Option<String> {
    let cached = &state["imageObservation"];
    (hash.is_string() && cached["originalContentHash"] == *hash)
        .then(|| cached["content"].as_str())
        .flatten()
        .filter(|text| !text.trim().is_empty() && text.len() <= 8192)
        .map(str::to_owned)
}

pub(super) async fn resolve(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    identity: &StandInMcpIdentity,
    name: &str,
    args: &Value,
    mut evidence: Value,
) -> Result<Value, String> {
    if !matches!(
        args["kind"].as_str(),
        Some("file" | "attachment" | "delivery_asset")
    ) {
        return Ok(evidence);
    }
    let Some(input) = evidence
        .as_object_mut()
        .and_then(|row| row.remove("imageInput"))
    else {
        return Ok(evidence);
    };
    let key = project_source_key(&project_source(args));
    let store = runtime.stand_in_store();
    let state = store
        .memory_review_progress(identity.user, &key)
        .map_err(|error| error.to_string())?;
    let hash = &evidence["originalContentHash"];
    let observation = match cached_observation(&state, hash) {
        Some(content) => content,
        None => {
            if name != "read_memory_project"
                || args["offset"].as_u64().unwrap_or(0) != 0
                || !args["contentHash"].is_null()
            {
                return Err("Read this project image from the beginning before continuing".into());
            }
            validate_run(identity).await?;
            check_project(runtime, identity, args)?;
            let result =
                super::super::super::stand_in_tasks::interpret_image(identity.clone(), input)
                    .await?;
            let content = result
                .as_str()
                .ok_or("Invalid native image observation")?
                .to_owned();
            // Reuse the same authorized reader, including inventory and Issue ownership checks.
            let current = project_evidence(runtime, context, args).await?;
            if current["originalContentHash"] != *hash || !current["imageInput"].is_string() {
                return Err("Project image changed during interpretation; read it again".into());
            }
            validate_run(identity).await?;
            check_project(runtime, identity, args)?;
            store
                .cache_memory_image_observation(
                    identity.user,
                    &key,
                    &identity.task_id,
                    state["version"].as_i64().unwrap_or(0),
                    hash.as_str().ok_or("Missing image hash")?,
                    &content,
                )
                .map_err(|error| error.to_string())?;
            content
        }
    };
    evidence["content"] = json!(observation);
    evidence["evidenceKind"] = json!("image_observation");
    Ok(evidence)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_project_image_file_reads_preserve_provenance_without_returning_source_bytes() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Image evidence"})).unwrap())
            .unwrap();
        store.materialize_implicit_primary(7, "mac").unwrap();
        let mut settings = store.personal_stand_in(7, "mac").unwrap();
        settings["primary"]["collaboration"] = json!({"enabled":true,"allProjects":false,
            "projects":[{"id":project.id,"store":"local"}],"excludedProjects":[],"tags":[]});
        store.save_personal_stand_in(7, "mac", settings).unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 1)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let file = store
            .upload_project_file(
                &project.id,
                Some("policy.png"),
                serde_json::from_value(
                    json!({"display_name":"policy.png","base64":STANDARD.encode(png.get_ref())}),
                )
                .unwrap(),
            )
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();
        let context = SpaceMcpRequestContext::new(None, None, None);
        let mut args =
            json!({"projectId":project.id,"projectStore":"local","kind":"file","fileId":file.id});
        let request: ExecutionRequest = serde_json::from_value(json!({"origin":{"type":"stand_in_schedule","memoryReview":true,"userId":7,"deviceId":"mac"}})).unwrap();
        let identity = stand_in_identity(&request).unwrap();
        let raw = project_evidence(&runtime, &context, &args).await.unwrap();
        let hash = format!("{:x}", Sha256::digest(png.get_ref()));
        assert_eq!(raw["originalContentHash"], hash);
        assert!(raw["imageInput"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let store = runtime.stand_in_store();
        let key = project_source_key(&project_source(&args));
        store
            .cache_memory_image_observation(
                7,
                &key,
                "previous-run",
                0,
                &hash,
                "Visible release rule",
            )
            .unwrap();
        let evidence = resolve(
            &runtime,
            &context,
            &identity,
            "read_memory_project",
            &args,
            raw,
        )
        .await
        .unwrap();
        assert_eq!(evidence["content"], "Visible release rule");
        assert_eq!(evidence["evidenceKind"], "image_observation");
        assert!(evidence.get("imageInput").is_none());
        assert!(!evidence.to_string().contains("data:image"));
        assert_eq!(evidence["fileId"], file.id);
        let mut page = chunk(&evidence, &json!({})).unwrap();
        page["evidenceKind"] = evidence["evidenceKind"].clone();
        args["contentHash"] = page["contentHash"].clone();
        args["excerpt"] = json!("Visible release rule");
        args["content"] = json!("Image interpretation suggests a release rule");
        let saved = save_memory(store, &identity, &args, &page).unwrap();
        assert_eq!(saved["evidence"]["kind"], "image_observation");
        assert_eq!(saved["evidence"]["source"]["fileId"], file.id);
        let mut changed = evidence.clone();
        changed["originalContentHash"] = json!("b".repeat(64));
        changed["imageInput"] = json!("host-only");
        assert!(resolve(
            &runtime,
            &context,
            &identity,
            "remember_from_project",
            &args,
            changed
        )
        .await
        .unwrap_err()
        .contains("beginning"));
        runtime.delete_project_file(&file.id, false).unwrap();
        assert!(project_evidence(&runtime, &context, &args).await.is_err());
    }

    #[test]
    fn memory_project_image_cache_requires_exact_original_hash_and_bounded_content() {
        let state = json!({"imageObservation":{"originalContentHash":"a".repeat(64),"content":"visible fact"}});
        assert_eq!(
            cached_observation(&state, &json!("a".repeat(64))).as_deref(),
            Some("visible fact")
        );
        assert!(cached_observation(&state, &json!("b".repeat(64))).is_none());
        assert!(cached_observation(&json!({}), &Value::Null).is_none());
        for content in [" ".to_owned(), "x".repeat(8193)] {
            let mut invalid = state.clone();
            invalid["imageObservation"]["content"] = json!(content);
            assert!(cached_observation(&invalid, &json!("a".repeat(64))).is_none());
        }
    }
}
