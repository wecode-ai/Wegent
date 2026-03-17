#!/bin/bash

# Wegent Integration Tests Runner
# This script handles dependency installation, authentication setup, and test execution

# 中文说明 / Chinese Notes:
# 关于并发测试的说明 / About Concurrent Testing:
#   本测试套件默认使用串行执行（workers=1），因为所有测试共享同一个用户账户。
#   This test suite defaults to serial execution (workers=1) because all tests share the same user account.
#
#   并发测试（-w N, N>1）容易导致以下问题：
#   Concurrent testing (-w N, N>1) can cause the following issues:
#   1. 代码流程测试（Code Flow）：并发时页面导航会互相干扰，导致消息发送后无法跳转到任务视图
#      Code Flow tests: Concurrent page navigation interferes, causing failure to navigate to task view after sending messages
#   2. 群聊测试（Chat Group Flow）：并发创建群聊会互相可见，左侧栏堆积大量测试群，影响后续测试
#      Chat Group Flow tests: Concurrent group creation causes groups to be visible to each other,
#      causing the sidebar to accumulate test groups and affecting subsequent tests
#
#   如需使用并发测试以提高速度，可以使用 -w 参数：
#   To use concurrent testing for faster execution, use the -w flag:
#     sh run-tests.sh -w 5 http://localhost:3000
#   但请注意，并发模式下部分测试可能会失败。
#   Note: Some tests may fail in concurrent mode.
#
#   推荐：使用默认的串行模式进行测试，确保稳定性。
#   Recommended: Use the default serial mode for stable test execution.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUTH_DIR="$SCRIPT_DIR/.auth"
NODE_MODULES="$SCRIPT_DIR/node_modules"

# Get auth file path based on URL domain
get_auth_file() {
    local url="$1"
    # Extract domain from URL (remove protocol and port)
    # First remove protocol, then remove port and path
    local domain=$(echo "$url" | sed -E 's|^https?://||' | sed -E 's|[:/].*$||')
    # Sanitize domain: keep only alphanumeric, dots, and hyphens; replace others with underscore
    domain=$(echo "$domain" | sed -E 's|[^a-zA-Z0-9.-]|_|g')
    # Limit domain length to prevent overly long filenames (max 64 chars)
    if [ ${#domain} -gt 64 ]; then
        domain="${domain:0:64}"
    fi
    # Default to localhost if empty
    if [ -z "$domain" ]; then
        domain="localhost"
    fi
    echo "$AUTH_DIR/user_${domain}.json"
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if dependencies are installed
check_dependencies() {
    if [ ! -d "$NODE_MODULES" ]; then
        return 1
    fi

    # Check if @playwright/test is installed
    if [ ! -d "$NODE_MODULES/@playwright" ]; then
        return 1
    fi

    return 0
}

# Install dependencies
install_dependencies() {
    print_info "Installing dependencies..."
    cd "$SCRIPT_DIR"
    npm install

    print_info "Installing Playwright browsers..."
    npx playwright install chromium

    print_success "Dependencies installed successfully!"
}

# Check if auth state exists and is valid for a specific URL
check_auth() {
    local url="$1"
    local auth_file=$(get_auth_file "$url")

    if [ ! -f "$auth_file" ]; then
        return 1
    fi

    # Check if file is not empty and has valid JSON
    if [ ! -s "$auth_file" ]; then
        return 1
    fi

    # Basic check for auth_token in the file
    if grep -q "auth_token" "$auth_file" 2>/dev/null; then
        # Verify the auth file contains cookies for this domain
        local domain=$(echo "$url" | sed -E 's|https?://||' | sed -E 's|[:/].*||')
        if grep -q "$domain" "$auth_file" 2>/dev/null; then
            return 0
        fi
    fi

    return 1
}

# Run authentication setup
setup_auth() {
    local url="$1"
    local auth_file=$(get_auth_file "$url")

    print_info "Starting authentication setup..."
    print_info "Target: $url"
    print_info "Auth file: $auth_file"
    print_info "A browser will open. Please login manually."
    print_info "(Username/password for local, OIDC/QR code for online)"
    echo ""

    cd "$SCRIPT_DIR"
    # Pass auth file path to setup script
    TEST_BASE_URL="$url" AUTH_FILE="$auth_file" npx ts-node setup-auth.ts

    if check_auth "$url"; then
        print_success "Authentication setup completed!"
    else
        print_error "Authentication setup failed. Please try again."
        exit 1
    fi
}

# Run tests
run_tests() {
    local mode=$1
    local test_url=$2
    local test_pattern=$3
    local workers=$4
    local auth_file=$(get_auth_file "$test_url")

    cd "$SCRIPT_DIR"

    # Export TEST_BASE_URL if provided
    if [ -n "$test_url" ]; then
        export TEST_BASE_URL="$test_url"
        print_info "Testing URL: $test_url"
    fi

    # Export AUTH_FILE for playwright to use
    export PLAYWRIGHT_AUTH_FILE="$auth_file"
    print_info "Using auth state: $auth_file"

    # Show test pattern if specified
    if [ -n "$test_pattern" ]; then
        print_info "Running tests matching: $test_pattern"
    fi

    # Set default workers to 1 (serial) for stability
    # Tests share the same user account, so concurrent execution causes interference
    if [ -z "$workers" ]; then
        workers=1
    fi
    print_info "Running with $workers concurrent workers"

    # Build workers argument
    local workers_arg="--workers=$workers"

    case $mode in
        "headed")
            print_info "Running tests in headed mode (with browser UI)..."
            if [ -n "$test_pattern" ]; then
                npx playwright test -g "$test_pattern" --headed $workers_arg
            else
                npx playwright test --headed $workers_arg
            fi
            ;;
        "headless")
            print_info "Running tests in headless mode..."
            if [ -n "$test_pattern" ]; then
                npx playwright test -g "$test_pattern" $workers_arg
            else
                npx playwright test $workers_arg
            fi
            ;;
        "debug")
            print_info "Running tests in debug mode..."
            if [ -n "$test_pattern" ]; then
                npx playwright test -g "$test_pattern" --debug
            else
                npm run test:debug
            fi
            ;;
        *)
            print_error "Unknown mode: $mode"
            exit 1
            ;;
    esac
}

