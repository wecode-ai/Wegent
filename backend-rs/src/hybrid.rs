// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::env;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use http::{Method, Uri};
use tracing::info;

use crate::filters::{RequestIdFilter, gateway_cors, server_config};
use crate::{Application, BoxError, Gateway, OriginService, RouteTable, RustApi, bind, serve};

mod routes;
#[cfg(test)]
mod runtime_tests;
use routes::load as load_routes;
pub use routes::load_routes_config;

const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 8000;
pub(crate) const DEFAULT_PYTHON_UPSTREAM: &str = "http://127.0.0.1:8004";
const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
// The locked OriginService uses hyper-util's 90s idle connection pool. Keep
// loopback connections alive beyond that lease; the independent public gateway
// retains its default 15s request-head deadline.
const ORIGIN_HEADER_READ_TIMEOUT: Duration = Duration::from_secs(120);

fn origin_runtime_config(shutdown_grace: Duration) -> brz_http_server::hyper::Config {
    brz_http_server::hyper::Config {
        header_read_timeout: ORIGIN_HEADER_READ_TIMEOUT,
        shutdown_grace,
        ..Default::default()
    }
}

/// Process configuration shared by public and private hybrid Backend binaries.
#[derive(Clone, Debug)]
pub struct HybridConfig {
    pub listen_address: SocketAddr,
    pub python_upstream: Uri,
    pub routes: RouteTable,
    pub shutdown_grace: Duration,
}

impl HybridConfig {
    /// Loads the existing hybrid gateway environment contract.
    ///
    /// An unset route file produces an empty route table, preserving full
    /// Python fallback.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid address, port, upstream URL, or route
    /// configuration.
    pub fn from_env() -> Result<Self, BoxError> {
        let mut config = Self::from_env_without_routes()?;
        if let Some(path) = env::var_os("WEGENT_RS_ROUTES_FILE") {
            config = config.with_routes_file(Path::new(&path))?;
        }
        Ok(config)
    }

    /// Loads listener and upstream settings, leaving route selection to callers.
    ///
    /// # Errors
    /// Returns an error for an invalid address, port or upstream URL.
    pub fn from_env_without_routes() -> Result<Self, BoxError> {
        let host: IpAddr = env::var("WEGENT_RS_LISTEN_HOST")
            .unwrap_or_else(|_| DEFAULT_HOST.to_owned())
            .parse()?;
        let port =
            env::var("WEGENT_RS_LISTEN_PORT").map_or(Ok(DEFAULT_PORT), |port| port.parse())?;
        let python_upstream = env::var("WEGENT_PYTHON_UPSTREAM_URL")
            .unwrap_or_else(|_| DEFAULT_PYTHON_UPSTREAM.to_owned())
            .parse()?;
        Ok(Self {
            listen_address: SocketAddr::new(host, port),
            python_upstream,
            routes: RouteTable::empty(),
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
        })
    }

    /// Constructs a hybrid configuration without process environment access.
    #[must_use]
    pub fn new(listen_address: SocketAddr, python_upstream: Uri, routes: RouteTable) -> Self {
        Self {
            listen_address,
            python_upstream,
            routes,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
        }
    }

    #[must_use]
    pub fn with_shutdown_grace(mut self, shutdown_grace: Duration) -> Self {
        self.shutdown_grace = shutdown_grace;
        self
    }

    /// Adds route rules from a file, including files it explicitly includes.
    ///
    /// # Errors
    /// Returns an error when a route file cannot be read or has an invalid rule.
    pub fn with_routes_file(mut self, path: &Path) -> Result<Self, BoxError> {
        self.routes = load_routes(path)?;
        Ok(self)
    }

    /// Reports whether a request is selected for the Rust API listener.
    #[must_use]
    pub fn selects_rust(&self, method: &Method, path: &str) -> bool {
        self.routes.matches(method, path)
    }
}

/// Runs a route-selective service with Python as the fallback origin.
///
/// # Errors
///
/// Returns an error when the upstream URL is invalid, the listener cannot bind,
/// or the gateway accept loop fails.
pub async fn serve_hybrid<S, F>(config: HybridConfig, api: S, shutdown: F) -> Result<(), BoxError>
where
    S: RustApi,
    F: Future<Output = ()>,
{
    // The gateway selects the Rust origin once. Requests not in the table are
    // forwarded to Python and are the only ones written to fallback.log.
    let gateway = Gateway::new(
        config.routes.clone(),
        RequestIdFilter::new(api),
        &config.python_upstream,
    )?;
    serve_gateway(config, gateway, shutdown).await
}

