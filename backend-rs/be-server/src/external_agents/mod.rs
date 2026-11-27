// SPDX-License-Identifier: Apache-2.0

mod hook;
mod protocol;
mod queue;
mod registration;
pub(crate) mod socket;

use brz_http_server::StatusCode;
use brz_mysql::MysqlError;
use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::http_compat::FastApiError;

pub(crate) use queue::{DELIVERY_JOB, enqueue, register_jobs};

const AGENT_KIND: &str = "external_agent";
const INVOCATION_KIND: &str = "external_invocation";

fn invalid(message: impl Into<String>) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message)
}

fn database(error: MysqlError) -> FastApiError {
    tracing::error!(%error, "External agent persistence failed");
    FastApiError::internal()
}

fn mac(key: &str, purpose: &str, parts: &[&str]) -> Hmac<Sha256> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts any key length");
    mac.update(purpose.as_bytes());
    for part in parts {
        mac.update(&[0]);
        mac.update(part.as_bytes());
    }
    mac
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn verify(mac: Hmac<Sha256>, signature: &str) -> bool {
    if signature.len() != 64 || !signature.is_ascii() {
        return false;
    }
    let decoded: Result<Vec<u8>, _> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&signature[i..i + 2], 16))
        .collect();
    decoded.is_ok_and(|bytes| mac.verify_slice(&bytes).is_ok())
}