# Show usage
show_usage() {
    echo ""
    echo "Usage: $0 [OPTIONS] [URL]"
    echo ""
    echo "Options:"
    echo "  -h, --headed     Run tests with browser UI visible"
    echo "  -l, --headless   Run tests without browser UI (default)"
    echo "  -d, --debug      Run tests in debug mode"
    echo "  -a, --auth       Force re-authentication (re-scan QR code)"
    echo "  -i, --install    Force reinstall dependencies"
    echo "  -t, --test       Run specific test by name (e.g., -t clarification)"
    echo "  -w, --workers    Set concurrent workers (default: 1, use higher for faster but less stable)"
    echo "  --help           Show this help message"
    echo ""
    echo "Arguments:"
    echo "  URL              Target URL to test (default: https://wegent.intra.weibo.com)"
    echo ""
    echo "Environment Variables:"
    echo "  TEST_BASE_URL    Alternative way to set target URL"
    echo ""
    echo "Examples:"
    echo "  $0                                 # Run tests against https://wegent.intra.weibo.com"
    echo "  $0 -h                              # Run with browser visible"
    echo "  $0 http://localhost:3000           # Test specific URL (localhost)"
    echo "  $0 -h http://localhost:3000        # Test localhost with browser visible"
    echo "  $0 -a                              # Re-authenticate and run tests"
    echo "  $0 -t clarification                # Run only clarification mode test"
    echo "  $0 -t chat                         # Run tests matching 'chat' in name"
    echo "  $0 -w 1                            # Run sequentially (1 worker)"
    echo "  $0 -w 10                           # Run with 10 concurrent workers"
    echo "  TEST_BASE_URL=http://localhost:3000 $0"
    echo ""
}

