use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{bridge_request_with_record, read_bridge_record, BridgeClient, BridgeRecord};

const MAX_STATE_BYTES: usize = 4096;

#[derive(Default)]
pub(super) struct ScriptState(Mutex<Option<SavedState>>);

struct SavedState {
    bridge: BridgeRecord,
    value: Value,
}

impl ScriptState {
    pub(super) async fn run(
        &self,
        client: &BridgeClient,
        mut args: Value,
    ) -> Result<Value, String> {
        let mode = args
            .as_object_mut()
            .and_then(|args| args.remove("state_mode"));
        let payload = |arguments| {
            json!({
                "action": "callTool", "name": "run_script", "arguments": arguments,
            })
        };
        let Some(mode) = mode else {
            return super::bridge_request(client, payload(args)).await;
        };
        let reset = match mode.as_str() {
            Some("reuse") => false,
            Some("reset") => true,
            _ => return Err("run_script state_mode must be reuse or reset".into()),
        };
        let script = args["script"]
            .as_str()
            .ok_or("run_script requires a script string")?;
        let mut saved = self.0.lock().await;
        let record = read_bridge_record(&client.runtime_path).inspect_err(|_| *saved = None)?;
        if reset || saved.as_ref().is_some_and(|state| state.bridge != record) {
            *saved = None;
        }

        let initial_state = saved
            .as_ref()
            .map_or_else(|| "{}".into(), |state| state.value.to_string());
        let literal = serde_json::to_string(&initial_state).expect("JSON string is serializable");
        // Execute the user script in the original driver sandbox. Exchange only JSON
        // data with the desktop host, never a JavaScript object or a live AX handle.
        args["script"] = json!(format!(
            "const state = JSON.parse({literal});\nconst result = await (async () => {{\n{script}\n}})();\nreturn {{state, result: result ?? null}};"
        ));
        let mut result = bridge_request_with_record(client, &record, payload(args)).await?;
        if result["isError"] == true {
            return Ok(result);
        }

        let mut report = extract_report(&result)?;
        if report["ok"] == false {
            return Ok(result);
        }
        let value = unpack_state(&mut report)?;
        if value.to_string().len() > MAX_STATE_BYTES {
            return Err(
                "run_script state exceeds 4096 bytes; desktop actions may have taken effect".into(),
            );
        }
        let report = report.to_string();
        result["structuredJson"] = json!(report);
        result["text"] = json!(report);
        *saved = Some(SavedState {
            bridge: record,
            value,
        });
        Ok(result)
    }
}

fn extract_report(result: &Value) -> Result<Value, String> {
    result["structuredJson"]
        .as_str()
        .and_then(|report| serde_json::from_str(report).ok())
        .ok_or_else(invalid_report)
}

fn unpack_state(report: &mut Value) -> Result<Value, String> {
    let mut envelope = report["value"].take();
    let fields = envelope.as_object_mut().ok_or_else(invalid_report)?;
    let state = fields
        .remove("state")
        .filter(Value::is_object)
        .ok_or_else(invalid_report)?;
    report["value"] = fields.remove("result").ok_or_else(invalid_report)?;
    Ok(state)
}

fn invalid_report() -> String {
    "run_script could not save state from the driver result; desktop actions may have taken effect"
        .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn reuses_json_only_on_the_same_connection_and_driver_generation() {
        let home = tempfile::tempdir().unwrap();
        let runtime_path = home.path().join("bridge.json");
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/computer",
            axum::routing::post(|axum::Json(request): axum::Json<Value>| async move {
                let args = &request["arguments"];
                assert!(args.get("state_mode").is_none());
                let script = args["script"].as_str().unwrap();
                let literal = script
                    .lines()
                    .next()
                    .unwrap()
                    .strip_prefix("const state = JSON.parse(")
                    .unwrap()
                    .strip_suffix(");")
                    .unwrap();
                let initial: String = serde_json::from_str(literal).unwrap();
                let initial: Value = serde_json::from_str(&initial).unwrap();
                let count = initial["count"].as_u64().unwrap_or_default() + 1;
                let report =
                    json!({"ok": true, "value": {"state": {"count": count}, "result": count}});
                axum::Json(json!({"ok": true, "data": {
                    "text": report.to_string(),
                    "structuredJson": report.to_string(),
                    "isError": false
                }}))
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = BridgeClient {
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            runtime_path,
        };
        let publish = |token| {
            std::fs::write(
                &client.runtime_path,
                json!({"address": address.to_string(), "token": token}).to_string(),
            )
            .unwrap();
        };
        async fn run(state: &ScriptState, client: &BridgeClient, mode: &str) -> Value {
            let result = state
                .run(
                    client,
                    json!({"state_mode":mode, "script":"return ++state.count;"}),
                )
                .await
                .unwrap();
            let report = extract_report(&result).unwrap();
            assert_eq!(report, json!({"ok": true, "value": report["value"]}));
            assert_eq!(result["text"], report.to_string());
            report["value"].clone()
        }

        publish("generation-1");
        let state = ScriptState::default();
        assert_eq!(run(&state, &client, "reuse").await, 1);
        assert_eq!(run(&state, &client, "reuse").await, 2);
        assert_eq!(run(&ScriptState::default(), &client, "reuse").await, 1);
        assert_eq!(run(&state, &client, "reset").await, 1);
        assert_eq!(run(&state, &client, "reuse").await, 2);
        publish("generation-2");
        assert_eq!(run(&state, &client, "reuse").await, 1);
        server.abort();
    }
}
