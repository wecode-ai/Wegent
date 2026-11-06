// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! A minimal Engine.IO v4 long-polling Socket.IO client for local wire tests.
//!
//! It speaks only what the wire tests need: the polling handshake, one namespace
//! CONNECT with auth, ENGINE.IO pong replies, and background polling that keeps
//! the transport alive while tests observe delivery. It is compiled only from
//! `#[cfg(test)]` modules and adds no dependency.

use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// One Socket.IO EVENT packet received from the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EventPacket {
    pub namespace: String,
    /// The packet's first argument: the event name.
    pub event: String,
    /// The remaining positional arguments, as JSON.
    pub args: Vec<serde_json::Value>,
}

/// One polling client: an Engine.IO session plus its Socket.IO socket id.
pub(crate) struct PollClient {
    addr: String,
    engine_sid: String,
    socket_id: String,
}

impl PollClient {
    /// Handshake, then CONNECT `namespace` with `auth` (raw JSON), answering
    /// every ENGINE.IO ping received before the CONNECT acknowledgement.
    pub(crate) async fn connect(addr: &str, namespace: &str, auth: &str) -> io::Result<Self> {
        let (status, body) =
            request(addr, "GET", "/socket.io/?EIO=4&transport=polling", "").await?;
        if status != 200 {
            return Err(io::Error::other(format!("handshake status {status}")));
        }
        let engine_sid = open_sid(&body)?;
        let mut client = Self {
            addr: addr.to_owned(),
            engine_sid,
            socket_id: String::new(),
        };
        client.post(&format!("40{namespace},{auth}")).await?;
        // The CONNECT acknowledgement arrives in the next poll (a ping may come
        // first and must be answered).
        for _ in 0..20 {
            let packets = client.poll_packets().await?;
            if let Some(sid) = packets.iter().find_map(|packet| connect_ack(packet)) {
                client.socket_id = sid;
                return Ok(client);
            }
        }
        Err(io::Error::other("no CONNECT acknowledgement"))
    }

    /// The server-assigned Socket.IO socket id (the socket's default room).
    pub(crate) fn socket_id(&self) -> &str {
        &self.socket_id
    }

    /// One long poll, answering an ENGINE.IO ping with a pong; returns every
    /// Socket.IO EVENT packet in the response.
    async fn poll_events(&self) -> io::Result<Vec<EventPacket>> {
        let packets = self.poll_packets().await?;
        Ok(packets
            .iter()
            .filter_map(|packet| event_packet(packet))
            .collect())
    }

    /// One long poll, answering an ENGINE.IO ping with a pong.
    pub(crate) async fn poll_packets(&self) -> io::Result<Vec<String>> {
        let (status, body) = request(
            &self.addr,
            "GET",
            &format!(
                "/socket.io/?EIO=4&transport=polling&sid={}",
                self.engine_sid
            ),
            "",
        )
        .await?;
        if status != 200 {
            return Err(io::Error::other(format!("poll status {status}")));
        }
        let packets: Vec<String> = body.split('\u{1e}').map(str::to_owned).collect();
        if packets.iter().any(|packet| packet == "2") {
            self.post("3").await?;
        }
        Ok(packets)
    }

    pub(crate) async fn post(&self, body: &str) -> io::Result<()> {
        let (status, response) = request(
            &self.addr,
            "POST",
            &format!(
                "/socket.io/?EIO=4&transport=polling&sid={}",
                self.engine_sid
            ),
            body,
        )
        .await?;
        if status != 200 {
            return Err(io::Error::other(format!(
                "post status {status} body {response:?}"
            )));
        }
        Ok(())
    }

    /// Start background polling. The poller keeps the transport alive, answers
    /// pings, and records every EVENT it observes until [`Poller::stop`].
    pub(crate) fn into_poller(self) -> Poller {
        Poller {
            client: self,
            events: Arc::new(Mutex::new(Vec::new())),
            alive: Arc::new(AtomicBool::new(true)),
            stop: Arc::new(tokio::sync::Notify::new()),
        }
    }
}

/// A background polling loop over one client.
pub(crate) struct Poller {
    client: PollClient,
    events: Arc<Mutex<Vec<EventPacket>>>,
    alive: Arc<AtomicBool>,
    stop: Arc<tokio::sync::Notify>,
}

impl Poller {
    /// The socket id this poller's transport carries.
    pub(crate) fn socket_id(&self) -> &str {
        self.client.socket_id()
    }

