#!/usr/bin/env bash
set -euo pipefail

# Only the disposable CI network namespace receives this route and CA. A public
# address is necessary to exercise the production HTTPS/SSRF download policy;
# do not add a production allowlist or bypass certificate/host validation.
test "${CI:-}" = true
test -f /.dockerenv
test -n "${GITHUB_ENV:-}"
apt-get update -qq
apt-get install --yes --no-install-recommends iproute2 ca-certificates openssl
ip addr add 11.255.255.254/32 dev lo
tls_dir="$(mktemp -d /tmp/wegent-dingtalk-tls.XXXXXX)"
chmod 700 "$tls_dir"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=wegent-dingtalk-e2e \
  -addext subjectAltName=IP:11.255.255.254 \
  -keyout "$tls_dir/key.pem" -out "$tls_dir/cert.pem" 2>/dev/null
cp "$tls_dir/cert.pem" /usr/local/share/ca-certificates/wegent-dingtalk-e2e.crt
update-ca-certificates
{
  echo "DINGTALK_E2E_DOWNLOAD_ORIGIN=https://11.255.255.254:10443"
  echo "DINGTALK_E2E_TLS_CERT=$tls_dir/cert.pem"
  echo "DINGTALK_E2E_TLS_KEY=$tls_dir/key.pem"
  echo "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
} >> "$GITHUB_ENV"
