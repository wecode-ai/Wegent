// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl<T, R> LocalBackendRunner<T, R>
where
    T: LocalBackendTransport,
    R: TaskRunner,
{
    pub async fn run_forever(mut self) -> Result<(), String> {
        self.connection_status.store(false, Ordering::Release);
        let auth_home = crate::config::paths::executor_home();
        let _auth_broker = crate::plugin_account_auth::broker::start(
            self.client.transport.clone(),
            auth_home,
            self.connection_status.clone(),
            matches!(self.client.config.device_type.as_str(), "cloud" | "remote"),
        )
        .await
        .map_err(|error| error.to_string())?;
        if let Some(event_hub) = self.runtime_event_hub.take() {
            self.start_runtime_event_forwarder(event_hub);
        }
        self.register_handlers();
        let session_gateway = if self.start_session_gateway {
            match &self.session_handler {
                Some(handler) => start_session_gateway(Arc::clone(handler)).await?,
                None => None,
            }
        } else {
            None
        };
        self.client.set_runtime_transfer_port(
            session_gateway
                .as_ref()
                .map(|gateway| gateway.local_addr.port()),
        );
        let _session_gateway = session_gateway;
        let mut retry_delay = self.client.config.reconnect_delay;
        write_executor_log_line(&local_backend_starting_log_line(
            &self.client.config.backend_url,
            &self.client.config.device_id,
        ));

        loop {
            match self.connect_and_register().await {
                Ok(()) => {
                    write_executor_log_line(&local_backend_registered_log_line(
                        &self.client.config.backend_url,
                        &self.client.config.device_id,
                    ));
                    let stable_connection = self.heartbeat_until_reconnect().await;
                    self.connection_status.store(false, Ordering::Release);
                    if let Err(error) = self.client.transport.disconnect().await {
                        write_executor_error_line(&format_executor_log(
                            "local backend stale connection cleanup failed",
                            &[("error", error)],
                        ));
                    }
                    if stable_connection {
                        retry_delay = self.client.config.reconnect_delay;
                    } else {
                        sleep(retry_delay).await;
                        retry_delay = retry_delay
                            .saturating_mul(2)
                            .min(self.client.config.reconnect_delay_max);
                    }
                }
                Err(error) => {
                    self.connection_status.store(false, Ordering::Release);
                    let _ = self.client.transport.disconnect().await;
                    write_executor_error_line(&local_backend_connection_failure_log_line(
                        &self.client.config.backend_url,
                        &error,
                    ));
                    sleep(retry_delay).await;
                    retry_delay = retry_delay
                        .saturating_mul(2)
                        .min(self.client.config.reconnect_delay_max);
                }
            }
        }
    }

    pub async fn connect_and_register(&self) -> Result<(), String> {
        let epoch = *self.connection_epoch.lock().expect("connection epoch lock");
        self.client.connect().await?;
        match self
            .client
            .register_device(self.client.config.registration_timeout)
            .await
        {
            Ok(true) => {
                if let Err(error) = self.client.emit_liveness_heartbeat().await {
                    let _ = self.client.disconnect().await;
                    return Err(error);
                }
                if let Some(handler) = &self.session_handler {
                    handler
                        .lock()
                        .expect("session handler lock")
                        .prepare_terminal_reconnect();
                }
                if let Err(error) = self.publish_registered_connection(epoch) {
                    let _ = self.client.disconnect().await;
                    return Err(error);
                }
                self.trigger_runtime_work_poll();
                Ok(())
            }
            Ok(false) => {
                let _ = self.client.disconnect().await;
                Err("device registration was rejected by backend".to_owned())
            }
            Err(error) => {
                let _ = self.client.disconnect().await;
                Err(error)
            }
        }
    }

    /// Publish readiness atomically with respect to connection-close notifications.
    fn publish_registered_connection(&self, registered_epoch: u64) -> Result<(), String> {
        let epoch = self.connection_epoch.lock().expect("connection epoch lock");
        if *epoch != registered_epoch {
            return Err("local backend connection closed during registration".to_owned());
        }
        self.connection_status.store(true, Ordering::Release);
        Ok(())
    }

    pub(super) async fn heartbeat_until_reconnect(&self) -> bool {
        enum RunnerTick {
            ConnectionStatus,
            Heartbeat,
            RuntimeWork,
        }

        let mut consecutive_failures = 0_u32;
        let mut observed_successful_heartbeat = false;
        let mut next_connection_status_poll_at =
            Instant::now() + RUNTIME_EVENT_CONNECTION_POLL_INTERVAL;
        let mut next_heartbeat_at = Instant::now() + self.client.config.heartbeat_interval;
        let mut next_runtime_work_poll_at =
            Instant::now() + self.client.config.runtime_work_poll_interval;
        let terminal_event_notifier = self.session_handler.as_ref().map(|handler| {
            handler
                .lock()
                .expect("session handler lock")
                .terminal_event_notifier()
        });
        let terminal_relay = self.relay_terminal_events_until_error(terminal_event_notifier);
        tokio::pin!(terminal_relay);
        loop {
            let tick = tokio::select! {
                _ = sleep_until(next_connection_status_poll_at) => RunnerTick::ConnectionStatus,
                _ = sleep_until(next_heartbeat_at) => RunnerTick::Heartbeat,
                _ = sleep_until(next_runtime_work_poll_at) => RunnerTick::RuntimeWork,
                result = &mut terminal_relay => {
                    let error = result.expect_err("terminal relay only stops on error");
                    write_executor_error_line(&format_executor_log(
                        "terminal event relay paused until reconnect",
                        &[("error", error)],
                    ));
                    let _ = self.client.disconnect().await;
                    return observed_successful_heartbeat;
                }
            };
            if matches!(tick, RunnerTick::ConnectionStatus) {
                if !self.connection_status.load(Ordering::Acquire) {
                    let _ = self.client.disconnect().await;
                    return observed_successful_heartbeat;
                }
                next_connection_status_poll_at =
                    Instant::now() + RUNTIME_EVENT_CONNECTION_POLL_INTERVAL;
                continue;
            }
            if matches!(tick, RunnerTick::RuntimeWork) {
                self.trigger_runtime_work_poll();
                next_runtime_work_poll_at =
                    Instant::now() + self.client.config.runtime_work_poll_interval;
                continue;
            }
            if let Some(handler) = &self.session_handler {
                handler
                    .lock()
                    .expect("session handler lock")
                    .reap_expired_sessions();
            }
            let failure = match self.client.emit_liveness_heartbeat().await {
                Ok(()) => {
                    consecutive_failures = 0;
                    observed_successful_heartbeat = true;
                    self.trigger_runtime_work_poll();
                    next_heartbeat_at = Instant::now() + self.client.config.heartbeat_interval;
                    next_runtime_work_poll_at =
                        Instant::now() + self.client.config.runtime_work_poll_interval;
                    continue;
                }
                Err(error) => error,
            };

            consecutive_failures += 1;
            write_executor_error_line(&local_backend_heartbeat_failure_log_line(
                &self.client.config.backend_url,
                &failure,
            ));
            if consecutive_failures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES {
                let _ = self.client.disconnect().await;
                return observed_successful_heartbeat;
            }
            next_heartbeat_at = Instant::now() + self.client.config.heartbeat_timeout;
        }
    }
}
