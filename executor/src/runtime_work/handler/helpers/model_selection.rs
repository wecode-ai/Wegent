/// Extract model identity for diagnostics without exposing execution options or credentials.
fn model_selection_log_fields(runtime_handle: &Value) -> Vec<(&'static str, String)> {
    let selection = runtime_handle
        .get("modelSelection")
        .or_else(|| runtime_handle.get("model_selection"));
    let field = |camel: &str, snake: &str| {
        selection
            .and_then(|value| string_field(value, camel).or_else(|| string_field(value, snake)))
            .unwrap_or_else(|| "none".to_owned())
    };
    vec![
        ("model_selection_present", selection.is_some().to_string()),
        ("model_selection_name", field("modelName", "model_name")),
        ("model_selection_type", field("modelType", "model_type")),
    ]
}

/// Apply model metadata and log changed in-memory assignments when the payload identifies a task.
/// This event does not confirm that the task has been persisted to disk.
fn set_runtime_handle_model_selection(runtime_handle: &mut Value, payload: &Value) {
    let previous = runtime_handle
        .get("modelSelection")
        .or_else(|| runtime_handle.get("model_selection"))
        .cloned();
    apply_runtime_handle_model_selection(runtime_handle, payload);
    let current = runtime_handle
        .get("modelSelection")
        .or_else(|| runtime_handle.get("model_selection"));
    if previous.as_ref() == current {
        return;
    }
    if let Some(task_id) = runtime_task_id(payload) {
        let mut fields = vec![("local_task_id", task_id)];
        fields.extend(model_selection_log_fields(runtime_handle));
        log_executor_event("runtime task model selection updated", &fields);
    }
}

/// Copy explicit model selection or construct it from the existing legacy model fields.
fn apply_runtime_handle_model_selection(runtime_handle: &mut Value, payload: &Value) {
    if let Some(selection) = payload
        .get("modelSelection")
        .or_else(|| payload.get("model_selection"))
        .filter(|value| value.is_object())
    {
        let mut object = runtime_handle.as_object().cloned().unwrap_or_default();
        object.insert("modelSelection".to_owned(), selection.clone());
        *runtime_handle = Value::Object(object);
        return;
    }

    let Some(model_name) =
        string_field(payload, "modelId").or_else(|| string_field(payload, "model_id"))
    else {
        return;
    };
    let mut selection = Map::new();
    selection.insert("modelName".to_owned(), Value::String(model_name));
    selection.insert(
        "modelType".to_owned(),
        string_field(payload, "modelType")
            .or_else(|| string_field(payload, "model_type"))
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    selection.insert(
        "options".to_owned(),
        payload
            .get("modelOptions")
            .or_else(|| payload.get("model_options"))
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({})),
    );

    let mut object = runtime_handle.as_object().cloned().unwrap_or_default();
    object.insert("modelSelection".to_owned(), Value::Object(selection));
    *runtime_handle = Value::Object(object);
}

#[cfg(test)]
mod model_selection_diagnostics_tests {
    use super::*;

    #[test]
    fn model_selection_logs_only_identity_without_configuration_secrets() {
        let handle = json!({
            "modelSelection": {"modelName":"model-a", "modelType":"public",
                "options":{"api_key":"SYNTHETIC_SECRET","custom":"private option"}},
            "executionRequest":{"auth_token":"SYNTHETIC_SECRET"}
        });
        let fields = model_selection_log_fields(&handle);
        assert_eq!(
            fields,
            vec![
                ("model_selection_present", "true".to_owned()),
                ("model_selection_name", "model-a".to_owned()),
                ("model_selection_type", "public".to_owned()),
            ]
        );
        let encoded = serde_json::to_string(&fields).unwrap();
        assert!(!encoded.contains("SYNTHETIC_SECRET"));
        assert!(!encoded.contains("private option"));
    }

    #[test]
    fn model_selection_diagnostics_distinguish_missing_and_snake_case_metadata() {
        assert_eq!(model_selection_log_fields(&json!({}))[0].1, "false");
        let fields = model_selection_log_fields(&json!({"model_selection":{
            "model_name":"model-b", "model_type":"runtime"
        }}));
        assert_eq!(fields[1].1, "model-b");
        assert_eq!(fields[2].1, "runtime");
    }
}
