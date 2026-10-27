use std::fmt::{Display, Formatter, Result as FmtResult};

/// An `Event` in `socket.io` could either (`Message`, `Error`) or custom.
#[derive(Debug, PartialEq, PartialOrd, Clone, Eq, Hash)]
pub enum Event {
    Message,
    Error,
    Custom(String),
    Connect,
    Close,
}

impl Event {
    pub fn as_str(&self) -> &str {
        match self {
            Event::Message => "message",
            Event::Error => "error",
            Event::Connect => "connect",
            Event::Close => "close",
            Event::Custom(string) => string,
        }
    }
}

impl From<String> for Event {
    fn from(string: String) -> Self {
        match &string.to_lowercase()[..] {
            "message" => Event::Message,
            "error" => Event::Error,
            "open" => Event::Connect,
            "close" => Event::Close,
            _ => Event::Custom(string),
        }
    }
}

impl From<&str> for Event {
    fn from(string: &str) -> Self {
        Event::from(String::from(string))
    }
}

impl From<Event> for String {
    fn from(event: Event) -> Self {
        match event {
            Event::Message => Self::from("message"),
            Event::Connect => Self::from("open"),
            Event::Close => Self::from("close"),
            Event::Error => Self::from("error"),
            Event::Custom(string) => string,
        }
    }
}

impl Display for Event {
    fn fmt(&self, f: &mut Formatter<'_>) -> FmtResult {
        f.write_str(self.as_str())
    }
}

/// A `CloseReason` is the payload of the [`Event::Close`] and specifies the reason for
/// why it was fired.
/// These are aligned with the official Socket.IO disconnect reasons, see
/// https://socket.io/docs/v4/client-socket-instance/#disconnect
#[derive(Debug, PartialEq, PartialOrd, Clone, Eq, Hash)]
pub enum CloseReason {
    IOServerDisconnect,
    IOClientDisconnect,
    TransportClose,
}

impl CloseReason {
    pub fn as_str(&self) -> &str {
        match self {
            // Inspired by https://github.com/socketio/socket.io/blob/d0fc72042068e7eaef448941add617f05e1ec236/packages/socket.io-client/lib/socket.ts#L865
            CloseReason::IOServerDisconnect => "io server disconnect",
            // Inspired by https://github.com/socketio/socket.io/blob/d0fc72042068e7eaef448941add617f05e1ec236/packages/socket.io-client/lib/socket.ts#L911
            CloseReason::IOClientDisconnect => "io client disconnect",
            CloseReason::TransportClose => "transport close",
        }
    }
}

impl From<CloseReason> for String {
    fn from(event: CloseReason) -> Self {
        Self::from(event.as_str())
    }
}

impl Display for CloseReason {
    fn fmt(&self, f: &mut Formatter<'_>) -> FmtResult {
        f.write_str(self.as_str())
    }
}
