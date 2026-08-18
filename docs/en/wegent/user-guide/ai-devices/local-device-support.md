---
sidebar_position: 10
---

# Local Device Support

Local Device Support enables you to use your personal computer (Mac, Linux, or Windows) as a task executor, allowing AI tasks to run directly on your local machine.

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Device Registration](#-device-registration)
- [Using Local Devices](#-using-local-devices)
- [Device Management](#-device-management)
- [Troubleshooting](#-troubleshooting)
- [Related Resources](#-related-resources)

---

## 🎯 Overview

### What is Local Device Support?

Local Device Support allows your personal computer to act as a task executor for Wegent. Instead of running AI tasks on cloud infrastructure, tasks are executed directly on your machine with real-time streaming feedback.

### Core Benefits

| Benefit                 | Description                                                         |
| ----------------------- | ------------------------------------------------------------------- |
| **Lower Latency**       | Direct local execution without network transmission delays          |
| **Data Privacy**        | Your code and data never leave your local machine                   |
| **Environment Control** | Use your locally installed tools, dependencies, and configurations  |
| **Cost Savings**        | Reduce cloud execution resource consumption                         |
| **Custom Setup**        | Access to local credentials, custom tools, and specialized software |

---

## 📲 Device Registration

### Prerequisites

Before registering a local device, ensure you have:

- [ ] Wegent account with valid credentials
- [ ] Wegent Executor installed on your machine
- [ ] Network connectivity to Wegent backend
- [ ] Claude Code SDK configured (for ClaudeCode shell type)

### Installing Wegent Executor

#### One-Line Installation (Recommended)

**macOS / Linux:**

```bash
curl -fsSL https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.ps1 | iex
```

The installation script will:

- Check and install Node.js 18+ (required for Claude Code)
- Install or upgrade Claude Code SDK
- Download the appropriate binary for your platform
- Add the binary to your PATH

#### Linux AMD64 Claude CLI Requirement

The Rust executor binary does not bundle the Claude CLI. The runtime environment must provide an executable `claude` command that meets Wegent's minimum Claude Code version requirement. The installation script and device images install or upgrade Claude Code separately from the executor binary.

#### Use Personal Codex CLI Configuration

By default, the executor uses the Claude/Codex model and provider configuration issued by Wegent. To use personal Codex login information, open Wework **Settings** -> **Personal**, import or upload `~/.codex/auth.json` from a device, and enable the personal configuration. When device heartbeat reports that the local Codex auth file is missing, Wegent syncs the saved auth in the background; if `~/.codex/auth.json` already exists on the device, it is not overwritten. GPT models that use Codex access Codex through that authenticated account.

If Codex access requires a proxy, first save the personal proxy URL in Wework **Settings** -> **Personal** -> **Proxy**, then enable the Codex proxy switch in **Codex Auth**. Wegent injects `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and the matching lowercase environment variables when executing Codex. If `NO_PROXY` or `no_proxy` already exists, Wegent keeps that value; otherwise it bypasses `localhost`, `127.0.0.1`, `::1`, and `host.docker.internal` by default.

Wegent now marks whether Codex should use personal configuration explicitly on the execution request. It no longer uses the `WEGENT_LOCAL_CLI_CONFIG_RUNTIMES` environment variable for this decision.

#### Shared Local Skills

If one local device uses both Claude Code and Codex, open Wework **Settings** -> **Code** -> **Skills** and enable shared skill management. Wegent creates `~/.agents/skills` on the selected online Claude Code device, moves existing skills from `~/.codex/skills` and `~/.claude/skills` into that directory, and replaces the two legacy directories with symlinks to `~/.agents/skills`.

The operation is repeatable. Skills with the same directory name are not overwritten; the later migrated directory receives a source suffix, and the page reports the migration count. After enabling this option, local Skill autocomplete treats skills under `~/.agents/skills` as usable by both Claude and Codex.

### Building a Device Image

The repository provides `docker/device/Dockerfile` for cloud device or local device base images. It follows the official code-server `install.sh` flow to install a pinned standalone release under `/usr/local`. The image also installs the Claude Code and Codex CLIs, Node.js 22, Python, Git, and places the built `wegent-executor` at `/app/executor` and `~/.wecode/wegent-executor/bin/wegent-executor`.

The default system user inside the image is `wegent`, with `wegent` as its system password for terminal shell access. Following the local device installer, code-server starts with `auth: none` but listens only on `127.0.0.1:18080`. Remote IDE access must go through the device gateway's session-token validation; do not expose port 18080 outside the container or host.

The Dockerfile compiles the executor in a builder stage for the target platform and validates both the base-image rootfs and final ELF architecture. The public release workflow builds and verifies Linux AMD64 and ARM64 images.

```bash
docker buildx build --platform linux/amd64 \
  -f docker/device/Dockerfile \
  -t wegent-device:linux-amd64 \
  --load .
```

The executor binary does not include Claude Code, so `executor/dist/wegent-executor` can be reused in images that install Claude Code through npm, the base image, or another provisioning path.

Pass executor connection settings as runtime environment variables when running the device image. Do not bake the token into the image:

```bash
docker run -d --platform linux/amd64 \
  --name wegent-device \
  -p 17888:17888 \
  -e WEGENT_BACKEND_URL=https://backend.example.com \
  -e WEGENT_AUTH_TOKEN="$WEGENT_AUTH_TOKEN" \
  ghcr.io/wecode-ai/wegent-device:<version>
```

`WEGENT_BACKEND_URL` is the HTTP API address used by the Executor. Port 17888 exposes the token-gated device session gateway; make sure the address generated from `client_origin` is reachable from the user's browser. You can customize public package and system mirrors through the Dockerfile build arguments without changing the Dockerfile.

### Managed Cloud Device Persistence Contract

A managed cloud device may expose Git Worktree support only when the deployment platform mounts durable storage at the fixed path `/home/wegent/.wecode/wegent-executor`. This directory contains project workspaces, Chats workspaces, managed Worktrees, the Runtime Task Store, `worktrees.json`, snapshot refs, capability caches, and session state. A restarted or replaced instance must reattach the same volume at the same absolute path before starting the Executor.

The deployment must set `WEGENT_EXECUTOR_HOME_ID` to the stable logical device ID and keep `LOCAL_WORKSPACE_ROOT` inside `WEGENT_EXECUTOR_HOME`. At startup, the device image rejects relative or changed mount paths, unwritable storage, an instance whose logical device ID conflicts with the identity persisted on the volume, and a second Executor attempting to write the same Executor Home. The image can validate path, identity, writability, and the single-writer lock, but it cannot prove that the underlying storage is durable. The cloud provider must therefore treat volume attachment, reattachment, backup, and restore as deployment acceptance gates.

If the cloud platform cannot guarantee these conditions, it must not enable cloud Worktrees based on Executor capability alone. Losing the volume after instance replacement is an unrecoverable storage failure; the system must not create an empty directory with the same name or continue in the base project workspace.

The repository includes a phased acceptance probe. Run `seed` on the old instance to create a real Git repository, Git Worktree, and Runtime-state marker. After the platform replaces the instance and reattaches the same persistent volume at the same absolute path, run `verify` on the replacement. `WEGENT_ACCEPTANCE_INSTANCE_ID` must be a real platform identity such as a Pod UID or VM instance ID, and the second phase must use a different value:

```bash
export WEGENT_EXECUTOR_HOME=/home/wegent/.wecode/wegent-executor
export LOCAL_WORKSPACE_ROOT="$WEGENT_EXECUTOR_HOME/workspace"
export WEGENT_EXECUTOR_HOME_ID=<stable-logical-device-id>
export WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true
export WEGENT_ACCEPTANCE_INSTANCE_ID=<old-instance-id>
export WEGENT_ACCEPTANCE_VOLUME_ID=<pvc-or-pv-uid>
scripts/acceptance/executor-home-persistence-probe.sh seed

# After replacing the instance and reattaching the same persistent volume:
export WEGENT_ACCEPTANCE_INSTANCE_ID=<replacement-instance-id>
# WEGENT_ACCEPTANCE_VOLUME_ID must remain the same platform volume UID.
scripts/acceptance/executor-home-persistence-probe.sh verify
scripts/acceptance/executor-home-persistence-probe.sh cleanup
```

Every `seed`, `verify`, and `cleanup` phase calls the real Executor App IPC `runtime.worktrees.capabilities` and requires `persistentStorageVerified=true`. The probe creates the Worktree through `runtime.worktrees.prepare`, reconciles it after replacement through `runtime.worktrees.list`, and cleans it through `runtime.worktrees.delete`; it no longer substitutes a hand-written `git worktree add` for the Executor lifecycle. `verify` also checks the platform volume UID, logical-device identity, the stable `runtime_instance_id` in `device-config.json`, absolute Executor Home and Workspace paths, source-repository HEAD, the Git common directory, the Worktree `.git` file, Worktree contents, and Runtime state across the replacement. The probe exits nonzero for the same instance ID, a different volume UID, a different Runtime Instance ID, a different device ID, changed paths, or lost data; none of those results may be treated as a pass.

Backend pins `runtimeInstanceId` when a Cloud or Remote device first registers. A later registration for the same logical device with a new or empty Runtime Instance ID fails as a persistent-storage identity mismatch; it cannot overwrite the established value or create a bypass device record. Consequently, mounting a fresh empty volume cannot silently bring the old device online even when the deployment still supplies the original `DEVICE_ID`: the new volume generates a different Runtime Instance ID. Local and App devices retain their existing update behavior.

### Adding a Remote Docker Device

Remote Docker devices are for connecting a self-managed server or container host to Wegent. They receive work through the same device WebSocket protocol as cloud devices and support terminal and code-server sessions. The difference is lifecycle ownership: users start, stop, restart, and remove the Docker container themselves; Wegent does not provision or destroy it.

Each user can create at most one cloud device. If a cloud device already exists, the add-device dialog disables cloud device creation while still allowing remote Docker command generation.

In Wework, open **Settings** -> **Connections**, or click **Add device** on Wegent's **AI devices** page, then select **Remote Docker device** and generate the startup command. Command generation creates credentials only; it does not pre-register an offline Device record. The device appears in the separate **Remote devices** group only after the Executor successfully registers.

The generated command contains parameters like:

```bash
docker run -d \
  --name wegent-remote-device \
  --restart unless-stopped \
  -e DEVICE_TYPE=remote \
  -e EXECUTOR_MODE=local \
  -e DEVICE_ID=<generated-device-id> \
  -e WEGENT_EXECUTOR_HOME_ID=<generated-device-id> \
  -e WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true \
  -e DEVICE_NAME=<generated-device-name> \
  -e WEGENT_BACKEND_URL=https://backend.example.com \
  -e WEGENT_AUTH_TOKEN=<generated-api-key> \
  -e DEVICE_PUBLIC_BASE_URL=http://device.example.com:17888 \
  -p 17888:17888 \
  -v wegent-remote-device-home:/home/wegent/.wecode/wegent-executor \
  ghcr.io/wecode-ai/wegent-device:latest
```

The generation API keeps `client_origin` optional for compatibility. It uses that origin, the request origin, or the Backend address to generate `DEVICE_PUBLIC_BASE_URL`. `WEGENT_AUTH_TOKEN` is a newly created remote device API key for each command and only appears in that command.

`-v wegent-remote-device-home:/home/wegent/.wecode/wegent-executor` mounts the Docker named volume `wegent-remote-device-home` as the Executor home. It persists workspaces, downloaded capabilities, configuration, and runtime data so a recreated container can reuse them. `WEGENT_EXECUTOR_HOME_ID` pins that volume to the logical device. `WEGENT_WORKTREE_PERSISTENT_STORAGE_VERIFIED=true` declares that this startup command has provided and verified a stable volume, a fixed absolute mount path, and single-writer ownership; only then does Executor advertise Remote Worktrees to Wework. Never set it for a temporary directory, anonymous volume, or deployment that has not passed persistence acceptance. `DEVICE_ID` and the connection token come from the startup command environment rather than this volume. To keep upgrades from using an old binary stored in the volume, each container start refreshes `bin/wegent-executor` from the current image while preserving the remaining data. Removing the container does not remove the named volume; only an explicit `docker volume rm wegent-remote-device-home` clears it.

The device image is controlled by the Backend environment variable `REMOTE_DEVICE_DOCKER_IMAGE` and defaults to `ghcr.io/wecode-ai/wegent-device:latest`. Pin a released version or digest when reproducibility matters. The public release workflow publishes multi-architecture images and validates the image architecture, OCI version, source revision, and Executor version.

Before enabling Remote Docker Worktrees, run the real-container acceptance on a target host with an available Docker daemon:

```bash
WEGENT_REMOTE_DEVICE_ACCEPTANCE_IMAGE=ghcr.io/wecode-ai/wegent-device:<version> \
  scripts/acceptance/remote-device-worktree-persistence.sh
```

Set `WEGENT_REMOTE_DEVICE_REBUILD_IMAGE=<new-version-or-digest>` to include an image-upgrade check. The script uses an isolated named volume and verifies initial container startup, real Executor Runtime Instance initialization, the Worktree capability durability attestation, real Executor Worktree prepare/list/delete RPCs, rejection of a second writer, container deletion, image rebuild, preservation of the same volume identity and Runtime Instance, binary refresh, rejection of a different logical device, a second persistence verification, and cleanup. A missing Docker CLI, unavailable daemon, or failed invariant produces a nonzero exit instead of a skip. Set `WEGENT_ACCEPTANCE_KEEP_ARTIFACTS=1` to retain the containers and volume for diagnostics.

The intranet firewall on the target host must allow the browser to reach port 17888, but this port must not be exposed to the public internet. Port 17888 only serves token-protected IDE sessions. The session gateway validates the token, sets an HttpOnly cookie, and redirects to a URL without the token; it does not expose anonymous code-server access.

By default, the device image only starts `wegent-executor` and the code-server session gateway. Wework project terminals are relayed through the existing Socket.IO connection between Backend and Executor, so devices do not need a public address. IDE/code-server sessions for cloud and remote Docker devices use the session gateway at the automatically detected address, so the detected device IP must be reachable from the user's browser. Public Wework does not provide cloud desktop support; some product distributions may add it through the optional extension.

- `POST /api/projects/{project_id}/terminal`: starts a writable PTY in the project path and returns a `transport=socketio` terminal session ID. The browser connects through Backend's `/terminal` Socket.IO namespace.
- `POST /api/projects/{project_id}/code-server`: returns a short-token code-server URL. The code-server process only listens on the container loopback address with `auth: none`; the session gateway validates the short-lived token before the browser can reach it.
- `POST /api/devices/{device_id}/code-server`: opens code-server on a specific device. The optional request-body `path` opens that remote project directory; when omitted, Executor resolves its own default workspace (`/home/wegent/.wecode/wegent-executor/workspace` in the device image). Executor accepts only the default workspace, roots configured through `WEGENT_WORKSPACE_ROOTS`, and saved Codex project roots. Paths outside those boundaries are rejected.

Terminal sessions work for local, cloud, and remote Docker devices. Backend records the `session_id`, user, device, and executor socket binding, and the frontend connects to the `/terminal` namespace with the existing login JWT. After the browser joins the session room, Backend sends an acknowledged `terminal:attach` event through the `/local-executor` namespace. Executor only then reads the initial output buffered by the PTY and returns `terminal:output` and `terminal:exit` events, so the first shell prompt cannot be lost before the browser subscribes. Backend also relays input, resize, and close events to the device, while Executor manages the PTY directly. Code-server is a persistent in-container process, and cloud and remote Docker devices use the gateway to open the requested project path. Local devices do not support code-server project sessions.

When a project configures `workspace.localPath`, `workspace.devicePath`, or `workspace.checkoutPath`, Wework creates that directory through the device command when the project is confirmed and ensures it still exists before starting terminal or code-server. If directory creation fails, the project is not allowed to continue silently in an unusable state. `localPath` is for the user's local executor, while `devicePath` is a sandbox directory bound to a specific cloud or remote device. If the request includes a task ID and that task records an execution workspace path, such as a Git worktree, terminal or code-server starts directly in the task workspace path and does not fall back to the project directory.

### Standalone Chat Workspaces

For new Wework conversations with no selected project (`project_id=0`) that are bound to an online device, the Executor uses independent Chats workspaces by default. To disable them, set `WEGENT_EXECUTOR_STANDALONE_CHATS_ENABLED=false` in the device runtime environment. Frontend device chats keep the legacy behavior and continue to use task-scoped temporary workspaces.

The first task creates a directory in the Chats workspace tree, using the date and user request to name the directory. The default root is `~/.wecode/wegent-executor/workspace/chats`. To use another location, set `WEGENT_EXECUTOR_CHATS_DIR` in the device runtime environment. Backend stores the final path in the task metadata label `standaloneChatWorkspacePath`, so continuing the conversation or opening it from history reuses the same directory.

Project chats do not use the Chats workspace path. They use the project's configured `workspace.localPath`, `workspace.devicePath`, or `workspace.checkoutPath` by default. `workspace.devicePath` must be bound to the cloud or remote device selected for the project. If the current task uses a Git worktree, project tools use the worktree path recorded on that task.

#### Installing a Specific Version

**macOS / Linux:**

```bash
curl -fsSL https://github.com/wecode-ai/Wegent/releases/download/v1.0.0/local_executor_install.sh | bash -s -- --version v1.0.0
```

**Windows (PowerShell):**

```powershell
$env:WEGENT_VERSION='v1.0.0'; irm https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.ps1 | iex
```

#### Manual Installation (Development)

1. Clone or download the Wegent repository
2. Install dependencies:

```bash
cd executor
pip install -e .
```

### Starting the Executor

Run the executor in local device mode:

```bash
# Start with settings from environment variables or ~/.wegent-executor/device-config.json
wegent-executor

# Or temporarily override the connection settings with environment variables
export WEGENT_AUTH_TOKEN=your_jwt_token
export WEGENT_BACKEND_URL=https://your-wegent-instance.com
wegent-executor
```

The installer and first startup create `~/.wegent-executor/device-config.json`. Configuration priority is environment variables, device config, then defaults. If `WEGENT_EXECUTOR_HOME` is not set, the executor uses `~/.wegent-executor`. The executor always starts the HTTP server; non-`docker` mode also provides local JSONL IPC through the current process stdin/stdout and, after `WEGENT_BACKEND_URL` or `connection.backend_url` is set, connects to Backend. Wework App communicates only with the executor child process it starts directly; it does not discover or attach to an executor started manually outside the App. A full App exit also terminates only the child it owns. Stdout carries protocol frames only, while diagnostics are written to stderr and `~/.wegent-executor/logs/executor.log`.

#### Claude Code Execution Timeout

When the local executor starts a Claude Code child process, it waits up to 24 hours by default. Long-running code generation, dependency installation, or file processing tasks can continue within that window. To tune the limit for a specific environment, set `WEGENT_CLAUDE_CODE_PROCESS_TIMEOUT_SECONDS` before starting the executor. This setting only affects Claude Code child processes, not the native Codex app-server path; Codex RPC timeouts are controlled by `WEGENT_CODEX_RPC_TIMEOUT_SECONDS`.

```bash
export WEGENT_CLAUDE_CODE_PROCESS_TIMEOUT_SECONDS=172800
wegent-executor
```

### Getting JWT Token

1. Log in to Wegent Web UI
2. Go to **Settings** → **API Token**
3. Click **Generate** to create a new token
4. Copy the token for starting the executor

> **Note**: Tokens are valid for 7 days and need to be regenerated after expiration.

---

## 🖥 Using Local Devices

### Selecting a Device

In the chat interface, you'll see a device selector dropdown:

1. Click the **device selector** icon near the chat input
2. View available devices with their status:
   - 🟢 **Online**: Device is connected and ready
   - 🔴 **Offline**: Device is not connected
   - 🟡 **Busy**: Device is running at capacity
3. Select your preferred device
4. Send your message as usual

### Device Status Indicators

| Status      | Icon | Description                       |
| ----------- | ---- | --------------------------------- |
| **Online**  | 🟢   | Device connected, slots available |
| **Offline** | 🔴   | Device not connected              |
| **Busy**    | 🟡   | All 5 concurrent slots in use     |
| **Default** | ⭐   | Your default device for new tasks |

### Concurrent Task Slots

Each device supports up to **5 concurrent tasks**:

- View slot usage: "2/5 slots in use"
- Device shows "Busy" when all slots are occupied
- Tasks queue if you select a busy device

### Switching Between Cloud and Local

You can dynamically choose execution location:

| Selection           | Behavior                                     |
| ------------------- | -------------------------------------------- |
| **Cloud** (default) | Task executes on Wegent cloud infrastructure |
| **Local Device**    | Task executes on your selected local machine |

Simply change the device selection before sending each message.

### Using Local Devices in Projects

When creating a project, you can select an online or busy ClaudeCode local device. After the project is created, AI tasks execute on that local device and use the project's configured local path or checkout path.

Local devices do not support cloud connection capabilities in the project toolbar:

| Feature                     | Local Device Support |
| --------------------------- | -------------------- |
| **Terminal**                | Not supported        |
| **IDE/code-server**         | Not supported        |
| **Cloud desktop**           | Not supported        |
| **CPU/MEM/Disk monitoring** | Not supported        |

When a project is bound to a local device, the workspace toolbar hides Terminal, IDE, and Desktop entries and shows a local-device capability notice. Choose a cloud device when you need those connection and monitoring capabilities.

### Setting Default Device

1. Open device list in the selector
2. Click the **star icon** next to your preferred device
3. This device will be pre-selected for new conversations

---

## ⚙️ Device Management

### Viewing Registered Devices

Access your devices through:

1. **Device Selector**: Quick access in chat interface
2. **Settings Page**: Go to **Settings** → **Connections** to view connectable devices
3. **API**: `GET /devices` for programmatic access

### Managing Connection Devices

The **Settings** → **Connections** page lists ClaudeCode devices that the current account can connect to, including cloud devices and local devices. It only shows devices with `bind_shell=claudecode`, grouped by cloud devices and local devices.

Cloud devices display online status, executor version, CPU, memory, and disk usage. When no cloud device exists, click **Add** to create one. After the create request returns, the page keeps a "cloud device creating" notice visible. Initialization usually takes 2-3 minutes, and the device appears in the list automatically when it comes online. The Wework frontend can configure the scaling Wiki link in the resource note card with `VITE_CLOUD_DEVICE_SCALING_WIKI_URL`, guiding users to request a larger cloud device or clean workspace cache when CPU, MEM, or disk stays above 80%.

Local devices display device name, online status, and executor version. They do not show CPU, MEM, or disk monitoring data or the resource monitoring note, and they do not show cloud-only actions such as Terminal, IDE, cloud desktop, restart, or cloud-resource deletion. Offline local devices show a delete entry for removing the device registration. If the device reconnects, it automatically registers again.

Online cloud and remote Docker devices can open interactive sessions directly:

| Action       | Backend API                                 | Description                                                                                                                                                                                           |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Terminal** | `POST /api/devices/{device_id}/terminal`    | Starts a PTY in the default working directory `/home/ubuntu/.wegent-executor/workspace`; the request body may include `path` to choose the working directory, and Backend relays it through Socket.IO |
| **IDE**      | `POST /api/devices/{device_id}/code-server` | Opens a code-server session; the request body may include `path` for a remote project directory within the allowed roots, or omit it to use the default workspace                                     |

Terminal sessions do not expose device ports. IDE sessions return a short-lived session-token URL exposed through the device-side session gateway. Terminal and IDE buttons are disabled while the device is offline.

The more menu contains lower-frequency management actions:

| Action             | Description                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| **Rename**         | Click the device name or edit icon; the list refreshes after saving                              |
| **Restart Device** | Requires confirmation; the device briefly goes offline and active connections may be interrupted |
| **Delete Device**  | Requires confirmation; the cloud resources are released                                          |

### System Administration Device Monitor

Administrators can open **System Administration** -> **Device Monitor** to view devices across all users. The page supports filtering by status, device type, shell type, version, and keyword, and it includes single-device actions such as upgrade and cloud-device restart.

The page header provides two bulk actions:

| Action                        | Scope                                                                                               | Description                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Upgrade All Local Devices** | Online local devices with `bindShell=claudecode` and an executor version that supports auto-upgrade | Sends upgrade commands to eligible devices; offline, outdated, or task-running devices are skipped                                 |
| **Restart All Cloud Devices** | All cloud devices                                                                                   | Triggers the deployment-specific cloud restart implementation in bulk; returns an unconfigured result if restart is not configured |

After a bulk action is submitted, the API immediately returns a batch ID and the page polls batch status so long-running work does not occupy the HTTP request. When the batch completes, the page refreshes device statistics and the device list. The status response includes total, triggered, failed, skipped, and per-device error details so administrators can decide whether individual follow-up is needed.

### Device Information

Each device shows:

| Field              | Description                                          |
| ------------------ | ---------------------------------------------------- |
| **Name**           | Device hostname (e.g., "Darwin - MacBook-Pro.local") |
| **Status**         | Online/Offline indicator                             |
| **Version**        | Executor version, when available                     |
| **Resource Usage** | CPU, memory, and disk usage for cloud devices only   |
| **Slots**          | Concurrent task capacity (X/5)                       |
| **Default**        | Star indicator if set as default                     |

### Managing Devices

| Action             | How To                              |
| ------------------ | ----------------------------------- |
| **Set Default**    | Click star icon                     |
| **Remove Default** | Click star again on current default |
| **Delete Device**  | Click delete icon                   |

> **Note**: Deleting a local device only removes the registration. If the device reconnects, it will automatically re-register. Deleting a cloud device from the Connections settings page releases the corresponding cloud resources.

### Offline Device Handling

When a device goes offline:

1. The system waits for a short reconnect confirmation window to avoid treating transient network jitter as a real offline event
2. If the device does not recover within that window, running tasks are automatically marked as **FAILED**
3. Error message indicates device disconnection
4. Task slots are freed after the device is confirmed offline
5. Device appears grayed out in selector

---

## ❓ Troubleshooting

### Connection Issues

#### Device won't connect

**Possible causes:**

1. Invalid or expired JWT token
2. Network connectivity issues
3. Backend URL misconfigured

**Solutions:**

1. Generate a new JWT token from Wegent UI
2. Check network connectivity to Wegent backend
3. Verify `~/.wegent-executor/device-config.json` or the `WEGENT_BACKEND_URL` environment variable

#### Device shows offline immediately after connecting

**Possible causes:**

1. Token validation failure
2. Firewall blocking WebSocket
3. Backend service issues

**Solutions:**

1. Check token validity and permissions
2. Ensure WebSocket connections are allowed
3. Check Wegent backend logs for errors

### Task Execution Issues

#### Tasks fail immediately

**Possible causes:**

1. Claude Code SDK not installed
2. Missing dependencies on local machine
3. Insufficient permissions

**Solutions:**

1. Install and configure Claude Code SDK
2. Install required dependencies
3. Check file system permissions

#### Tasks hang without progress

**Possible causes:**

1. Claude Code SDK stuck
2. Network interruption during execution
3. Resource exhaustion on local machine

**Solutions:**

1. Restart the executor
2. Check network connectivity
3. Monitor local resource usage (CPU, memory)

### Device Management Issues

#### Multiple devices with same name

This is normal if you have multiple machines with similar hostnames. Each device has a unique ID based on hardware.

#### Cannot delete device

If a device keeps re-appearing after deletion, the executor is still running and re-registering. Stop the executor first, then delete.

---

## 💡 Best Practices

### When to Use Local Devices

| Use Case                     | Recommendation         |
| ---------------------------- | ---------------------- |
| **Sensitive codebases**      | ✅ Local device        |
| **Quick iterations**         | ✅ Local device        |
| **Custom tool requirements** | ✅ Local device        |
| **Batch processing**         | Cloud (more capacity)  |
| **Team collaboration**       | Cloud (shared access)  |
| **Mobile/remote access**     | Cloud (no local setup) |

### Multi-Device Setup

If you have multiple machines:

1. Register each device separately
2. Use descriptive hostnames for easy identification
3. Set your primary workstation as default
4. Use cloud fallback when devices are offline

### Resource Management

- Monitor local resource usage during task execution
- Close unnecessary applications for better performance
- Consider SSD storage for faster file operations
- Ensure adequate RAM for Claude Code SDK

---

## 🔗 Related Resources

### Documentation

- [Core Concepts](../../concepts/core-concepts.md) - Understand Wegent's architecture
- [Managing Tasks](../chat/managing-tasks.md) - Learn about task execution

### Technical References

- [Local Device Architecture](../../developer-guide/local-device-architecture.md) - Technical architecture details

---

## 💬 Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 Join community discussions

---

<p align="center">Execute AI tasks on your local machine with full control! 🚀</p>
