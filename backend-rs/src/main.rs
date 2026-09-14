use std::env;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::time::Duration;

use http::Uri;
use tracing::info;
use tracing_subscriber::EnvFilter;
use wegent_backend_rs::{Gateway, NoRustApi, RouteTable, RoutesConfig};

const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 8000;
const DEFAULT_PYTHON_UPSTREAM: &str = "http://127.0.0.1:8004";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let address = listen_address()?;
    let python_upstream: Uri = env::var("WEGENT_PYTHON_UPSTREAM_URL")
        .unwrap_or_else(|_| DEFAULT_PYTHON_UPSTREAM.to_owned())
        .parse()?;
    let routes = load_routes()?;
    let gateway = Gateway::new(routes, NoRustApi, &python_upstream)?;
    let listener = wegent_backend_rs::bind(address).await?;

    info!(
        listen = %listener.local_addr()?,
        python_upstream = %python_upstream,
        rust_routes = gateway.routes().len(),
        "Wegent migration gateway started"
    );

    wegent_backend_rs::serve(
        listener,
        gateway,
        shutdown_signal(),
        Duration::from_secs(10),
    )
    .await?;
    Ok(())
}

fn listen_address() -> Result<SocketAddr, Box<dyn std::error::Error>> {
    let host: IpAddr = env::var("WEGENT_RS_LISTEN_HOST")
        .unwrap_or_else(|_| DEFAULT_HOST.to_owned())
        .parse()?;
    let port = env::var("WEGENT_RS_LISTEN_PORT").map_or(Ok(DEFAULT_PORT), |port| port.parse())?;
    Ok(SocketAddr::new(host, port))
}

fn load_routes() -> Result<RouteTable, Box<dyn std::error::Error>> {
    let Some(path) = env::var_os("WEGENT_RS_ROUTES_FILE") else {
        return Ok(RouteTable::empty());
    };
    let config = RoutesConfig::load(Path::new(&path))?;
    Ok(RouteTable::compile(config)?)
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
