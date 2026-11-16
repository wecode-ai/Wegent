//! MCP configuration, deferred-tool protocol, context rebinding, and diagnostics.
#![forbid(unsafe_code)]
use wegent_protocol as protocol;
use wegent_runtime_logging as logging;
pub mod interactive_mcp;
pub mod mcp_environment;
pub mod mcp_utils;
pub mod toml_encoding;
