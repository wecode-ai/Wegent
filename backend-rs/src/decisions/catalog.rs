// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Fresh authorization through the unified catalog; raw CRDs stay server-side.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::http_compat::FastApiError;
use crate::json_compat::python_json_value;
use crate::models_unified::{
    aggregation::list_available_model_resources,
    models::{UnifiedModel, UnifiedQuery},
    mysql::{KindRow, UserRow},
};
use crate::state::AppState;

use super::DecisionError;

pub(super) type ModelResource = (UnifiedModel, KindRow);

pub(super) async fn available(
    state: &AppState,
    user: &UserRow,
) -> Result<Vec<ModelResource>, FastApiError> {
    list_available_model_resources(
        &state.mysql,
        state.erp.as_ref(),
        state.redis.as_ref(),
        user,
        &UnifiedQuery {
            scope: "all".into(),
            model_category_type: Some("decision".into()),
            client_origin: Some("wework".into()),
            ..Default::default()
        },
    )
    .await
    .map_err(|_| {
        tracing::error!(user_id = user.id, "Decision catalog read failed");
        FastApiError::unhandled()
    })
}

pub(super) fn model_key(model: &UnifiedModel) -> String {
    let identity = json!([
        model.model_type,
        model.namespace,
        model.resource_user_id,
        model.name
    ]);
    format!(
        "{:x}",
        Sha256::digest(python_json_value(&identity).as_bytes())
    )
}

pub(super) fn project(models: &[ModelResource]) -> Value {
    let models: Vec<Value> = models.iter().map(|(model, _)| json!({
        "id": model_key(model),
        "displayName": model.display_name.as_deref().filter(|name| !name.is_empty()).unwrap_or(&model.name),
        "modelId": model.model_id, "protocol": model.config.get("protocol"),
        "type": model.model_type, "namespace": model.namespace,
    })).collect();
    json!({"protocolVersion": 1, "defaultModel": models.first().map(|model| model["id"].clone()).unwrap_or(json!("")), "models": models})
}

pub(super) fn select(models: Vec<ModelResource>, id: &str) -> Result<KindRow, DecisionError> {
    models
        .into_iter()
        .find(|(model, _)| model_key(model) == id)
        .map(|(_, row)| row)
        .ok_or_else(|| {
            DecisionError::new(
                404,
                "model_not_found",
                "Decision model is not available",
                false,
            )
        })
}
