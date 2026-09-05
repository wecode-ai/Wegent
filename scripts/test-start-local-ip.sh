#!/usr/bin/env bash
# Regression tests for start.sh local IP selection when a VPN owns the default route.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
START_SH="$PROJECT_ROOT/start.sh"
FIXTURE_ROOT="$(mktemp -d)"

cleanup() {
    rm -rf "$FIXTURE_ROOT"
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

is_virtual_network_interface_body="$(extract_function is_virtual_network_interface)"
get_interface_ipv4_body="$(extract_function get_interface_ipv4)"
get_local_ip_body="$(extract_function get_local_ip)"

run_fixture() {
    local fixture_bin="$1"

    {
        eval "$is_virtual_network_interface_body"
        eval "$get_interface_ipv4_body"
        eval "$get_local_ip_body"
        PATH="$fixture_bin:/usr/bin:/bin" get_local_ip
    }
}

MACOS_BIN="$FIXTURE_ROOT/macos"
mkdir -p "$MACOS_BIN"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "   interface: utun5"' > "$MACOS_BIN/route"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$MACOS_BIN/ip"
printf '%s\n' \
    '#!/usr/bin/env bash' \
    'if [ "$#" -gt 0 ]; then exit 1; fi' \
    'printf "%s\n" "utun5: flags=8051" "    inet 10.111.222.0 --> 10.111.222.0 netmask 0xffffffff" "en0: flags=8863" "    inet 192.168.31.44 netmask 0xffffff00 broadcast 192.168.31.255"' > "$MACOS_BIN/ifconfig"
chmod +x "$MACOS_BIN/route" "$MACOS_BIN/ip" "$MACOS_BIN/ifconfig"

actual_ip="$(run_fixture "$MACOS_BIN")"

if [ "$actual_ip" != "192.168.31.44" ]; then
    echo "Expected the physical en0 address when utun5 owns the default route."
    echo "Actual address: $actual_ip"
    exit 1
fi

LINUX_BIN="$FIXTURE_ROOT/linux"
mkdir -p "$LINUX_BIN"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$LINUX_BIN/route"
printf '%s\n' \
    '#!/usr/bin/env bash' \
    'case "$*" in' \
    '  route) printf "%s\n" "default via 10.44.0.1 dev wg0 proto static" ;;' \
    '  "-o -4 addr show dev wg0 scope global") printf "%s\n" "9: wg0    inet 10.44.0.2/24 scope global wg0" ;;' \
    '  "-o -4 addr show scope global") printf "%s\n" "9: wg0    inet 10.44.0.2/24 scope global wg0" "11: br-test    inet 172.20.0.1/16 scope global br-test" "2: eth0    inet 192.168.50.25/24 scope global eth0" ;;' \
    'esac' > "$LINUX_BIN/ip"
printf '%s\n' '#!/usr/bin/env bash' 'exit 1' > "$LINUX_BIN/ifconfig"
chmod +x "$LINUX_BIN/route" "$LINUX_BIN/ip" "$LINUX_BIN/ifconfig"

actual_ip="$(run_fixture "$LINUX_BIN")"

if [ "$actual_ip" != "192.168.50.25" ]; then
    echo "Expected the physical eth0 address when wg0 owns the default route."
    echo "Actual address: $actual_ip"
    exit 1
fi

echo "start.sh local IP VPN regression tests passed"
