use super::*;
use crate::runtime_work::handler::control::tests::{seed, EnvGuard};
use futures_util::FutureExt;

fn source() -> Value {
    json!({"providerId":"documents","profile":"account","kind":"document","id":"doc","name":"Document"})
}

#[test]
fn empty_ui_maintenance_preserves_the_uninitialized_journal() {
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path().to_str().unwrap());
    let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for _ in 0..2 {
                handler.poll_ui_observers().await.unwrap();
                handler.poll_connection_observation_sources().await.unwrap();
            }
        });
    assert!(handler
        .read_ui_observer("not-yet-registered")
        .unwrap()
        .is_null());
    event_store::transact(&handler.event_subscription_path(), |state| {
        assert!(state["observers"].as_object().unwrap().is_empty());
        assert_eq!(state["operations"], json!({}));
        Ok(())
    })
    .unwrap();
}

async fn command(
    ipc: &crate::local::app_ipc::AppIpcServer,
    operation: &str,
    input: Value,
) -> Result<Value, AppIpcError> {
    ipc.dispatch("device.execute_command",json!({"command_key":format!("connection_observer_{operation}"),"args":[input.to_string()]})).await
}

#[test]
fn missing_source_authentication_is_reported_without_creating_an_observer() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env = EnvGuard::home(root.path().to_str().unwrap());
            let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
            let recorded = calls.clone();
            let app = axum::Router::new().route(
                "/wework/connections/v1/rpc",
                axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                    recorded.lock().unwrap().push(body.clone());
                    async move {
                        assert_eq!(body["method"], "listResources");
                        axum::Json(json!({"ok":true,"result":{"items":[],"hasMore":false,"availability":{"status":"auth_required","authTarget":{"pluginKey":"git","connectorSlug":"github"}}}}))
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let handler = RuntimeWorkRpcHandler::new("control-test-device", "/bin/false");
            handler.configure_connection_host(json!({"url":format!("http://{address}/wework/connections/v1/rpc"),"token":"a".repeat(64)})).unwrap();
            let ipc = crate::local::app_ipc::AppIpcServer::new()
                .with_runtime_work_handler(handler.clone());
            let failure = command(&ipc, "start", json!({"consumerKey":"ui-auth","generation":"one","discovery":{"providerId":"git","kind":"repository","query":"{}"}})).await.unwrap();
            assert_eq!(failure["success"], false);
            assert_eq!(failure["exit_code"], 1);
            assert_eq!(failure["error"], "connector_auth_required");
            assert_eq!(failure["stderr"], "Authorize this connection before observing the resource");
            assert_eq!(calls.lock().unwrap().len(), 1);
            assert!(handler.read_ui_observer(&observer_id("control-test-device", "ui-auth", "one")).unwrap().is_null());
            assert!(handler.command_journal.lock().unwrap().is_empty());
            server.abort();
            let _ = server.await;
        });
}

