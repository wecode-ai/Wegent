//! Claude stream interpretation, native session resume, and process execution.
use wegent_execution_contracts::emitter;
mod runner {
    pub use wegent_execution_contracts::{AgentEngine, EventSink, ExecutionOutcome};
    pub use wegent_execution_stream as streaming;
}
#[cfg(test)]
use wegent_executor_test_support as test_env;
use wegent_mcp_runtime::interactive_mcp;
use wegent_native_home::agent_session;
use wegent_protocol as protocol;
use wegent_runtime_logging as logging;
pub mod process;
pub mod stream;

/// Resolve fresh credentials and environment for every actual child spawn.
pub trait ChildEnvironment: std::fmt::Debug + Send + Sync {
    fn environment(&self, extra: &[(String, String)]) -> std::collections::HashMap<String, String>;
}
mod native_session {
    pub use wegent_native_home::instance_home::claude_session_transcript;
    pub fn has_isolated_native_home(request: &wegent_protocol::ExecutionRequest) -> bool {
        wegent_native_home::instance_home::request_home(request).is_some()
    }
}

pub mod claude_code;
pub mod claude_options;
use wegent_hooks as hooks;
use wegent_mcp_runtime::mcp_utils;
use wegent_multimodal::{attachments, prompt_enrichment};
use wegent_plugin_packages::local;
