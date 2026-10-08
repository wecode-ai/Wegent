// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Model Context Protocol (MCP) streamable-HTTP endpoints.
//!
//! The Wegent backend mounts one FastMCP server per MCP feature under
//! `/api/mcp/<name>/sse` (`app/mcp_server/server.py`). Each mount serves the
//! MCP streamable-HTTP transport in stateless mode: `GET` for the
//! server-to-client SSE stream, `POST` for JSON-RPC messages, and `DELETE` for
//! explicit session termination (not used in stateless mode). This module owns
//! the shared transport framing and the per-server JSON-RPC behavior.

mod knowledge;
mod protocol;
mod subscription;
mod transport;
