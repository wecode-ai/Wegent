# Standalone Executor Mode Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add standalone executor mode selection so macOS users default to a release-installed host executor while retaining container and hybrid modes.

**Architecture:** `install.sh` owns user choice, mode defaulting, Docker runtime env, host executor release install, and host executor lifecycle. `docker/standalone/start.sh` owns whether the in-container executor starts. Existing device routing remains unchanged: host executor registers as a local device through Backend WebSocket.

**Tech Stack:** Bash installer scripts, Docker run environment variables, Python static contract tests, Markdown docs.

---

## File Structure

- Modify `install.sh`: add executor-mode CLI/env parsing, default selection, standalone docker env mapping, host executor install/config/start functions, and completion output.
- Modify `docker/standalone/start.sh`: honor `STANDALONE_EXECUTOR_ENABLED=false` and make shutdown/wait/report safe when no executor PID exists.
- Modify `backend/tests/docker/test_standalone_wework_contract.py`: static contract tests for the new container switch, installer mode options, release installer usage, and no source-build requirement.
- Modify `tests/install/test_install_env.sh`: shell-level tests for default mode resolution and explicit mode validation.
- Modify `docs/zh/deployment/standalone-mode.md`: Chinese docs first, describe executor modes and macOS host default.
- Modify `docs/en/deployment/standalone-mode.md`: English translation of the updated standalone deployment docs.

## Task 1: Installer Mode Parsing And Defaults

**Files:**
- Modify: `install.sh`
- Test: `tests/install/test_install_env.sh`

- [ ] **Step 1: Add failing shell tests for mode defaults and validation**

Append these tests before `run_test()` in `tests/install/test_install_env.sh`:

```bash
test_executor_mode_defaults_to_host_for_interactive_macos() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE=""
    WEGENT_STANDALONE_EXECUTOR_MODE=""
    NO_PROMPT="0"
    OS="macos"

    is_promptable() { return 1; }

    select_standalone_executor_mode >/dev/null

    [[ "$STANDALONE_EXECUTOR_MODE" == "host" ]]
}

test_executor_mode_defaults_to_container_for_non_interactive() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE=""
    WEGENT_STANDALONE_EXECUTOR_MODE=""
    NO_PROMPT="1"
    OS="macos"

    select_standalone_executor_mode >/dev/null

    [[ "$STANDALONE_EXECUTOR_MODE" == "container" ]]
}

test_executor_mode_accepts_explicit_hybrid_env() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE=""
    WEGENT_STANDALONE_EXECUTOR_MODE="hybrid"
    NO_PROMPT="1"
    OS="linux"

    select_standalone_executor_mode >/dev/null

    [[ "$STANDALONE_EXECUTOR_MODE" == "hybrid" ]]
}

test_executor_mode_rejects_invalid_value() {
    source_installer_without_main

    DEPLOY_MODE="standalone"
    STANDALONE_EXECUTOR_MODE="invalid"
    NO_PROMPT="1"
    OS="linux"

    if select_standalone_executor_mode >/tmp/wegent-invalid-mode.out 2>&1; then
        cat /tmp/wegent-invalid-mode.out
        return 1
    fi

    grep -q "Invalid standalone executor mode" /tmp/wegent-invalid-mode.out
}
```

Add these `run_test` calls before the existing `run_test "new standard .env...` call:

```bash
run_test "executor mode defaults to host for interactive macOS" \
    test_executor_mode_defaults_to_host_for_interactive_macos
run_test "executor mode defaults to container for non-interactive" \
    test_executor_mode_defaults_to_container_for_non_interactive
run_test "executor mode accepts explicit hybrid env" \
    test_executor_mode_accepts_explicit_hybrid_env
run_test "executor mode rejects invalid value" \
    test_executor_mode_rejects_invalid_value
```

- [ ] **Step 2: Run the shell test and verify it fails**

Run:

```bash
bash tests/install/test_install_env.sh
```

