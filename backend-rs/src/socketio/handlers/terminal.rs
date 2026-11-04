// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/terminal_namespace.py::TerminalNamespace._event_handlers`.

use super::placeholder;

placeholder!("/terminal", "terminal:attach", attach);
placeholder!("/terminal", "terminal:ack", ack);
placeholder!("/terminal", "terminal:input", input);
placeholder!("/terminal", "terminal:resize", resize);
placeholder!("/terminal", "terminal:close", close);
