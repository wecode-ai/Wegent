use super::*;

impl RuntimeWorkRpcHandler {
    async fn observer_backend(
        &self,
        record: &Value,
        mut input: Value,
    ) -> Result<Value, AppIpcError> {
        let registration = &record["cloud_registration"];
        let connection = self
            .backend_connection_snapshot()?
            .ok_or_else(|| invalid("Connect this Runtime to its cloud account"))?;
        if registration["backend_url"] != connection.backend_url
            || registration["device_id"] != self.cloud_device_id()?
        {
            return Err(AppIpcError::new(
                "connection_account_changed",
                "The observation belongs to another connection",
            ));
        }
        input["expectedOwnerId"] = registration["owner_id"].clone();
        let response = Self::runtime_request_on(
            &connection,
            reqwest::Method::POST,
            "/runtime-observations/command",
            Some(&input),
        )
        .await?;
        let status = response.status();
        let body = response
            .json::<Value>()
            .await
            .map_err(|_| invalid("Invalid cloud observation response"))?;
        if !status.is_success() {
            let code = match body["detail"].as_str() {
                Some("observation_observer_lease_lost" | "observation_observer_unavailable") => {
                    "observation_observer_lease_lost"
                }
                Some("observation_owner_changed") => "connection_account_changed",
                _ => "cloud_request_failed",
            };
            return Err(AppIpcError::new(
                code,
                "Cloud observation request was not accepted",
            ));
        }
        if body["ownerId"] != registration["owner_id"] {
            return Err(invalid("Observation account changed"));
        }
        if self.backend_connection_snapshot()?.as_ref() != Some(&connection) {
            let current = self.backend_connection_snapshot()?.ok_or_else(|| {
                AppIpcError::new(
                    "connection_account_changed",
                    "The observation connection changed",
                )
            })?;
            if current.backend_url != connection.backend_url
                || registration["device_id"] != self.cloud_device_id()?
            {
                return Err(AppIpcError::new(
                    "connection_account_changed",
                    "The observation connection changed",
                ));
            }
            if Self::local_connection_user(&current).ok() != registration["owner_id"].as_i64()
                || self.backend_connection_snapshot()?.as_ref() != Some(&current)
            {
                return Err(AppIpcError::new(
                    "connection_account_changed",
                    "The observation connection changed",
                ));
            }
        }
        Ok(body)
    }

    fn cloud_ui_observer_id(record: &Value) -> Result<String, AppIpcError> {
        Ok(observer_id(
            field(&record["cloud_registration"], "device_id")?,
            field(record, "consumer_key")?,
            field(record, "generation")?,
        ))
    }

    pub(super) async fn read_cloud_ui_observer(
        &self,
        record: &mut Value,
        force: bool,
    ) -> Result<(), AppIpcError> {
        let registration = &record["cloud_registration"];
        let cloud_id = Self::cloud_ui_observer_id(record)?;
        let input = if record["cloud_observer"].is_object() {
            json!({"action":"renew_observer","observerId":cloud_id,"deviceId":registration["device_id"],"generation":record["generation"]})
        } else {
            json!({"action":"observe","observer":{"deviceId":registration["device_id"],"consumerKey":record["consumer_key"],"generation":record["generation"],"source":record["source"]},"initialCheckpoint":record["initial_checkpoint"]})
        };
        let response = self.observer_backend(record, input).await?;
        let row = &response["observer"];
        if row["id"] != cloud_id
            || row["deviceId"] != registration["device_id"]
            || row["consumerKey"] != record["consumer_key"]
            || row["generation"] != record["generation"]
            || row["stopped"] != false
            || row["observationId"] != record["observation_id"]
            || row["expiresAt"].as_i64().is_none_or(|value| value <= 0)
            || observation_identity(&row["source"]) != observation_identity(&record["source"])
            || response["observation"]["id"] != record["observation_id"]
            || observation_identity(&response["observation"]["source"])
                != observation_identity(&record["source"])
        {
            return Err(invalid("Cloud observation identity changed"));
        }
        record["cloud_observer"] = json!({"id":cloud_id});
        record["last_collected_at"] = response["observation"]["lastCollectedAt"].clone();
        record["resource_states"] = response["observation"]["resourceStates"].clone();
        record["error_code"] = response["observation"]["errorCode"].clone();
        record["refresh_pending"] = json!(response["observation"]["refreshPending"] == true);
        // Persist successful registration before another request can lose its reply.
        self.save_ui_observer(record)?;
        if force {
            let refreshed = self
                .observer_backend(
                    record,
                    json!({"action":"refresh","observationId":record["observation_id"]}),
                )
                .await?;
            if refreshed["observation"]["id"] != record["observation_id"] {
                return Err(invalid("Cloud observation identity changed"));
            }
            record["refresh_pending"] = json!(true);
        }
        Ok(())
    }

    pub(super) async fn stop_cloud_ui_observer(
        &self,
        record: &mut Value,
    ) -> Result<(), AppIpcError> {
        if record["cloud_registration"].is_null() {
            record["cloud_stop_pending"] = json!(false);
            return Ok(());
        }
        let input = json!({"action":"stop_observer","observerId":Self::cloud_ui_observer_id(record)?,"generation":record["generation"],
            "observer":{"deviceId":record["cloud_registration"]["device_id"],"consumerKey":record["consumer_key"],"generation":record["generation"],"source":record["source"]},"initialCheckpoint":record["initial_checkpoint"]});
        match self.observer_backend(record, input).await {
            Ok(response) if response["stopped"] == true => {}
            Err(error) if error.code == "observation_observer_lease_lost" => {}
            Err(error) => return Err(error),
            _ => {
                return Err(invalid(
                    "Cloud observation cancellation was not acknowledged",
                ))
            }
        }
        record["cloud_stop_pending"] = json!(false);
        Ok(())
    }
}