async fn serve_gateway<S: RustApi, F: Future<Output = ()>>(
    config: HybridConfig,
    gateway: Gateway<S>,
    shutdown: F,
) -> Result<(), BoxError> {
    // Apply CORS to the public boundary for both ordinary and caller-supplied
    // gateways, before any cutover or recording admission can run.
    let gateway = gateway.with_cors(gateway_cors())?;
    let listener = bind(config.listen_address).await?;

    info!(
        listen = %listener.local_addr()?,
        python_upstream = %config.python_upstream,
        rust_routes = config.routes.len(),
        "Wegent migration gateway started"
    );

    serve(listener, gateway, shutdown, config.shutdown_grace).await?;
    Ok(())
}

/// Serves a macro-exported application behind the hybrid gateway.
///
/// The Breeze router listens only on an ephemeral loopback address. The public
/// listener sends configured Rust routes to it and forwards every other route
/// directly to Python.
///
/// # Errors
///
/// Returns an error when either listener cannot bind or serve, or when an
/// internal origin URL cannot be constructed.
pub async fn serve_hybrid_application<F>(
    config: HybridConfig,
    application: Application,
    shutdown: F,
) -> Result<(), BoxError>
where
    F: Future<Output = ()>,
{
    serve_hybrid_application_with_gateway(config, application, shutdown, |config, api| {
        Ok(Gateway::new(
            config.routes.clone(),
            api,
            &config.python_upstream,
        )?)
    })
    .await
}

/// Serves an application using a caller-supplied gateway assembly.
///
/// The caller controls dispatch while sharing application authentication,
/// the loopback API listener and graceful shutdown with the default runtime.
///
/// # Errors
/// Returns gateway construction, listener binding and serving errors.
pub async fn serve_hybrid_application_with_gateway<S, F, G>(
    config: HybridConfig,
    application: Application,
    shutdown: F,
    build_gateway: G,
) -> Result<(), BoxError>
where
    S: RustApi,
    F: Future<Output = ()>,
    G: FnOnce(&HybridConfig, RequestIdFilter<OriginService>) -> Result<Gateway<S>, BoxError>,
{
    serve_hybrid_application_with_services(config, application, shutdown, |config, _state, api| {
        build_gateway(config, api)
    })
    .await
}

/// Serves an application using a caller-supplied gateway that also receives the
/// application state.
///
/// The builder receives the same [`crate::state::AppState`] used by the HTTP
/// and Socket.IO handlers. Protocol upgrades belong to the loopback HTTP
/// listener; a gateway only forwards the selected origin's connection.
///
/// # Errors
/// Returns gateway construction, listener binding and serving errors.
pub async fn serve_hybrid_application_with_services<S, F, G>(
    config: HybridConfig,
    application: Application,
    shutdown: F,
    build_gateway: G,
) -> Result<(), BoxError>
where
    S: RustApi,
    F: Future<Output = ()>,
    G: FnOnce(
        &HybridConfig,
        Arc<crate::state::AppState>,
        RequestIdFilter<OriginService>,
    ) -> Result<Gateway<S>, BoxError>,
{
    let Application {
        state,
        routes,
        background_jobs,
    } = application;
    let job_client = state.background_jobs.clone();
    let job_grace = job_client.configuration().shutdown_grace;
    let authenticator = crate::auth::AppAuthenticator::new(state.authentication_services());
    let socketio = crate::socketio::handlers::build(Arc::clone(&state)).await?;
    let http = brz_http_server::hyper::HandlerService::with_authenticator(
        crate::http_fallback::FastApiFallback::new(routes),
        authenticator,
        server_config(),
    )?;
    let api_service = brz_http_server::hyper::Mount::new(
        socketio.config().path.clone(),
        // Engine.IO owns this mount's CORS policy: its HTTP responses reflect
        // the Origin without the FastAPI boundary's expose/Vary headers, and a
        // successful protocol switch keeps only the handshake headers.
        crate::socketio::upgrade::CorsOptOut::new(socketio.service()),
        http,
    )?;
    let api_listener =
        tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
    let api_address = api_listener.local_addr()?;
    let api_origin: Uri = format!("http://{api_address}").parse()?;
    let api = OriginService::new(&api_origin)?.with_response_cors();
    let (stop_servers, mut api_stopped) = tokio::sync::watch::channel(false);

    info!(listen = %api_address, "Wegent exported Rust APIs started");

    let api_server = brz_http_server::hyper::serve(
        api_listener,
        move |_| api_service.clone(),
        async {
            let _ = api_stopped.wait_for(|stopped| *stopped).await;
            if let Err(error) = socketio.close().await {
                tracing::error!(%error, "Socket.IO namespace shutdown failed");
            }
        },
        origin_runtime_config(config.shutdown_grace),
    );
    let gateway = build_gateway(&config, Arc::clone(&state), RequestIdFilter::new(api))?
        .with_cors(gateway_cors())?;
    // Bind both listeners before any opted-in background work can cause side effects.
    let listener = bind(config.listen_address).await?;
    info!(
        listen = %listener.local_addr()?,
        python_upstream = %config.python_upstream,
        rust_routes = config.routes.len(),
        "Wegent migration gateway started"
    );
    let mut jobs =
        crate::background_jobs::BackgroundJobsRuntime::start(background_jobs, &job_client).await?;
    let stop_jobs = jobs.stop_sender();
    let gateway_stop = stop_servers.clone();
    let mut gateway_stopped = stop_servers.subscribe();
    let external_stop_jobs = stop_jobs.clone();
    let shutdown = async move {
        tokio::select! {
            () = shutdown => {}
            _ = gateway_stopped.wait_for(|stopped| *stopped) => {}
        }
        let _ = gateway_stop.send(true);
        let _ = external_stop_jobs.send(true);
    };
    let gateway = serve(listener, gateway, shutdown, config.shutdown_grace);
    tokio::pin!(api_server);
    tokio::pin!(gateway);

    let result: Result<(), BoxError> = async {
        tokio::select! {
            gateway_result = &mut gateway => {
                let _ = stop_servers.send(true);
                let _ = stop_jobs.send(true);
                let api_result = api_server.await;
                gateway_result?;
                api_result?;
                Ok(())
            }
            api_result = &mut api_server => {
                let _ = stop_servers.send(true);
                let _ = stop_jobs.send(true);
                let _ = gateway.await;
                api_result?;
                Err(std::io::Error::other("exported Rust API listener stopped unexpectedly").into())
            }
            error = jobs.failed() => {
                let _ = stop_servers.send(true);
                let _ = stop_jobs.send(true);
                let _ = tokio::join!(&mut api_server, &mut gateway);
                Err(error.into())
            }
        }
    }
    .await;
    let shutdown_result = jobs.shutdown(job_grace).await;
    socketio.close().await?;
    result?;
    shutdown_result?;
    Ok(())
}