# Main script
main() {
    local mode="headless"
    local force_auth=false
    local force_install=false
    local test_pattern=""
    local workers=""
    local test_url="${TEST_BASE_URL:-https://wegent.intra.weibo.com}"

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--headed)
                mode="headed"
                shift
                ;;
            -l|--headless)
                mode="headless"
                shift
                ;;
            -d|--debug)
                mode="debug"
                shift
                ;;
            -a|--auth)
                force_auth=true
                shift
                ;;
            -i|--install)
                force_install=true
                shift
                ;;
            -t|--test)
                # Check if next argument exists and is not an option
                if [[ $# -lt 2 ]]; then
                    print_error "Missing test pattern after -t/--test"
                    show_usage
                    exit 1
                fi
                if [[ "$2" =~ ^- ]]; then
                    print_error "Test pattern cannot start with '-': $2"
                    show_usage
                    exit 1
                fi
                test_pattern="$2"
                shift 2
                ;;
            -w|--workers)
                # Check if next argument exists and is a number
                if [[ $# -lt 2 ]]; then
                    print_error "Missing worker count after -w/--workers"
                    show_usage
                    exit 1
                fi
                if ! [[ "$2" =~ ^[0-9]+$ ]]; then
                    print_error "Worker count must be a number: $2"
                    show_usage
                    exit 1
                fi
                workers="$2"
                shift 2
                ;;
            --help)
                show_usage
                exit 0
                ;;
            # Handle combined short options (e.g., -ht)
            -[hldiatw]*)
                # Extract individual flags from combined option
                local flags="${1#-}"
                local i
                for ((i=0; i<${#flags}; i++)); do
                    case "${flags:$i:1}" in
                        h) mode="headed" ;;
                        l) mode="headless" ;;
                        d) mode="debug" ;;
                        a) force_auth=true ;;
                        i) force_install=true ;;
                        t)
                            # For -t, the rest of the string or next argument is the pattern
                            if [[ $i -lt $((${#flags}-1)) ]]; then
                                # Pattern is the rest of this combined option
                                test_pattern="${flags:$((i+1))}"
                                break
                            elif [[ $# -lt 2 || "$2" =~ ^- ]]; then
                                print_error "Missing test pattern after -t in combined options"
                                show_usage
                                exit 1
                            else
                                test_pattern="$2"
                                shift
                            fi
                            ;;
                        w)
                            # For -w, the rest of the string or next argument is the worker count
                            if [[ $i -lt $((${#flags}-1)) ]]; then
                                # Workers is the rest of this combined option
                                workers="${flags:$((i+1))}"
                                if ! [[ "$workers" =~ ^[0-9]+$ ]]; then
                                    print_error "Worker count must be a number: $workers"
                                    show_usage
                                    exit 1
                                fi
                                break
                            elif [[ $# -lt 2 || "$2" =~ ^- ]]; then
                                print_error "Missing worker count after -w in combined options"
                                show_usage
                                exit 1
                            else
                                workers="$2"
                                if ! [[ "$workers" =~ ^[0-9]+$ ]]; then
                                    print_error "Worker count must be a number: $workers"
                                    show_usage
                                    exit 1
                                fi
                                shift
                            fi
                            ;;
                        *)
                            print_error "Unknown option flag: ${flags:$i:1}"
                            show_usage
                            exit 1
                            ;;
                    esac
                done
                shift
                ;;
            http://*|https://*)
                test_url="$1"
                shift
                ;;
            *)
                print_error "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done

    echo ""
    echo "=========================================="
    echo "   Wegent Integration Tests Runner"
    echo "=========================================="
    echo ""
    print_info "Target URL: $test_url"
    echo ""

    # Step 1: Check and install dependencies
    if [ "$force_install" = true ] || ! check_dependencies; then
        print_warning "Dependencies not found or force install requested."
        install_dependencies
    else
        print_success "Dependencies already installed."
    fi

    echo ""

    # Step 2: Check and setup authentication
    local auth_file=$(get_auth_file "$test_url")
    print_info "Using auth file: $auth_file"

    if [ "$force_auth" = true ]; then
        print_warning "Force re-authentication requested."
        setup_auth "$test_url"
    elif ! check_auth "$test_url"; then
        print_warning "Authentication state not found for this URL."
        setup_auth "$test_url"
    else
        print_success "Authentication state found for this URL."
    fi

    echo ""

    # Step 3: Run tests
    print_info "Test mode: $mode"
    if [ -n "$test_pattern" ]; then
        print_info "Test filter: $test_pattern"
    fi
    echo ""
    run_tests "$mode" "$test_url" "$test_pattern" "$workers"
}

# Run main function
main "$@"
