//! A persistent device and a managed reader share the same DSH delivery lifecycle.
use super::*;

pub(super) fn supervise(
    runner: &LocalBackendRunner<SocketIoTransport>,
) -> impl Future<Output = ()> + Send + 'static {
    let handler = runner
        .runtime_work_handler
        .clone()
        .expect("remote Runtime handler");
    let hub = runner
        .runtime_event_hub
        .clone()
        .expect("remote Runtime event hub");
    let server = AppIpcServer::new()
        .with_connection_read_only()
        .with_device_id(runner.client.config.device_id.clone())
        .with_runtime_instance_id(runner.client.config.runtime_instance_id.clone())
        .with_device_route_id_slot(runner.device_route_id.clone())
        .with_shared_runtime_work_handler(handler.clone(), hub.raw_sender(), hub);
    async move {
        loop {
            let result = async {
                let owner = handler
                    .connection_service_owner()
                    .await
                    .map_err(|_| "Connected account is unavailable".to_owned())?;
                crate::runtime_work::connection_service::run(&server, owner).await
            }
            .await;
            if let Err(error) = result {
                write_executor_error_line(&format_executor_log(
                    "connection service unavailable",
                    &[("error", error)],
                ));
            }
            sleep(Duration::from_secs(30)).await;
        }
    }
}
