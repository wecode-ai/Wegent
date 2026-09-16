use std::sync::Arc;

use brz_http::Endpoint;
use wegent_backend_rs::AppState;

use super::aigc;

/// Process-wide state owned by the Wecode Backend application.
///
/// It reuses the public [`AppState`] for the general-purpose dependencies
/// (JWT configuration and the MySQL pool) and adds only the internal adapters
/// this application owns.
pub(crate) struct WecodeAppState {
    public: Arc<AppState>,
    aigc_quota_endpoint: Endpoint,
}

impl WecodeAppState {
    /// Builds the state from the source-compatible environment.
    ///
    /// # Errors
    ///
    /// Returns an error when the public state cannot be built (missing or
    /// malformed `DATABASE_URL`) or the AIGC quota endpoint URL is invalid.
    pub(crate) fn from_env() -> Result<Self, wegent_backend_rs::BoxError> {
        Ok(Self {
            public: Arc::new(AppState::from_env()?),
            aigc_quota_endpoint: aigc::build_endpoint(aigc::AIGC_QUOTA_URL)?,
        })
    }

    /// The public state every migrated route shares.
    pub(crate) fn public(&self) -> &Arc<AppState> {
        &self.public
    }

    /// The retained AIGC quota service endpoint.
    pub(crate) fn aigc_quota_endpoint(&self) -> &Endpoint {
        &self.aigc_quota_endpoint
    }
}
