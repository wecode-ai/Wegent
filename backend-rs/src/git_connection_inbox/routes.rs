use super::*;
use crate::auth::SessionUser;
use brz_http_server::Body;

#[brz_http_server::get("/api/v1/git-connections/subscriptions")]
async fn subscriptions(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<Value, FastApiError> {
    let ids = store::run(
        store::redis(state)?,
        "",
        Some(i64::from(user.id)),
        "list",
        json!({}),
    )
    .await?;
    let mut items = Vec::new();
    for id in ids["ids"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let result = store::run(
            store::redis(state)?,
            id,
            Some(i64::from(user.id)),
            "get",
            json!({}),
        )
        .await?;
        items.push(summary(&store::row(&result)?));
    }
    Ok(json!({"items":items}))
}

#[brz_http_server::post("/api/v1/git-connections/subscriptions")]
async fn create(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    body: Value,
) -> Result<Value, FastApiError> {
    validate_source(&body["source"])?;
    let device = field(&body, "deviceId")?;
    let id = crypto::random_id().map_err(storage_error)?;
    let secret = crypto::random_id().map_err(storage_error)?;
    let key = state
        .jwt_secret_keys
        .first()
        .ok_or_else(|| storage_error("missing key"))?;
    let row = Subscription {
        id: id.clone(),
        user_id: i64::from(user.id),
        device_id: device.into(),
        generation: crypto::random_id().map_err(storage_error)?,
        source: body["source"].clone(),
        secret: crypto::seal(key, &format!("{}:{id}", user.id), &secret).map_err(storage_error)?,
        active: true,
        confirmed_sequence: 0,
        gap_before: 0,
        last_received_at: None,
        latest_sequence: 0,
        pending_count: 0,
        connection_key: connection_key(device, &body["source"]),
    };
    let result = store::run(
        store::redis(state)?,
        &id,
        Some(i64::from(user.id)),
        "create",
        serde_json::to_value(row).map_err(storage_error)?,
    )
    .await?;
    let row = store::row(&result)?;
    let mut response = summary(&row);
    response["secret"] = json!(reveal(state, &row)?);
    Ok(response)
}

#[brz_http_server::put("/api/v1/git-connections/subscriptions/:id")]
async fn update(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    id: &str,
    mut body: Value,
) -> Result<Value, FastApiError> {
    let row = store::owned(state, id, Some(i64::from(user.id))).await?;
    body["connection_key"] = json!(connection_key(field(&body, "deviceId")?, &row.source));
    body["nextGeneration"] = json!(crypto::random_id().map_err(storage_error)?);
    if body.get("active").is_some_and(|v| !v.is_boolean()) {
        return Err(invalid("Invalid active flag"));
    }
    let result = store::run(
        store::redis(state)?,
        id,
        Some(i64::from(user.id)),
        "update",
        body,
    )
    .await?;
    let row = store::row(&result)?;
    Ok(json!({"id":row.id,"generation":row.generation}))
}

#[brz_http_server::delete("/api/v1/git-connections/subscriptions/:id")]
async fn remove(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    id: &str,
    body: Value,
) -> Result<Value, FastApiError> {
    store::run(
        store::redis(state)?,
        id,
        Some(i64::from(user.id)),
        "remove",
        body,
    )
    .await?;
    Ok(json!({"success":true}))
}

#[brz_http_server::post("/api/v1/git-connections/subscriptions/:id/events")]
async fn events(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    id: &str,
    body: Value,
) -> Result<Value, FastApiError> {
    body["after"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| invalid("Invalid inbox cursor"))?;
    let result = store::run(
        store::redis(state)?,
        id,
        Some(i64::from(user.id)),
        "events",
        body,
    )
    .await?;
    let row = store::row(&result)?;
    let mut items = Vec::new();
    for event in result["items"].as_array().into_iter().flatten() {
        let mut item: Value = serde_json::from_str(
            event["data"]
                .as_str()
                .ok_or_else(|| storage_error("Invalid delivery"))?,
        )
        .map_err(storage_error)?;
        item["sequence"] = event["sequence"].clone();
        items.push(item);
    }
    Ok(
        json!({"hasMore":items.len()==100,"items":items,"gapBefore":row.gap_before,"generation":row.generation}),
    )
}

#[brz_http_server::post("/api/v1/git-connections/subscriptions/:id/ack")]
async fn ack(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    id: &str,
    body: Value,
) -> Result<Value, FastApiError> {
    body["sequence"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| invalid("Invalid acknowledgement"))?;
    store::run(
        store::redis(state)?,
        id,
        Some(i64::from(user.id)),
        "ack",
        body,
    )
    .await?;
    Ok(json!({"success":true}))
}

#[brz_http_server::post("/api/v1/git-connections/subscriptions/:id/configuration")]
async fn configuration(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    id: &str,
    body: Value,
) -> Result<Value, FastApiError> {
    let result = store::run(
        store::redis(state)?,
        id,
        Some(i64::from(user.id)),
        "configuration",
        body.clone(),
    )
    .await?;
    let row = store::row(&result)?;
    let mut result = summary(&row);
    if body["reveal"] == true {
        result["secret"] = json!(reveal(state, &row)?);
    }
    Ok(result)
}

#[brz_http_server::post("/api/v1/git-connections/hooks/:id", access = public)]
#[allow(clippy::too_many_arguments)]
async fn receive(
    #[inject(state)] state: &AppState,
    id: &str,
    #[header("x-hub-signature-256")] github_signature: Option<&str>,
    #[header("x-github-event")] github_event: Option<&str>,
    #[header("x-github-delivery")] github_delivery: Option<&str>,
    #[header("x-gitlab-token")] gitlab_token: Option<&str>,
    #[header("x-gitlab-event")] gitlab_event: Option<&str>,
    #[header("x-gitlab-event-uuid")] gitlab_delivery: Option<&str>,
    body: Body<'_>,
) -> Result<Value, FastApiError> {
    if body.0.len() > 1024 * 1024 {
        return Err(FastApiError::detail(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Webhook exceeds 1 MiB",
        ));
    }
    let payload: Value =
        serde_json::from_slice(body.0).map_err(|_| invalid("Invalid webhook JSON"))?;
    if !payload.is_object() {
        return Err(invalid("Webhook must be an object"));
    }
    let row = store::owned(state, id, None).await?;
    if !row.active {
        return Err(FastApiError::detail(
            StatusCode::GONE,
            "Subscription disconnected",
        ));
    }
    let provider = row.source["provider"].as_str().unwrap_or("");
    let (signature, event, delivery) = if provider == "github" {
        (github_signature, github_event, github_delivery)
    } else {
        (gitlab_token, gitlab_event, gitlab_delivery)
    };
    if !crypto::verify(
        provider,
        &reveal(state, &row)?,
        body.0,
        signature.unwrap_or(""),
    ) {
        return Err(FastApiError::unauthorized("Invalid webhook signature"));
    }
    let event = event
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(|| invalid("Missing event type"))?;
    let delivery = delivery
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(|| invalid("Missing delivery identity"))?;
    validate_repository(provider, &row.source, &payload)?;
    let received = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let item = json!({"id":delivery,"eventType":event,"receivedAt":received,"payload":payload})
        .to_string();
    store::run(
        store::redis(state)?,
        id,
        None,
        "append",
        json!({"secret":row.secret,"deliveryId":delivery,"delivery":item,"receivedAt":received}),
    )
    .await?;
    Ok(json!({"accepted":true}))
}

fn validate_repository(
    provider: &str,
    source: &Value,
    payload: &Value,
) -> Result<(), FastApiError> {
    let repository = if provider == "github" {
        &payload["repository"]["id"]
    } else {
        payload["project"]
            .get("id")
            .unwrap_or(&payload["project_id"])
    };
    let repository = repository
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| repository.to_string());
    if repository != "null" && source["repositoryId"] != repository {
        return Err(invalid("Webhook repository mismatch"));
    }
    Ok(())
}
