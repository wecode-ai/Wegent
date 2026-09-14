use std::net::SocketAddr;
use std::sync::Arc;

use http::Request;
use hyper::body::Incoming;

use crate::{GatewayResponse, NoRustApi, RustApi};

/// Shared state owned by the public Rust Backend implementation.
///
/// The state is intentionally empty while no public API has been migrated. It
/// establishes the ownership boundary that future public handlers can extend;
/// private applications should retain this state instead of duplicating it.
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct AppState;

/// Public Rust API service selected by the hybrid gateway.
///
/// Until the first public route is implemented, matched requests are rejected
/// by the same placeholder used by the original gateway. With the default empty
/// route table, this service is never called and every request falls back to
/// Python.
#[derive(Clone, Debug)]
pub struct PublicApi {
    state: Arc<AppState>,
    delegate: NoRustApi,
}

impl PublicApi {
    #[must_use]
    pub fn new(state: Arc<AppState>) -> Self {
        Self {
            state,
            delegate: NoRustApi,
        }
    }

    /// Returns the process-wide public application state.
    #[must_use]
    pub fn state(&self) -> &Arc<AppState> {
        &self.state
    }
}

impl RustApi for PublicApi {
    async fn call(&self, request: Request<Incoming>, peer_addr: SocketAddr) -> GatewayResponse {
        self.delegate.call(request, peer_addr).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_api_clones_share_application_state() {
        let state = Arc::new(AppState);
        let api = PublicApi::new(Arc::clone(&state));
        let clone = api.clone();

        assert!(Arc::ptr_eq(api.state(), clone.state()));
        assert!(Arc::ptr_eq(api.state(), &state));
    }
}