Expected: FAIL because `select_standalone_executor_mode` is not defined.

- [ ] **Step 3: Add installer variables, CLI flag, usage, and selector**

In `install.sh`, add this near the existing standalone configuration block:

```bash
STANDALONE_EXECUTOR_MODE="${WEGENT_STANDALONE_EXECUTOR_MODE:-}"
HOST_EXECUTOR_INSTALL_URL="${WEGENT_HOST_EXECUTOR_INSTALL_URL:-https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh}"
HOST_EXECUTOR_BINARY="${WEGENT_HOST_EXECUTOR_BINARY:-$HOME/.wegent-executor/bin/wegent-executor}"
HOST_EXECUTOR_HOME="${WEGENT_HOST_EXECUTOR_HOME:-$HOME/.wegent-executor}"
HOST_EXECUTOR_PID_FILE="${HOST_EXECUTOR_HOME}/wegent-executor.pid"
HOST_EXECUTOR_LOG_FILE="${HOST_EXECUTOR_HOME}/logs/standalone-host-executor.log"
```

In `print_usage()`, add the option and environment variable:

```bash
  --executor-mode MODE  Standalone executor mode: container, host, or hybrid
```

```bash
  WEGENT_STANDALONE_EXECUTOR_MODE  Set standalone executor mode: container, host, or hybrid
```

In `parse_args()`, add:

```bash
            --executor-mode)
                if [[ $# -lt 2 ]]; then
                    ui_error "--executor-mode requires a value: container, host, or hybrid"
                    exit 1
                fi
                STANDALONE_EXECUTOR_MODE="$2"
                shift 2
                ;;
```

Add these functions after `select_deploy_mode()`:

```bash
is_valid_standalone_executor_mode() {
    case "$1" in
        container|host|hybrid)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

default_standalone_executor_mode() {
    if [[ "$NO_PROMPT" == "1" ]]; then
        echo "container"
        return
    fi

    if [[ "$OS" == "macos" ]]; then
        echo "host"
        return
    fi

    echo "container"
}

select_standalone_executor_mode() {
    if [[ "$DEPLOY_MODE" != "standalone" ]]; then
        if [[ -n "$STANDALONE_EXECUTOR_MODE" ]]; then
            ui_warn "--executor-mode applies only to standalone mode; ignoring '$STANDALONE_EXECUTOR_MODE'"
        fi
        return
    fi

    if [[ -z "$STANDALONE_EXECUTOR_MODE" && -n "${WEGENT_STANDALONE_EXECUTOR_MODE:-}" ]]; then
        STANDALONE_EXECUTOR_MODE="$WEGENT_STANDALONE_EXECUTOR_MODE"
    fi

    if [[ -n "$STANDALONE_EXECUTOR_MODE" ]]; then
        if ! is_valid_standalone_executor_mode "$STANDALONE_EXECUTOR_MODE"; then
            ui_error "Invalid standalone executor mode: $STANDALONE_EXECUTOR_MODE"
            ui_info "Accepted values: container, host, hybrid"
            return 1
        fi
        ui_success "Using standalone executor mode: $STANDALONE_EXECUTOR_MODE"
        return
    fi

    local default_mode
    default_mode="$(default_standalone_executor_mode)"

    if ! is_promptable; then
        STANDALONE_EXECUTOR_MODE="$default_mode"
        ui_info "Non-interactive mode, using standalone executor mode: $STANDALONE_EXECUTOR_MODE"
        return
    fi

    echo ""
    echo -e "${YELLOW}Select standalone executor mode:${NC}"
    echo -e "  ${GREEN}[1]${NC} Host executor ${MUTED}(recommended on macOS)${NC}"
    echo -e "      Runs coding agents on this machine; required for macOS system commands"
    echo ""
    echo -e "  ${BLUE}[2]${NC} Container executor"
    echo -e "      Current standalone behavior; everything runs inside Docker"
    echo ""
    echo -e "  ${CYAN}[3]${NC} Hybrid"
    echo -e "      Start both container and host executors"
    echo ""

    local default_choice="2"
    if [[ "$default_mode" == "host" ]]; then
        default_choice="1"
    elif [[ "$default_mode" == "hybrid" ]]; then
        default_choice="3"
    fi

    printf "Choose [1/2/3] (default: %s): " "$default_choice"
    local executor_choice
    read -r executor_choice < /dev/tty
    executor_choice="${executor_choice:-$default_choice}"

    case "$executor_choice" in
        1)
            STANDALONE_EXECUTOR_MODE="host"
            ;;
        3)
            STANDALONE_EXECUTOR_MODE="hybrid"
            ;;
        *)
            STANDALONE_EXECUTOR_MODE="container"
            ;;
    esac

    ui_success "Selected standalone executor mode: $STANDALONE_EXECUTOR_MODE"
}
```