/// Runs the hybrid Backend until the process receives an interrupt or terminate
/// signal.
///
/// # Errors
///
/// Returns the same listener, upstream configuration, and serving errors as
/// [`serve_hybrid_application`].
pub async fn run_hybrid(config: HybridConfig, application: Application) -> Result<(), BoxError> {
    Box::pin(serve_hybrid_application(
        config,
        application,
        shutdown_signal(),
    ))
    .await
}

/// Runs a caller-supplied gateway until an interrupt or terminate signal.
///
/// # Errors
/// Returns the errors from [`serve_hybrid_application_with_gateway`].
pub async fn run_hybrid_with_gateway<S, G>(
    config: HybridConfig,
    application: Application,
    build_gateway: G,
) -> Result<(), BoxError>
where
    S: RustApi,
    G: FnOnce(&HybridConfig, RequestIdFilter<OriginService>) -> Result<Gateway<S>, BoxError>,
{
    Box::pin(serve_hybrid_application_with_gateway(
        config,
        application,
        shutdown_signal(),
        build_gateway,
    ))
    .await
}

/// Runs a caller-supplied state-aware gateway until a signal arrives.
///
/// # Errors
/// Returns the errors from [`serve_hybrid_application_with_services`].
pub async fn run_hybrid_with_services<S, G>(
    config: HybridConfig,
    application: Application,
    build_gateway: G,
) -> Result<(), BoxError>
where
    S: RustApi,
    G: FnOnce(
        &HybridConfig,
        Arc<crate::state::AppState>,
        RequestIdFilter<OriginService>,
    ) -> Result<Gateway<S>, BoxError>,
{
    Box::pin(serve_hybrid_application_with_services(
        config,
        application,
        shutdown_signal(),
        build_gateway,
    ))
    .await
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};

        let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                result.expect("install Ctrl+C handler");
            }
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c()
        .await
        .expect("install Ctrl+C handler");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_config_preserves_empty_route_fallback() {
        let routes = RouteTable::empty();
        let config = HybridConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            "http://127.0.0.1:8004".parse().unwrap(),
            routes,
        );

        assert!(config.routes.is_empty());
        assert_eq!(config.listen_address.port(), 0);
        assert_eq!(config.shutdown_grace, DEFAULT_SHUTDOWN_GRACE);
    }
}