#[test]
fn ui_leases_and_a_model_consumer_share_one_due_collector_without_ui_model_work() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let root=tempfile::tempdir().unwrap(); let _env=EnvGuard::home(root.path().to_str().unwrap());
        let calls=Arc::new(Mutex::new(Vec::<Value>::new())); let recorded=calls.clone();
        let app=axum::Router::new().route("/wework/connections/v1/rpc",axum::routing::post(move |axum::Json(body):axum::Json<Value>| {
            recorded.lock().unwrap().push(body.clone());
            async move {
                let result=match body["method"].as_str().unwrap() {
                    "validate"=>body["input"].clone(),
                    "initializeObservation"=>json!({"source":body["input"],"checkpoint":{"cursor":4,"privateCursor":"never-project-this"}}),
                    "collectObservation"=> {
                        if body["input"]["source"]["id"]=="broken" { return axum::Json(json!({"ok":true,"result":{"events":"invalid","nextCheckpoint":{"cursor":999}}})); }
                        let cursor=body["input"]["checkpoint"]["cursor"].as_u64().unwrap();
                        json!({"events":[{"id":format!("event-{cursor}"),"eventType":"document.updated","at":chrono::Utc::now().to_rfc3339()}],"resourceStates":[{"kind":"document","data":{"revision":cursor+1}}],"nextCheckpoint":{"cursor":cursor+1,"privateCursor":"never-project-this"}})
                    }
                    _=>panic!("An observer cannot create a conversation or execute a model"),
                };
                axum::Json(json!({"ok":true,"result":result}))
            }
        }));
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(); let address=listener.local_addr().unwrap();
        let server=tokio::spawn(async move { axum::serve(listener,app).await.unwrap() });
        let handler=RuntimeWorkRpcHandler::new("control-test-device","/bin/false");
        handler.configure_connection_host(json!({"url":format!("http://{address}/wework/connections/v1/rpc"),"token":"a".repeat(64)})).unwrap();
        let ipc=crate::local::app_ipc::AppIpcServer::new().with_runtime_work_handler(handler.clone());
        let first=command(&ipc,"start",json!({"consumerKey":"ui-1","generation":"one","source":source()})).await.unwrap();
        let second=command(&ipc,"start",json!({"consumerKey":"ui-2","generation":"one","source":source()})).await.unwrap();
        assert_eq!(first["stdout"]["observation"]["id"],second["stdout"]["observation"]["id"]);
        assert!(!first.to_string().contains("privateCursor")); assert!(!first.to_string().contains("never-project-this"));
        let observation=first["stdout"]["observation"]["id"].as_str().unwrap().to_owned();
        let mut model_source=first["stdout"]["observer"]["source"].clone(); model_source["enabledAfter"]=json!(chrono::Utc::now().to_rfc3339());
        seed(&handler,"task"); handler.store.update_task("task",|link|link.interaction_status=Some("waiting_for_user".into()));
        let model_id=handler.subscription_id("task","wait");
        handler.save_event_subscription(&model_id,&json!({"task_id":"task","device_id":"control-test-device","session":{"engine":"Codex","id":"thread-task"},"status":"armed","source":model_source,"observation_id":observation,"initial_sequence":1,"after_sequence":1,"match":{},"continuation":"Continue work"})).unwrap();
        for key in ["ui-1","ui-2"] { command(&ipc,"renew",json!({"consumerKey":key,"generation":"one"})).await.unwrap(); }
        assert_eq!(calls.lock().unwrap().iter().filter(|call|call["method"]=="collectObservation").count(),1);
        command(&ipc,"refresh",json!({"consumerKey":"ui-1","generation":"one"})).await.unwrap();
        assert!(handler.connection_observation_wakeup.notified().now_or_never().is_some(),"A UI collector wakes the model dispatcher without waiting for maintenance");
        let pending_wakeup=|| event_store::transact(&handler.event_subscription_path(),|state|Ok(state["operations"][&model_id]["pending_wakeup"].clone())).unwrap();
        assert_eq!(pending_wakeup(),true);
        handler.poll_conversation_connection_events(false).await.unwrap();
        assert_eq!(pending_wakeup(),false,"The new captured batch is attempted outside a maintenance tick");
        handler.poll_conversation_connection_events(false).await.unwrap();
        assert_eq!(pending_wakeup(),false);
        assert!(handler.connection_observation_wakeup.notified().now_or_never().is_none(),"A blocked pending retry cannot repeatedly signal immediate work");
        handler.poll_connection_observation_sources().await.unwrap();
        assert_eq!(calls.lock().unwrap().iter().filter(|call|call["method"]=="collectObservation").count(),2);
        event_store::transact(&handler.event_subscription_path(),|state| { state["observations"][&observation]["next_poll_at"]=json!(0); Ok(()) }).unwrap();
        handler.poll_connection_observation_sources().await.unwrap(); handler.poll_conversation_connection_events(true).await.unwrap();
        let latest=command(&ipc,"renew",json!({"consumerKey":"ui-2","generation":"one"})).await.unwrap();
        assert_eq!(latest["stdout"]["observation"]["resourceStates"][0]["data"]["revision"],7);
        let collected:Vec<_>=calls.lock().unwrap().iter().filter(|call|call["method"]=="collectObservation").cloned().collect();
        assert_eq!(collected.len(),3); assert_eq!(collected[0]["input"]["force"],false); assert_eq!(collected[1]["input"]["force"],true);
        let mut broken_source=source(); broken_source["id"]=json!("broken"); broken_source["name"]=json!("Broken source");
        let broken=command(&ipc,"start",json!({"consumerKey":"ui-broken","generation":"one","source":broken_source})).await.unwrap();
        assert_eq!(broken["stdout"]["observation"]["errorCode"],"invalid_event_subscription");
        let broken_id=broken["stdout"]["observation"]["id"].as_str().unwrap();
        let count=calls.lock().unwrap().len(); command(&ipc,"renew",json!({"consumerKey":"ui-broken","generation":"one"})).await.unwrap(); assert_eq!(calls.lock().unwrap().len(),count);
        event_store::transact(&handler.event_subscription_path(),|state| {
            assert_eq!(state["observations"][broken_id]["checkpoint"]["cursor"],4,"Invalid pages cannot advance a checkpoint");
            state["observations"][broken_id]["next_poll_at"]=json!(0); state["observations"][&observation]["next_poll_at"]=json!(0); Ok(())
        }).unwrap();
        handler.poll_connection_observation_sources().await.unwrap();
        let healthy=command(&ipc,"renew",json!({"consumerKey":"ui-2","generation":"one"})).await.unwrap();
        assert_eq!(healthy["stdout"]["observation"]["resourceStates"][0]["data"]["revision"],8);
        assert!(healthy["stdout"]["observation"]["errorCode"].is_null());
        let captured=event_store::transact(&handler.event_subscription_path(),|state|Ok(state["operations"][&model_id].clone())).unwrap();
        assert_eq!(captured["status"],"pending"); assert_eq!(captured["events"][0]["id"],"event-5");
        let key=captured["resource_event_keys"][0].as_str().unwrap().to_owned();
        handler.validate_resource_event_keys("task",std::slice::from_ref(&key)).unwrap();
        assert!(handler.validate_resource_event_keys("ui-1",std::slice::from_ref(&key)).is_err());
        assert!(handler.command_journal.lock().unwrap().is_empty());
        for key in ["ui-1","ui-2","ui-broken","stopped-before-start"] {
            command(&ipc,"stop",json!({"consumerKey":key,"generation":"one"})).await.unwrap();
            assert!(command(&ipc,"start",json!({"consumerKey":key,"generation":"one","source":source()})).await.is_err());
        }
        let before=calls.lock().unwrap().len(); handler.poll_connection_observation_sources().await.unwrap(); assert_eq!(calls.lock().unwrap().len(),before);
        assert!(!latest.to_string().contains("private-secret"));
        server.abort(); let _=server.await;
    });
}

