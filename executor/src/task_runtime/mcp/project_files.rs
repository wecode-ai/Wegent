//! Local project-file tools reuse registered file membership, never arbitrary paths.
use super::*;

pub(super) fn call_local(
    runtime: &TaskRuntime,
    name: &str,
    arguments: &Value,
) -> Result<Value, super::super::TaskRuntimeError> {
    let project = string_argument(arguments, "space_id")?;
    let files = runtime.list_project_files(project)?;
    if name == "list_space_files" {
        let prefix = arguments["prefix"].as_str().unwrap_or_default();
        return serde_json::to_value(
            files
                .into_iter()
                .filter(|file| file.path.starts_with(prefix))
                .collect::<Vec<_>>(),
        )
        .map_err(invalid_json);
    }
    let id = string_argument(arguments, "file_id")?;
    if !files
        .iter()
        .any(|file| file.id == id && file.kind == "file")
    {
        return Err(super::super::TaskRuntimeError::Invalid(
            "File does not belong to this project or is not a file".into(),
        ));
    }
    let path = runtime.project_file_path(id)?;
    let path = copy_attachment_if_requested(arguments, &path)?;
    Ok(json!({"path":path}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_runtime::{LocalTaskStore, TaskProviderKind};

    #[tokio::test]
    async fn project_file_tools_read_registered_local_files_and_reject_other_projects() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
        let create = |name: &str| {
            store
                .create_project(ProjectCreate {
                    name: name.into(),
                    project_key: None,
                    description: String::new(),
                    task_provider: TaskProviderKind::Local,
                    provider_config: json!({}),
                })
                .unwrap()
        };
        let owner = create("Owner");
        let other = create("Other");
        let file = store
            .upload_project_file(
                &owner.id,
                Some("rules/report.txt"),
                BinaryInput {
                    display_name: "report.txt".into(),
                    content_type: Some("text/plain".into()),
                    base64: STANDARD.encode("Project report convention"),
                },
            )
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();
        let context = SpaceMcpRequestContext::new(None, None, None);
        let call = |name, args| call_tool_with_runtime_context(&runtime, name, args, &context);
        let listed = call(
            "list_space_files",
            json!({"space_id":owner.id,"prefix":"rules/"}),
        )
        .await;
        assert_ne!(listed["isError"], true, "{listed}");
        let rows: Value =
            serde_json::from_str(listed["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(rows
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == file.id));
        let read = call(
            "read_space_file",
            json!({"space_id":owner.id,"file_id":file.id}),
        )
        .await;
        assert_ne!(read["isError"], true, "{read}");
        let value: Value =
            serde_json::from_str(read["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(value["path"].as_str().unwrap()).unwrap(),
            "Project report convention"
        );
        for id in [file.id.as_str(), "/etc/passwd"] {
            let denied = call("read_space_file", json!({"space_id":other.id,"file_id":id})).await;
            assert_eq!(denied["isError"], true, "{denied}");
        }
    }
}