In `main()`, call the selector immediately after `select_deploy_mode`:

```bash
    select_deploy_mode
    select_standalone_executor_mode
```

- [ ] **Step 4: Run the shell tests**

Run:

```bash
bash tests/install/test_install_env.sh
```

Expected: PASS for the four new executor mode tests.

- [ ] **Step 5: Commit**

```bash
git add install.sh tests/install/test_install_env.sh
git commit -m "feat(installer): select standalone executor mode"
```

## Task 2: Container Executor Runtime Switch

**Files:**
- Modify: `docker/standalone/start.sh`
- Test: `backend/tests/docker/test_standalone_wework_contract.py`

- [ ] **Step 1: Add failing contract tests for disabling the in-container executor**

Append this test to `backend/tests/docker/test_standalone_wework_contract.py`:

```python
def test_standalone_start_can_skip_container_executor() -> None:
    """Standalone startup should support host-only executor mode."""
    start_script = STANDALONE_START.read_text(encoding="utf-8")

    assert 'STANDALONE_EXECUTOR_ENABLED="${STANDALONE_EXECUTOR_ENABLED:-true}"' in start_script
    assert 'if [ "$STANDALONE_EXECUTOR_ENABLED" != "false" ]; then' in start_script
    assert 'echo "[4/8] Skipping Standalone Executor' in start_script
    assert '${EXECUTOR_PID:-}' in start_script
    assert 'WAIT_PIDS=("$REDIS_PID" "$BACKEND_PID" "$FRONTEND_PID" "$WEWORK_PID")' in start_script
    assert 'if [ -n "${EXECUTOR_PID:-}" ]; then' in start_script
```

- [ ] **Step 2: Run the focused contract test and verify it fails**

Run:

```bash
cd backend && uv run pytest tests/docker/test_standalone_wework_contract.py::test_standalone_start_can_skip_container_executor -q
```

Expected: FAIL because `STANDALONE_EXECUTOR_ENABLED` is not in `docker/standalone/start.sh`.

- [ ] **Step 3: Implement the container executor switch**

In `docker/standalone/start.sh`, add this near the port defaults:

```bash
STANDALONE_EXECUTOR_ENABLED="${STANDALONE_EXECUTOR_ENABLED:-true}"
```

Replace the unconditional `start_executor` call with:

```bash
if [ "$STANDALONE_EXECUTOR_ENABLED" != "false" ]; then
    start_executor
else
    echo "[4/8] Skipping Standalone Executor (STANDALONE_EXECUTOR_ENABLED=false)"
fi
```

Replace the final wait block with PID-array handling:

```bash
WAIT_PIDS=("$REDIS_PID" "$BACKEND_PID" "$FRONTEND_PID" "$WEWORK_PID")
if [ -n "${EXECUTOR_PID:-}" ]; then
    WAIT_PIDS+=("$EXECUTOR_PID")
fi

set +e
wait -n "${WAIT_PIDS[@]}"
EXIT_CODE=$?
set -e
```

Leave shutdown `stop_pid "Standalone Executor" "${EXECUTOR_PID:-}"` as-is because it already handles an empty PID.

