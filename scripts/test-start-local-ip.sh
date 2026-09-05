#!/usr/bin/env bash
# Regression test for start.sh local IP selection when a VPN owns the default route.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
START_SH="$PROJECT_ROOT/start.sh"
FAKE_BIN="$(mktemp -d)"

cleanup() {
    rm -rf "$FAKE_BIN"
}
trap cleanup EXIT

extract_function() {
    local function_name="$1"

    awk -v function_name="$function_name" '
        $0 ~ "^" function_name "\\(\\) \\{" {
            in_function = 1
            depth = 1
            print
            next
        }
        in_function {
            print
            opens = gsub(/\{/, "{")
            closes = gsub(/\}/, "}")
            depth += opens - closes
            if (depth == 0) {
                exit
            }
        }
    ' "$START_SH"
}

printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "   interface: utun5"' > "$FAKE_BIN/route"
printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "${1:-}" in' \
    '  utun5) printf "%s\n" "utun5: flags=8051" "    inet 10.111.222.0 --> 10.111.222.0 netmask 0xffffffff" ;;' \
    '  en0) printf "%s\n" "en0: flags=8863" "    inet 192.168.31.44 netmask 0xffffff00 broadcast 192.168.31.255" ;;' \
    'esac' > "$FAKE_BIN/ifconfig"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$FAKE_BIN/hostname"
chmod +x "$FAKE_BIN/route" "$FAKE_BIN/ifconfig" "$FAKE_BIN/hostname"

is_virtual_network_interface_body="$(extract_function is_virtual_network_interface)"
get_local_ip_body="$(extract_function get_local_ip)"

actual_ip="$({
    eval "$is_virtual_network_interface_body"
    eval "$get_local_ip_body"
    PATH="$FAKE_BIN:/usr/bin:/bin" get_local_ip
})"

if [ "$actual_ip" != "192.168.31.44" ]; then
    echo "Expected the physical en0 address when utun5 owns the default route."
    echo "Actual address: $actual_ip"
    exit 1
fi

echo "start.sh local IP VPN regression test passed"
