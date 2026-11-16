use base64::DecodeError;
use serde_json::Error as JsonError;
use std::io::Error as IoError;
use std::num::ParseIntError;
use std::str::Utf8Error;
use thiserror::Error;
use url::ParseError as UrlParseError;

/// Enumeration of all possible errors in the `socket.io` context.
/// TODO: 0.4.X Do not expose non-trivial internal errors. Convert error to string.
#[derive(Error, Debug)]
#[non_exhaustive]
#[cfg_attr(tarpaulin, ignore)]
pub enum Error {
    #[error("Socket.IO acknowledgement IDs exhausted")]
    AckIdExhausted,
    // Conform to https://rust-lang.github.io/api-guidelines/naming.html#names-use-a-consistent-word-order-c-word-order
    // Negative verb-object
    #[error("Invalid packet id: {0}")]
    InvalidPacketId(char),
    #[error("Error while parsing an incomplete packet")]
    IncompletePacket(),
    #[error("Got an invalid packet which did not follow the protocol format")]
    InvalidPacket(),
    #[error("An error occurred while decoding the utf-8 text: {0}")]
    InvalidUtf8(#[from] Utf8Error),
    #[error("An error occurred while encoding/decoding base64: {0}")]
    InvalidBase64(#[from] DecodeError),
    #[error("Invalid Url during parsing")]
    InvalidUrl(#[from] UrlParseError),
    #[error("Invalid Url Scheme: {0}")]
    InvalidUrlScheme(String),
    #[error("Got illegal handshake response: {0}")]
    InvalidHandshake(String),
    #[error("Called an action before the connection was established")]
    IllegalActionBeforeOpen(),
    #[error("string is not json serializable: {0}")]
    InvalidJson(#[from] JsonError),
    #[error("A lock was poisoned")]
    InvalidPoisonedLock(),
    #[error("Got an IO-Error: {0}")]
    IncompleteIo(#[from] IoError),
    #[error("Error while parsing an integer")]
    InvalidInteger(#[from] ParseIntError),
    #[error("EngineIO Error")]
    IncompleteResponseFromEngineIo(#[from] tf_rust_engineio::Error),
    #[error("Invalid packet type while reading attachments")]
    InvalidAttachmentPacketType(u8),
    #[error("Underlying Engine.IO connection has closed")]
    StoppedEngineIoSocket,
}

pub(crate) type Result<T> = std::result::Result<T, Error>;

impl<T> From<std::sync::PoisonError<T>> for Error {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        Self::InvalidPoisonedLock()
    }
}

impl From<Error> for std::io::Error {
    fn from(err: Error) -> std::io::Error {
        std::io::Error::other(err)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, PoisonError};

    use super::*;

    /// This just tests the own implementations and relies on `thiserror` for the others.
    #[test]
    fn test_error_conversion() {
        let mutex = Mutex::new(0);
        let _error = Error::from(PoisonError::new(mutex.lock()));
        assert!(matches!(Error::InvalidPoisonedLock(), _error));

        let _io_error = std::io::Error::from(Error::IncompletePacket());
        let _error = std::io::Error::new(std::io::ErrorKind::Other, Error::IncompletePacket());
        assert!(matches!(_io_error, _error));
    }
}