- [ ] **Step 4: Run the focused contract test**

Run:

```bash
cd backend && uv run pytest tests/docker/test_standalone_wework_contract.py::test_standalone_start_can_skip_container_executor -q
```

Expected: PASS.

- [ ] **Step 5: Run all standalone contract tests**

Run:

```bash
cd backend && uv run pytest tests/docker/test_standalone_wework_contract.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docker/standalone/start.sh backend/tests/docker/test_standalone_wework_contract.py
git commit -m "feat(standalone): allow disabling container executor"
```

## Task 3: Docker Run Env Mapping And Completion Output

**Files:**
- Modify: `install.sh`
- Test: `backend/tests/docker/test_standalone_wework_contract.py`

- [ ] **Step 1: Add failing static tests for Docker env mapping and completion output**

Append this test to `backend/tests/docker/test_standalone_wework_contract.py`:

```python
def test_installer_maps_executor_mode_to_container_env() -> None:
    """Installer should pass the correct container executor switch."""
    install_script = INSTALL_SCRIPT.read_text(encoding="utf-8")

    assert "standalone_container_executor_enabled()" in install_script
    assert 'docker_run_cmd+=" -e STANDALONE_EXECUTOR_ENABLED=$(standalone_container_executor_enabled)"' in install_script
    assert 'ui_kv "Executor mode" "$STANDALONE_EXECUTOR_MODE"' in install_script
    assert 'ui_kv "Host executor" "$HOST_EXECUTOR_BINARY"' in install_script
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd backend && uv run pytest tests/docker/test_standalone_wework_contract.py::test_installer_maps_executor_mode_to_container_env -q
```

Expected: FAIL because `standalone_container_executor_enabled()` is not defined.

- [ ] **Step 3: Add mode-to-env mapping in `install.sh`**

Add this function after `select_standalone_executor_mode()`:

```bash
standalone_container_executor_enabled() {
    case "$STANDALONE_EXECUTOR_MODE" in
        host)
            echo "false"
            ;;
        container|hybrid)
            echo "true"
            ;;
        *)
            echo "true"
            ;;
    esac
}
```

In `start_standalone_service()`, add this to the Docker run command before `LITELLM_LOCAL_MODEL_COST_MAP`:

```bash
    docker_run_cmd+=" -e STANDALONE_EXECUTOR_ENABLED=$(standalone_container_executor_enabled)"
```

In `print_completion()`, inside the standalone branch, add:

```bash
        ui_kv "Executor mode" "$STANDALONE_EXECUTOR_MODE"
        if [[ "$STANDALONE_EXECUTOR_MODE" == "host" || "$STANDALONE_EXECUTOR_MODE" == "hybrid" ]]; then
            ui_kv "Host executor" "$HOST_EXECUTOR_BINARY"
        fi
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
cd backend && uv run pytest tests/docker/test_standalone_wework_contract.py::test_installer_maps_executor_mode_to_container_env -q
```

Expected: PASS.

- [ ] **Step 5: Run installer shell tests**

Run:

```bash
bash tests/install/test_install_env.sh
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add install.sh backend/tests/docker/test_standalone_wework_contract.py
git commit -m "feat(installer): pass standalone executor mode to container"
```

## Task 4: Host Executor Release Install And Startup

**Files:**
- Modify: `install.sh`
- Test: `backend/tests/docker/test_standalone_wework_contract.py`

- [ ] **Step 1: Add failing static tests for release installer usage**

Append this test to `backend/tests/docker/test_standalone_wework_contract.py`:

```python
def test_installer_uses_release_installer_for_host_executor() -> None:
    """Host executor setup should download release artifacts, not build locally."""
    install_script = INSTALL_SCRIPT.read_text(encoding="utf-8")

    assert "install_host_executor_from_release()" in install_script
    assert "HOST_EXECUTOR_INSTALL_URL" in install_script
    assert "local_executor_install.sh | bash" in install_script
    assert "configure_host_executor()" in install_script
    assert "start_host_executor()" in install_script
    assert "setup_host_executor_if_needed()" in install_script
    assert "executor/.venv/bin/python executor/main.py" not in install_script
    assert "./local.sh all" not in install_script
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cd backend && uv run pytest tests/docker/test_standalone_wework_contract.py::test_installer_uses_release_installer_for_host_executor -q
```