#[test]
fn expired_or_corrupt_ui_leases_cannot_reactivate_or_break_the_runtime() {
    let _guard = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env = EnvGuard::home(root.path().to_str().unwrap());
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        let handler=RuntimeWorkRpcHandler::new("device","/bin/false");
        let id=observer_id("device","ui","one");
        handler.save_ui_observer(&json!({"id":id,"consumer_key":"ui","generation":"one","device_id":"device","status":"observing","expires_at":now_ms()-1})).unwrap();
        assert_eq!(handler.connection_observer_operation("renew",json!({"consumerKey":"ui","generation":"one"})).await.unwrap_err().code,"observation_observer_lease_lost");
        handler.poll_ui_observers().await.unwrap(); assert_eq!(handler.read_ui_observer(&id).unwrap()["status"],"stopped");
        let broken_id=observer_id("device","broken","one");
        handler.save_ui_observer(&json!({"id":broken_id,"consumer_key":"broken","generation":"one","device_id":"device","status":"observing","expires_at":now_ms()+90_000,"observation_id":"corrupt-source","source":source()})).unwrap();
        let before=event_store::transact(&handler.event_subscription_path(),|state| {
            state["observations"]["corrupt-source"]=json!({"source":source(),"checkpoint":{"cursor":4},"sequence":3,"events":"corrupt"}); Ok(state.clone())
        }).unwrap();
        handler.poll_connection_observation_sources().await.unwrap();
        assert_eq!(event_store::transact(&handler.event_subscription_path(),|state|Ok(state.clone())).unwrap(),before,"Corrupt source state must not be repaired or reset by collection");
        event_store::transact(&handler.event_subscription_path(),|state| { state["observers"][observer_id("device","ui","two")]=json!(true); Ok(()) }).unwrap();
        assert_eq!(handler.connection_observer_operation("start",json!({"consumerKey":"ui","generation":"two","source":source()})).await.unwrap_err().code,"control_storage_failed");
        assert!(handler.command_journal.lock().unwrap().is_empty());
    });
}

