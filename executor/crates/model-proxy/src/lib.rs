//! Local model routing, protocol translation, and capability-scoped model contexts.
use wegent_protocol as protocol;
use wegent_runtime_config as config;
use wegent_runtime_logging as logging;
mod error;
pub use error::HttpError;
pub mod codex_model_catalog;
mod codex_responses_proxy_transform;
pub mod harness_context;
pub mod local_decision_proxy;
pub mod local_model_proxy;
