use std::env;
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::time::Duration;

use http::Uri;
use tracing::info;

use crate::{
    Application, BoxError, Gateway, OriginService, RouteTable, RoutesConfig, RustApi, bind, serve,
};

const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 8000;
const DEFAULT_PYTHON_UPSTREAM: &str = "http://127.0.0.1:8004";
const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

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
        let host: IpAddr = env::var("WEGENT_RS_LISTEN_HOST")
            .unwrap_or_else(|_| DEFAULT_HOST.to_owned())
            .parse()?;
        let port =
            env::var("WEGENT_RS_LISTEN_PORT").map_or(Ok(DEFAULT_PORT), |port| port.parse())?;
        let python_upstream = env::var("WEGENT_PYTHON_UPSTREAM_URL")
            .unwrap_or_else(|_| DEFAULT_PYTHON_UPSTREAM.to_owned())
            .parse()?;
        let routes = match env::var_os("WEGENT_RS_ROUTES_FILE") {
            Some(path) => RouteTable::compile(RoutesConfig::load(Path::new(&path))?)?,
            None => RouteTable::empty(),
        };
        Ok(Self {
            listen_address: SocketAddr::new(host, port),
            python_upstream,
            routes,
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
    let gateway = Gateway::new(config.routes, api, &config.python_upstream)?;
    let listener = bind(config.listen_address).await?;

    info!(
        listen = %listener.local_addr()?,
        python_upstream = %config.python_upstream,
        rust_routes = gateway.routes().len(),
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
    let Application {
        state: _state,
        routes,
    } = application;
    let api_server =
        brz_http_server::Server::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)), routes).await?;
    let api_address = api_server.local_addr()?;
    let api_origin: Uri = format!("http://{api_address}").parse()?;
    let api = OriginService::new(&api_origin)?;
    let (api_shutdown, wait_for_api_shutdown) = tokio::sync::oneshot::channel();

    info!(listen = %api_address, "Wegent exported Rust APIs started");

    let api_server = api_server.serve_until(async move {
        let _ = wait_for_api_shutdown.await;
    });
    let gateway = serve_hybrid(config, api, shutdown);
    tokio::pin!(api_server);
    tokio::pin!(gateway);

    tokio::select! {
        gateway_result = &mut gateway => {
            let _ = api_shutdown.send(());
            let api_result = api_server.await;
            gateway_result?;
            api_result?;
            Ok(())
        }
        api_result = &mut api_server => {
            api_result?;
            Err(std::io::Error::other("exported Rust API listener stopped unexpectedly").into())
        }
    }
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