Expected: FAIL because host executor setup functions are not defined.

- [ ] **Step 3: Add host executor helper functions**

In `install.sh`, add these functions after `standalone_container_executor_enabled()`:

```bash
needs_host_executor() {
    [[ "$DEPLOY_MODE" == "standalone" ]] && {
        [[ "$STANDALONE_EXECUTOR_MODE" == "host" ]] || [[ "$STANDALONE_EXECUTOR_MODE" == "hybrid" ]]
    }
}

install_host_executor_from_release() {
    ui_section "Installing Host Executor"

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would download and run: ${HOST_EXECUTOR_INSTALL_URL}"
        return
    fi

    ui_info "Downloading executor release installer..."
    if ! curl -fsSL "$HOST_EXECUTOR_INSTALL_URL" | bash; then
        ui_error "Failed to install host executor from release"
        ui_info "Retry manually:"
        ui_info "  curl -fsSL ${HOST_EXECUTOR_INSTALL_URL} | bash"
        return 1
    fi
}

read_standalone_executor_token() {
    docker exec "$STANDALONE_CONTAINER_NAME" sh -lc 'cat /app/data/standalone_executor_token'
}

redact_token() {
    local token="$1"
    if [[ ${#token} -le 10 ]]; then
        echo "redacted"
        return
    fi
    printf '%s...\n' "${token:0:10}"
}

configure_host_executor() {
    local token="$1"
    local config_path="${HOST_EXECUTOR_HOME}/device-config.json"

    mkdir -p "$HOST_EXECUTOR_HOME"
    umask 077
    cat > "$config_path" <<EOF
{
  "mode": "local",
  "device_type": "local",
  "bind_shell": "claudecode",
  "device_id": "",
  "device_name": "$(hostname)-macOS",
  "capabilities": [],
  "max_concurrent_tasks": 5,
  "connection": {
    "backend_url": "http://127.0.0.1:8000",
    "auth_token": "$token"
  },
  "logging": {
    "level": "info",
    "max_size_mb": 10,
    "backup_count": 5
  },
  "update": {
    "registry": "",
    "registry_token": ""
  }
}
EOF
    chmod 600 "$config_path"
    ui_success "Host executor configured at ${config_path}"
}

stop_host_executor_if_running() {
    if [[ ! -f "$HOST_EXECUTOR_PID_FILE" ]]; then
        return
    fi

    local pid
    pid="$(cat "$HOST_EXECUTOR_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
        ui_info "Stopping existing host executor (PID: $pid)"
        kill "$pid" >/dev/null 2>&1 || true
        for _ in {1..20}; do
            if ! kill -0 "$pid" >/dev/null 2>&1; then
                break
            fi
            sleep 0.5
        done
    fi
    rm -f "$HOST_EXECUTOR_PID_FILE"
}

start_host_executor() {
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_info "[DRY RUN] Would start host executor: ${HOST_EXECUTOR_BINARY}"
        return
    fi

    if [[ ! -x "$HOST_EXECUTOR_BINARY" ]]; then
        ui_error "Host executor binary is missing or not executable: ${HOST_EXECUTOR_BINARY}"
        return 1
    fi

    mkdir -p "$(dirname "$HOST_EXECUTOR_LOG_FILE")"
    stop_host_executor_if_running

    ui_info "Starting host executor..."
    nohup "$HOST_EXECUTOR_BINARY" >> "$HOST_EXECUTOR_LOG_FILE" 2>&1 &
    echo $! > "$HOST_EXECUTOR_PID_FILE"
    sleep 1

    if ! kill -0 "$(cat "$HOST_EXECUTOR_PID_FILE")" >/dev/null 2>&1; then
        ui_error "Host executor failed to start"
        ui_info "Recent log:"
        tail -n 80 "$HOST_EXECUTOR_LOG_FILE" || true
        return 1
    fi

    ui_success "Host executor started with PID $(cat "$HOST_EXECUTOR_PID_FILE")"
}

setup_host_executor_if_needed() {
    if ! needs_host_executor; then
        return
    fi

    install_host_executor_from_release

    if [[ "$DRY_RUN" == "1" ]]; then
        return
    fi

    local token
    if ! token="$(read_standalone_executor_token)"; then
        ui_error "Failed to read standalone executor token"
        ui_info "Check container logs: docker logs ${STANDALONE_CONTAINER_NAME}"
        return 1
    fi

    if [[ -z "$token" ]]; then
        ui_error "Standalone executor token is empty"
        ui_info "Check container logs: docker logs ${STANDALONE_CONTAINER_NAME}"
        return 1
    fi

    ui_info "Using standalone executor token: $(redact_token "$token")"
    configure_host_executor "$token"
    start_host_executor
}
```