#[test]
fn cloud_ui_lease_recovers_lost_replies_without_local_collection_or_stale_account_reads() {
    let _guard = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
        for stop_unconfirmed in [false,true] {
            let root=tempfile::tempdir().unwrap(); let _env=EnvGuard::home(root.path().to_str().unwrap());
            let requests=Arc::new(Mutex::new(Vec::<Value>::new())); let recorded=requests.clone();
            let plugins=Arc::new(Mutex::new(Vec::<Value>::new())); let plugin_calls=plugins.clone();
            let stored=Arc::new(Mutex::new(None::<(Value,Value)>)); let canonical=stored.clone();
            let forged=Arc::new(AtomicBool::new(false)); let forged_owner=forged.clone();
            let stop_calls=Arc::new(std::sync::atomic::AtomicUsize::new(0)); let stops=stop_calls.clone();
            let app=axum::Router::new()
                .route("/api/users/me",axum::routing::get(||async{axum::Json(json!({"id":7}))}))
                .route("/wework/connections/v1/rpc",axum::routing::post(move |axum::Json(body):axum::Json<Value>| {
                    plugin_calls.lock().unwrap().push(body.clone());
                    async move {
                        let result=match body["method"].as_str().unwrap() {
                            "validate"=>body["input"].clone(),
                            "initializeObservation"=>json!({"source":body["input"],"checkpoint":{"cursor":4,"privateCursor":"private-cloud-cursor"}}),
                            _=>panic!("A cloud UI lease must not collect its source locally"),
                        };
                        axum::Json(json!({"ok":true,"result":result}))
                    }
                }))
                .route("/api/runtime-observations/command",axum::routing::post(move |headers:axum::http::HeaderMap,axum::Json(body):axum::Json<Value>| {
                    let recorded=recorded.clone(); let canonical=canonical.clone(); let forged=forged_owner.clone(); let stops=stops.clone();
                    async move {
                        assert_eq!(headers.get("authorization").unwrap(),"Bearer synthetic-ui-session");
                        assert_eq!(body["expectedOwnerId"],7); recorded.lock().unwrap().push(body.clone());
                        let mut stored=canonical.lock().unwrap();
                        if body["action"]=="observe" {
                            if let Some((original,response))=stored.as_ref() { assert_eq!(body,*original,"A lost reply must reuse the original source and checkpoint"); return(axum::http::StatusCode::OK,axum::Json(response.clone())); }
                            let observer=&body["observer"]; let device=observer["deviceId"].as_str().unwrap();
                            let id=observer_id(device,observer["consumerKey"].as_str().unwrap(),observer["generation"].as_str().unwrap());
                            let observation=format!("{:x}",Sha256::digest(canonical_json(&observation_identity(&observer["source"]))));
                            let response=json!({"ownerId":7,"observer":{"id":id,"deviceId":device,"consumerKey":observer["consumerKey"],"generation":observer["generation"],"source":observer["source"],"observationId":observation,"expiresAt":now_ms()+90_000,"stopped":false},"observation":{"id":observation,"source":observer["source"],"resourceStates":[{"kind":"document","data":{"revision":9}}],"lastCollectedAt":1000,"refreshPending":false}});
                            *stored=Some((body,response));
                            return(axum::http::StatusCode::SERVICE_UNAVAILABLE,axum::Json(json!({"detail":"reply_lost"})));
                        }
                        let (original,response)=stored.as_ref().unwrap();
                        let result=match body["action"].as_str().unwrap() {
                            "renew_observer"=> {
                                assert_eq!(body["observerId"],response["observer"]["id"]); assert_eq!(body["generation"],"one");
                                let mut response=response.clone(); if forged.load(Ordering::Acquire) {response["ownerId"]=json!(8);} response
                            }
                            "refresh"=>json!({"ownerId":7,"observation":{"id":response["observation"]["id"]}}),
                            "stop_observer"=> {
                                assert_eq!(body["observer"],original["observer"]); assert_eq!(body["initialCheckpoint"],original["initialCheckpoint"]);
                                if stops.fetch_add(1,Ordering::AcqRel)==0 {return(axum::http::StatusCode::SERVICE_UNAVAILABLE,axum::Json(json!({"detail":"reply_lost"})));}
                                json!({"ownerId":7,"stopped":true})
                            }
                            _=>panic!("Unexpected observation action"),
                        };
                        (axum::http::StatusCode::OK,axum::Json(result))
                    }
                }));
            let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();let address=listener.local_addr().unwrap();
            let server=tokio::spawn(async move{axum::serve(listener,app).await.unwrap()});
            let handler=RuntimeWorkRpcHandler::new("control-test-device","/bin/false").with_connection_observation_device_type("remote");
            let connection=ConnectionConfig {backend_url:format!("http://{address}"),auth_token:"synthetic-ui-session".into(),authenticated_user_id:Some(7),..Default::default()};
            *handler.backend_connection.lock().unwrap()=Some(connection.clone());
            handler.configure_connection_host(json!({"url":format!("http://{address}/wework/connections/v1/rpc"),"token":"a".repeat(64)})).unwrap();
            let ipc=crate::local::app_ipc::AppIpcServer::new().with_runtime_work_handler(handler.clone());
            let start=json!({"consumerKey":"cloud-ui","generation":"one","source":source()});
            assert!(command(&ipc,"start",start.clone()).await.is_err());
            if !stop_unconfirmed {
                let result=command(&ipc,"start",start.clone()).await.unwrap();
                assert_eq!(result["stdout"]["observation"]["resourceStates"][0]["data"]["revision"],9);
                assert!(!result.to_string().contains("private-cloud-cursor"));
                forged.store(true,Ordering::Release);
                assert!(command(&ipc,"renew",json!({"consumerKey":"cloud-ui","generation":"one"})).await.is_err());
                forged.store(false,Ordering::Release);
                let refreshing=command(&ipc,"refresh",json!({"consumerKey":"cloud-ui","generation":"one"})).await.unwrap();
                assert_eq!(refreshing["stdout"]["observation"]["refreshPending"],true);
                let count=requests.lock().unwrap().len();
                let mut wrong=connection.clone(); wrong.backend_url="http://127.0.0.1:1".into(); *handler.backend_connection.lock().unwrap()=Some(wrong);
                assert_eq!(command(&ipc,"renew",json!({"consumerKey":"cloud-ui","generation":"one"})).await.unwrap_err().code,"connection_account_changed");
                assert_eq!(requests.lock().unwrap().len(),count); *handler.backend_connection.lock().unwrap()=Some(connection.clone());
            }
            assert!(command(&ipc,"stop",json!({"consumerKey":"cloud-ui","generation":"one"})).await.is_err());
            let restarted=RuntimeWorkRpcHandler::new("control-test-device","/bin/false").with_connection_observation_device_type("remote");
            *restarted.backend_connection.lock().unwrap()=Some(connection);
            restarted.poll_ui_observers().await.unwrap();
            let record=restarted.read_ui_observer(&observer_id("control-test-device","cloud-ui","one")).unwrap();
            assert_eq!(record["status"],"stopped");assert_eq!(record["cloud_stop_pending"],false);
            assert!(restarted.connection_observer_operation("start",start).await.is_err());
            assert_eq!(plugins.lock().unwrap().len(),2,"Retrying or stopping cannot reinitialize the source");
            assert!(restarted.command_journal.lock().unwrap().is_empty());
            server.abort();let _=server.await;
        }
    });
}