    /// Run the poll loop until [`Poller::stop`]. Returns when the transport
    /// closes; `alive` records whether it was still open.
    pub(crate) async fn run(self: Arc<Self>) -> Arc<AtomicBool> {
        let alive = Arc::clone(&self.alive);
        loop {
            let outcome = tokio::select! {
                biased;
                () = self.stop.notified() => break,
                outcome = self.client.poll_events() => outcome,
            };
            match outcome {
                Ok(events) => {
                    if !events.is_empty() {
                        self.events.lock().unwrap().extend(events);
                    }
                }
                Err(_) => {
                    alive.store(false, Ordering::SeqCst);
                    break;
                }
            }
        }
        alive
    }

    /// Whether the transport is still open.
    pub(crate) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// The events observed so far.
    pub(crate) fn events(&self) -> Vec<EventPacket> {
        self.events.lock().unwrap().clone()
    }

    /// Wait for one new event after `seen` within `window`.
    pub(crate) async fn next_event(&self, seen: usize, window: Duration) -> Option<EventPacket> {
        let deadline = Instant::now() + window;
        loop {
            if let Some(event) = self.events.lock().unwrap().get(seen).cloned() {
                return Some(event);
            }
            if Instant::now() >= deadline || !self.is_alive() {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    pub(crate) fn stop(&self) {
        self.stop.notify_waiters();
    }
}

/// The Engine.IO OPEN payload's `sid`.
fn open_sid(body: &str) -> io::Result<String> {
    let open = body
        .split('\u{1e}')
        .find_map(|packet| packet.strip_prefix('0'))
        .ok_or_else(|| io::Error::other(format!("no OPEN packet in {body:?}")))?;
    let value: serde_json::Value = serde_json::from_str(open)
        .map_err(|error| io::Error::other(format!("OPEN payload: {error}")))?;
    value
        .get("sid")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| io::Error::other("OPEN payload has no sid"))
}

/// The Socket.IO CONNECT acknowledgement's socket id.
fn connect_ack(packet: &str) -> Option<String> {
    let rest = packet.strip_prefix("40")?;
    let json = rest.split_once(',').map_or(rest, |(_, json)| json);
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    value
        .get("sid")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

/// One `42<namespace>,<payload array>` event: `[0]` is the name, the rest are
/// the positional arguments.
fn event_packet(packet: &str) -> Option<EventPacket> {
    let rest = packet.strip_prefix("42")?;
    let (namespace, payload) = match rest.split_once(',') {
        Some((namespace, payload)) if namespace.starts_with('/') => (namespace.to_owned(), payload),
        _ => ("/".to_owned(), rest),
    };
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    let mut arguments = match value {
        serde_json::Value::Array(arguments) => arguments,
        value => vec![value],
    };
    if arguments.is_empty() {
        return None;
    }
    let name = arguments.remove(0);
    Some(EventPacket {
        namespace,
        event: name.as_str().unwrap_or_default().to_owned(),
        args: arguments,
    })
}

/// One HTTP/1.1 request against the local test server.
async fn request(addr: &str, method: &str, path: &str, body: &str) -> io::Result<(u16, String)> {
    let mut stream = TcpStream::connect(addr).await?;
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    parse_response(&response)
}

/// Split an HTTP/1.1 response into its status code and body.
fn parse_response(response: &[u8]) -> io::Result<(u16, String)> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| io::Error::other("response has no header terminator"))?;
    let head = String::from_utf8_lossy(&response[..header_end]);
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| io::Error::other(format!("bad status line {head:?}")))?;
    let body = String::from_utf8_lossy(&response[header_end + 4..]).into_owned();
    Ok((status, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packets_parse_the_event_name_and_arguments() {
        assert_eq!(
            open_sid("0{\"sid\":\"e-1\",\"upgrades\":[]}").expect("sid"),
            "e-1"
        );
        assert_eq!(
            connect_ack("40/chat,{\"sid\":\"s-1\"}").as_deref(),
            Some("s-1")
        );
        let event =
            event_packet("42/chat,[\"device:slot_update\",{\"a\":1},{\"b\":2}]").expect("event");
        assert_eq!(event.namespace, "/chat");
        assert_eq!(event.event, "device:slot_update");
        assert_eq!(
            event.args,
            vec![serde_json::json!({"a": 1}), serde_json::json!({"b": 2})]
        );
        // A frame with no arguments still carries its name.
        let event = event_packet("42[\"plain\"]").expect("event");
        assert_eq!(event.namespace, "/");
        assert_eq!(event.event, "plain");
        assert!(event.args.is_empty());
    }

    #[test]
    fn responses_split_at_the_header_terminator() {
        let (status, body) =
            parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").expect("response");
        assert_eq!(status, 200);
        assert_eq!(body, "ok");
    }
}