- [ ] **Step 4: Call host setup after standalone readiness**

In `main()`, inside the standalone branch after `wait_for_standalone_service`, call:

```bash
            setup_host_executor_if_needed
```

The standalone branch should look like:

```bash
        if [[ "$DRY_RUN" != "1" ]]; then
            wait_for_standalone_service
            setup_host_executor_if_needed
        else
            setup_host_executor_if_needed
        fi
```

- [ ] **Step 5: Run focused static test**

Run:

```bash
cd backend && uv run pytest tests/docker/test_standalone_wework_contract.py::test_installer_uses_release_installer_for_host_executor -q
```

Expected: PASS.

- [ ] **Step 6: Run installer shell tests**

Run:

```bash
bash tests/install/test_install_env.sh
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add install.sh backend/tests/docker/test_standalone_wework_contract.py
git commit -m "feat(installer): install standalone host executor from release"
```

## Task 5: Standalone Documentation

**Files:**
- Modify: `docs/zh/deployment/standalone-mode.md`
- Modify: `docs/en/deployment/standalone-mode.md`

- [ ] **Step 1: Update Chinese standalone docs**

In `docs/zh/deployment/standalone-mode.md`, update the overview paragraph to state that macOS interactive installs default to a host executor. Add this section after "快速开始":

```markdown
## Executor 运行位置

Standalone 支持三种 executor 模式：

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `host` | Backend/Frontend/Wework 在 Docker 中运行，executor 从 GitHub Release 下载并在宿主机运行 | macOS 默认推荐；需要执行 `open`、`osascript`、系统 Terminal、Keychain 等宿主机命令 |
| `container` | executor 在 standalone 容器内运行 | Linux 快速体验和现有单容器行为 |
| `hybrid` | 容器内 executor 和宿主机 executor 同时运行 | 需要保留容器设备，同时使用宿主机能力 |

macOS 上 Docker Desktop 容器运行的是 Linux 进程，容器内的 Claude Code 或 Codex 不能直接执行 macOS 系统命令。因此交互式 macOS 安装默认选择 `host`。非交互安装默认仍为 `container`，以保持自动化脚本兼容。

显式选择模式：

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | \
  bash -s -- --standalone --executor-mode host
```

也可以使用环境变量：

```bash
WEGENT_STANDALONE_EXECUTOR_MODE=hybrid \
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```
```

Update the environment variable table with:

```markdown
| `WEGENT_STANDALONE_EXECUTOR_MODE` | standalone executor 模式：`host`、`container` 或 `hybrid` | macOS 交互安装为 `host`，非交互和 Linux 为 `container` |
| `STANDALONE_EXECUTOR_ENABLED` | 容器内 executor 开关，由安装脚本按 executor 模式传入 | `true` |
```

- [ ] **Step 2: Update English standalone docs**

In `docs/en/deployment/standalone-mode.md`, add the translated section:

```markdown
## Executor Location

