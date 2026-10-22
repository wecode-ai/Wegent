// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The shared SSRF guard behind `app.services.url_metadata`
//! (`_validate_url_for_ssrf`, `_is_host_blocked`, `_is_ip_blocked`) and
//! `app.services.web_scraper.security` (`WebScraperUrlGuard`), which imports
//! the same helper before any scrape strategy runs.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Cloud metadata endpoints that are always blocked (source `BLOCKED_HOSTS`).
const BLOCKED_HOSTS: [&str; 3] = [
    "169.254.169.254",
    "metadata.google.internal",
    "metadata.gcp.internal",
];

/// IPv4 networks blocked for SSRF protection (source `BLOCKED_IP_NETWORKS`):
/// the three RFC1918 private ranges, loopback, link-local, RFC6598 shared
/// space, and the unspecified range, each as `(network, prefix length)`.
const BLOCKED_IPV4: [(u32, u32); 7] = [
    (0x0a00_0000, 8),  // RFC1918 private
    (0xac10_0000, 12), // RFC1918 private
    (0xc0a8_0000, 16), // RFC1918 private
    (0x7f00_0000, 8),  // loopback
    (0xa9fe_0000, 16), // link-local
    (0x6440_0000, 10), // RFC6598 shared address space
    (0x0000_0000, 8),  // unspecified
];

/// IPv6 networks blocked for SSRF protection: link-local and unique-local,
/// each as `(network, prefix length)`.
const BLOCKED_IPV6: [(u128, u32); 2] = [
    (0xfe80_0000_0000_0000_0000_0000_0000_0000, 10), // fe80::/10
    (0xfc00_0000_0000_0000_0000_0000_0000_0000, 7),  // fc00::/7
];

/// `_validate_url_for_ssrf`: only `http`/`https`, and the host must not be a
/// blocked hostname or resolve to a blocked IP.
pub(crate) async fn validate_url_for_ssrf(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = parsed.host() else {
        return false;
    };
    match host {
        url::Host::Ipv4(address) => !is_ip_blocked(IpAddr::V4(address)),
        url::Host::Ipv6(address) => !is_ip_blocked(IpAddr::V6(address)),
        url::Host::Domain(name) => !is_host_blocked(name).await,
    }
}

/// `_is_host_blocked`: known metadata hostnames, then every resolved IP.
async fn is_host_blocked(host: &str) -> bool {
    let host_lower = host.to_ascii_lowercase();
    for blocked in BLOCKED_HOSTS {
        if host_lower == blocked || host_lower.ends_with(&format!(".{blocked}")) {
            return true;
        }
    }
    match tokio::net::lookup_host((host, 0)).await {
        Ok(addresses) => addresses.map(|address| address.ip()).any(is_ip_blocked),
        // A resolution failure is treated as blocked, like `socket.gaierror`.
        Err(error) => {
            tracing::warn!(%error, host, "DNS resolution failed for URL metadata host");
            true
        }
    }
}

/// `_is_ip_blocked`: membership in any blocked network. IPv4-mapped IPv6
/// addresses match `::ffff:0:0/96` and are blocked.
fn is_ip_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => is_blocked_ipv4(address),
        IpAddr::V6(address) => is_blocked_ipv6(address),
    }
}

fn is_blocked_ipv4(address: Ipv4Addr) -> bool {
    let value = u32::from(address);
    BLOCKED_IPV4
        .into_iter()
        .any(|(network, prefix)| value >> (32 - prefix) == network >> (32 - prefix))
}

fn is_blocked_ipv6(address: Ipv6Addr) -> bool {
    if address.to_ipv4_mapped().is_some() {
        // ::ffff:0:0/96
        return true;
    }
    if address.is_loopback() || address.is_unspecified() {
        // ::1/128 and ::/128
        return true;
    }
    let value = u128::from(address);
    BLOCKED_IPV6
        .into_iter()
        .any(|(network, prefix)| value >> (128 - prefix) == network >> (128 - prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ip_networks_are_blocked() {
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(172, 31, 255, 255))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_ip_blocked(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(is_ip_blocked(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_ip_blocked("fe80::1".parse().unwrap()));
        assert!(is_ip_blocked("fc00::1".parse().unwrap()));
        assert!(is_ip_blocked(IpAddr::V6(
            Ipv4Addr::new(10, 1, 2, 3).to_ipv6_mapped()
        )));
        // The recorder's fake DNS range, public IPs, and the RFC1918 holes
        // outside the /8 and /12 prefixes are not blocked.
        assert!(!is_ip_blocked(IpAddr::V4(Ipv4Addr::new(198, 19, 3, 136))));
        assert!(!is_ip_blocked(IpAddr::V4(Ipv4Addr::new(106, 11, 35, 100))));
        assert!(!is_ip_blocked(IpAddr::V4(Ipv4Addr::new(172, 32, 0, 1))));
        assert!(!is_ip_blocked(IpAddr::V4(Ipv4Addr::new(100, 63, 0, 1))));
    }
}
