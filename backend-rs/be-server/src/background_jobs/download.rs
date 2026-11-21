// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Public attachment/upstream downloads use the source's stricter IP policy.

use anyhow::{Result, bail};
use std::{net::IpAddr, time::Duration};

pub async fn get(raw: &str, maximum: usize, redirects: usize) -> Result<Vec<u8>> {
    get_with_headers(raw, maximum, redirects, None).await
}
pub async fn get_with_headers(
    raw: &str,
    maximum: usize,
    redirects: usize,
    headers: Option<&serde_json::Value>,
) -> Result<Vec<u8>> {
    let mut current =
        url::Url::parse(raw).map_err(|_| anyhow::anyhow!("Invalid public download URL"))?;
    for hop in 0..=redirects {
        if current.scheme() != "https"
            || !current.username().is_empty()
            || current.password().is_some()
        {
            bail!("Download URL must use HTTPS without credentials")
        }
        let host = current
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("Download URL has no host"))?;
        if host.eq_ignore_ascii_case("localhost")
            || host.ends_with(".localhost")
            || host.eq_ignore_ascii_case("metadata.google.internal")
        {
            bail!("Download host is not public")
        }
        let port = current.port_or_known_default().unwrap_or(443);
        let addresses = match current.host().expect("host checked") {
            url::Host::Ipv4(ip) => vec![std::net::SocketAddr::new(IpAddr::V4(ip), port)],
            url::Host::Ipv6(ip) => vec![std::net::SocketAddr::new(IpAddr::V6(ip), port)],
            url::Host::Domain(_) => tokio::net::lookup_host((host, port))
                .await
                .map_err(|_| anyhow::anyhow!("Download host could not be resolved"))?
                .collect::<Vec<_>>(),
        };
        if addresses.is_empty() || addresses.iter().any(|address| !public(address.ip())) {
            bail!("Download host is not public")
        }
        let http = brz_http::Client::builder()
            .connect_timeout(Duration::from_secs(60))
            .read_timeout(Duration::from_secs(60))
            .configure(|builder| {
                builder
                    .redirect(brz_http::reqwest::redirect::Policy::none())
                    .resolve_to_addrs(host, &addresses)
            })
            .build()?;
        let mut request = http.as_reqwest().get(current.clone());
        if let Some(headers) = headers.filter(|value| !value.is_null()) {
            for (name, value) in headers
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("Invalid public download headers"))?
            {
                request = request.header(
                    name,
                    value
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("Invalid public download headers"))?,
                );
            }
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Public download request failed"))?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            if hop == redirects {
                bail!("Too many download redirects")
            }
            current = current
                .join(
                    response
                        .headers()
                        .get("location")
                        .and_then(|v| v.to_str().ok())
                        .ok_or_else(|| anyhow::anyhow!("Download redirect has no location"))?,
                )
                .map_err(|_| anyhow::anyhow!("Invalid download redirect"))?;
            continue;
        }
        if !response.status().is_success() {
            bail!(
                "Public download returned HTTP {}",
                response.status().as_u16()
            )
        }
        return super::knowledge::sources::bounded_body(response, maximum).await;
    }
    unreachable!("bounded redirects")
}

fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let value = u32::from(ip);
            if [0xc0000009, 0xc000000a].contains(&value) {
                return true;
            }
            let blocked = [
                (0x00000000, 8),
                (0x0a000000, 8),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0xac100000, 12),
                (0xc0000000, 24),
                (0xc0000200, 24),
                (0xc0a80000, 16),
                (0xc6120000, 15),
                (0xc6336400, 24),
                (0xcb007100, 24),
                (0xe0000000, 4),
                (0xf0000000, 4),
            ];
            !blocked
                .into_iter()
                .any(|(network, bits)| value >> (32 - bits) == network >> (32 - bits))
        }
        IpAddr::V6(ip) => {
            if ip.to_ipv4_mapped().is_some() {
                return false;
            }
            let value = u128::from(ip);
            // ipaddress.is_reserved rejects everything outside the IPv6 global
            // unicast allocation; its private/documentation ranges are inside it.
            value >> 125 == 1
                && ![
                    (0x20010000000000000000000000000000_u128, 23),
                    (0x20010db8000000000000000000000000, 32),
                    (0x20020000000000000000000000000000, 16),
                    (0x3fff0000000000000000000000000000, 20),
                ]
                .into_iter()
                .any(|(network, bits)| value >> (128 - bits) == network >> (128 - bits))
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plugin_download_blocks_reserved_benchmark_and_documentation_ranges() {
        for raw in [
            "127.0.0.1",
            "198.18.0.1",
            "192.0.2.1",
            "203.0.113.1",
            "224.0.0.1",
            "::1",
            "2001:db8::1",
        ] {
            assert!(!public(raw.parse().unwrap()), "{raw}");
        }
        assert!(public("8.8.8.8".parse().unwrap()));
        assert!(public("2606:4700:4700::1111".parse().unwrap()));
    }
}