Standalone supports three executor modes:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `host` | Backend, Frontend, and Wework run in Docker; the executor is downloaded from GitHub Releases and runs on the host | Default recommendation for macOS; required for `open`, `osascript`, system Terminal, Keychain-backed tools, and other host commands |
| `container` | The executor runs inside the standalone container | Linux quick start and existing single-container behavior |
| `hybrid` | Both the container executor and host executor run | Keep the container device while also using host-native capabilities |

On macOS, Docker Desktop containers run Linux processes, so Claude Code or Codex inside the container cannot directly execute macOS system commands. For that reason, interactive macOS installs default to `host`. Non-interactive installs still default to `container` for automation compatibility.

Explicit mode selection:

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | \
  bash -s -- --standalone --executor-mode host
```

Environment variable form:

```bash
WEGENT_STANDALONE_EXECUTOR_MODE=hybrid \
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```
```

Update the environment variable table with:

```markdown
| `WEGENT_STANDALONE_EXECUTOR_MODE` | Standalone executor mode: `host`, `container`, or `hybrid` | `host` for interactive macOS installs; `container` for non-interactive and Linux installs |
| `STANDALONE_EXECUTOR_ENABLED` | In-container executor switch passed by the installer according to executor mode | `true` |
```

- [ ] **Step 3: Verify docs have frontmatter and no unfinished markers**

Run:

```bash
head -5 docs/zh/deployment/standalone-mode.md
head -5 docs/en/deployment/standalone-mode.md
rg -n 'TB[D]|TO''DO|FIX''ME|待定' docs/zh/deployment/standalone-mode.md docs/en/deployment/standalone-mode.md
```

Expected: both files start with frontmatter including `sidebar_position`; `rg` returns no matches.

- [ ] **Step 4: Commit**

```bash
git add docs/zh/deployment/standalone-mode.md docs/en/deployment/standalone-mode.md
git commit -m "docs: explain standalone executor modes"
```

## Task 6: Final Verification

**Files:**
- No source edits unless verification exposes issues.

- [ ] **Step 1: Run installer shell tests**

Run:

```bash
bash tests/install/test_install_env.sh
```

Expected: all checks print `ok - ...`.

- [ ] **Step 2: Run standalone static contract tests**

Run:

```bash
cd backend && uv run pytest tests/docker/test_standalone_wework_contract.py -q
```

Expected: PASS.

- [ ] **Step 3: Static inspect generated dry-run command for host mode**

Run:

```bash
WEGENT_DRY_RUN=1 WEGENT_NO_PROMPT=1 \
bash install.sh --standalone --executor-mode host 2>&1 | tee /tmp/wegent-host-install-dry-run.log
```

Expected:

```text
-e STANDALONE_EXECUTOR_ENABLED=false
[DRY RUN] Would download and run: https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh
```

- [ ] **Step 4: Static inspect generated dry-run command for hybrid mode**

Run:

```bash
WEGENT_DRY_RUN=1 WEGENT_NO_PROMPT=1 \
bash install.sh --standalone --executor-mode hybrid 2>&1 | tee /tmp/wegent-hybrid-install-dry-run.log
```

Expected:

```text
-e STANDALONE_EXECUTOR_ENABLED=true
[DRY RUN] Would download and run: https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh
```

- [ ] **Step 5: Review git diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only intended files changed if any fixes were needed after the last commit.

- [ ] **Step 6: Commit verification fixes if needed**

If Step 5 shows fixes made during verification:

```bash
git add install.sh docker/standalone/start.sh backend/tests/docker/test_standalone_wework_contract.py tests/install/test_install_env.sh docs/zh/deployment/standalone-mode.md docs/en/deployment/standalone-mode.md
git commit -m "fix: stabilize standalone executor mode install flow"
```

If no files changed, do not create an empty commit.
