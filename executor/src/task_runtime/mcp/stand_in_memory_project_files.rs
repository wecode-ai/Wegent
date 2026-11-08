//! Project file evidence reuses authorized readers and bounded document parsing.
use super::*;

#[cfg(test)]
#[path = "stand_in_memory_project_files_tests.rs"]
mod tests;

fn file_evidence(id_field: &str, args: &Value, document: Value) -> Value {
    let mut evidence = json!({id_field:args[id_field],"content":document["content"],
        "originalContentHash":document["contentHash"]});
    if document["kind"] == "image" {
        // Host-only payload consumed before chunking or returning tool results.
        evidence["imageInput"] = document["dataUrl"].clone();
    }
    evidence
}

async fn check_space_file(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    args: &Value,
    input: &Value,
) -> Result<(), String> {
    let listing = read_tool(runtime, context, "list_space_files", input.clone()).await?;
    let items = listing
        .get("items")
        .unwrap_or(&listing)
        .as_array()
        .ok_or("Invalid project file inventory")?;
    if !items.iter().any(|file| {
        file["id"] == args["fileId"]
            && file["kind"] == "file"
            && file["cloud_project_id"] == args["projectId"]
    }) {
        return Err("File does not belong to this project's current file inventory".into());
    }
    Ok(())
}

pub(super) async fn space_file_evidence(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    args: &Value,
    mut input: Value,
) -> Result<Value, String> {
    input["file_id"] = json!(required(args, "fileId")?);
    check_space_file(runtime, context, args, &input).await?;
    let document = read_file(runtime, context, args, input.clone(), "read_space_file").await?;
    check_space_file(runtime, context, args, &input).await?;
    Ok(file_evidence("fileId", args, document))
}

pub(super) async fn delivery_asset_evidence(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    args: &Value,
    mut input: Value,
) -> Result<Value, String> {
    input["delivery_id"] = json!(required(args, "deliveryId")?);
    input["asset_id"] = json!(required(args, "assetId")?);
    let document = read_file(
        runtime,
        context,
        args,
        input.clone(),
        "download_delivery_asset",
    )
    .await?;
    let issue = read_tool(runtime, context, "get_board_item", input.clone()).await?;
    let delivery = read_tool(runtime, context, "read_delivery", input).await?;
    let detail = delivery.get("delivery").unwrap_or(&delivery);
    if issue["id"] != args["itemId"]
        || issue["cloud_project_id"] != args["projectId"]
        || !detail["assets"]
            .as_array()
            .is_some_and(|assets| assets.iter().any(|asset| asset["id"] == args["assetId"]))
    {
        return Err("Delivery asset ownership changed while reading evidence".into());
    }
    Ok(file_evidence("assetId", args, document))
}

async fn read_file(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    args: &Value,
    mut input: Value,
    tool: &str,
) -> Result<Value, String> {
    use crate::runtime_work::document_evidence::{read_document_input, MAX_TEXT_BYTES};
    input["max_bytes"] = json!(MAX_TEXT_BYTES);
    // Cloud downloads use a host-owned private temporary path, never a model path.
    let temporary = if args["projectStore"] == "cloud" {
        let directory = tempfile::tempdir().map_err(|_| "Cannot prepare evidence download")?;
        input["output_path"] = json!(directory.path().join("evidence"));
        Some(directory)
    } else {
        None
    };
    let downloaded = read_tool(runtime, context, tool, input).await?;
    let path = required(&downloaded, "path")?;
    let document = read_document_input(path.to_owned(), true)
        .await
        .map_err(|error| error.message)?;
    drop(temporary);
    Ok(document)
}

async fn check_attachment(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    args: &Value,
    input: &Value,
) -> Result<(), String> {
    let attachments = read_tool(runtime, context, "list_item_attachments", input.clone()).await?;
    if !attachments
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["id"] == args["attachmentId"]))
    {
        return Err(
            "Attachment ownership changed or attachment does not belong to this Issue".into(),
        );
    }
    Ok(())
}

pub(super) async fn attachment_evidence(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    args: &Value,
    mut input: Value,
) -> Result<Value, String> {
    input["attachment_id"] = json!(required(args, "attachmentId")?);
    check_attachment(runtime, context, args, &input).await?;
    let document = read_file(
        runtime,
        context,
        args,
        input.clone(),
        "read_item_attachment",
    )
    .await?;
    let issue = read_tool(runtime, context, "get_board_item", input.clone()).await?;
    if issue["id"] != args["itemId"] || issue["cloud_project_id"] != args["projectId"] {
        return Err("Attachment Issue ownership changed while reading evidence".into());
    }
    check_attachment(runtime, context, args, &input).await?;
    Ok(file_evidence("attachmentId", args, document))
}
