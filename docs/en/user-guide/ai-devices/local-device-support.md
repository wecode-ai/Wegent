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

The repository provides `docker/device/Dockerfile` for cloud device or local device base images. The image installs `code-server`, the `weiboplat.wecoder-agent` extension, Claude Code CLI, Node.js 22, Python, Git, and copies `executor/dist/wegent-executor` to `/app/executor` and `~/.wecode/wegent-executor/bin/wegent-executor`.

The default user inside the image is `wegent`, and the default password is `wegent`. This account is intended for code-server and terminal shell access inside the container. For production deployments, restrict access through runtime configuration, access control, or upstream platform authentication.

Before building, prepare a Linux executor binary that matches the target platform, and confirm the base image supports the same platform. For example, when building a Linux AMD64 image, `executor/dist/wegent-executor` must be a Linux x86-64 ELF file, not a macOS Mach-O binary. When building a Linux ARM64 image, the base Ubuntu image rootfs must also be arm64.

```bash
WECODE_CLI_CC_TOKEN=xxx \
WECODE_CLI_CC_INSTALL_URL=xxx \
docker buildx build --platform linux/amd64 \
  -f docker/device/Dockerfile \
  -t wegent-device:linux-amd64 \
  --secret id=wecode_cli_cc_token,env=WECODE_CLI_CC_TOKEN \
  --secret id=wecode_cli_cc_install_url,env=WECODE_CLI_CC_INSTALL_URL \
  --load .
```

The executor binary does not include Claude Code, so `executor/dist/wegent-executor` can be reused in images that install Claude Code through npm, the base image, or another provisioning path.

Pass executor connection settings as runtime environment variables when running the device image. Do not bake the token into the image:

```bash
docker run -d --platform linux/amd64 \
  --name wegent-device \
  -p 17888:17888 \
  -e CODE_SERVER_PASSWORD=wegent \
  -e WEGENT_BACKEND_URL=http://host.docker.internal:8000 \
  -e WEGENT_AUTH_TOKEN="$WEGENT_AUTH_TOKEN" \
  -e DEVICE_PUBLIC_BASE_URL=http://localhost:17888 \
  wegent-device:linux-amd64
```

`WEGENT_BACKEND_URL` must be reachable from inside the container. If the Backend runs on the same macOS or Windows host, use `http://host.docker.internal:8000`; generated remote Docker commands automatically add `--add-host host.docker.internal:host-gateway` when needed for Linux Docker compatibility. `DEVICE_PUBLIC_BASE_URL` is the browser-reachable URL for the container session gateway; local runs usually use `http://localhost:17888`.

### Adding a Remote Docker Device

Remote Docker devices are for connecting a self-managed server or container host to Wegent. They receive work through the same device WebSocket protocol as cloud devices and support terminal and code-server sessions. The difference is lifecycle ownership: users start, stop, restart, and remove the Docker container themselves; Wegent does not provision or destroy it.

Each user can create at most one cloud device. If a cloud device already exists, the add-device dialog disables cloud device creation while still allowing remote Docker command generation.

In Wework, open **Settings** -> **Connections**, click **Add device**, select **Remote Docker device**, and generate the startup command. Wegent pre-registers a `remote` Device record, derives the image and `WEGENT_BACKEND_URL` from the current Backend environment, creates a new remote device API key, and returns a `docker run` command containing the device ID and runtime parameters. Run that command on the target host, and the container registers as a remote device under the **Remote devices** group.

The generated command contains parameters like:

```bash
docker run -d \
  --name wegent-remote-device \
  --restart unless-stopped \
  -e DEVICE_TYPE=remote \
  -e EXECUTOR_MODE=local \
  -e DEVICE_ID=<generated-device-id> \
  -e DEVICE_NAME=<generated-device-name> \
  -e WEGENT_BACKEND_URL=https://backend.example.com \
  -e WEGENT_AUTH_TOKEN=<generated-api-key> \
  -e DEVICE_PUBLIC_BASE_URL=http://localhost:17888 \
  -p 17888:17888 \
  -v wegent-remote-device-home:/home/wegent/.wecode/wegent-executor \
  ghcr.io/wecode-ai/wegent-device:latest
```

The generation API uses the current Backend environment to generate `WEGENT_BACKEND_URL`, in this order: `REMOTE_DEVICE_BACKEND_URL`, `BACKEND_INTERNAL_URL`, then the current request host. `WEGENT_AUTH_TOKEN` is a newly created remote device API key for each generated command and is not persisted in the Device CRD `remoteConfig`. `DEVICE_PUBLIC_BASE_URL` is derived from the current frontend host so the browser can open the device session gateway.

The default image is controlled by the Backend environment variable `REMOTE_DEVICE_DOCKER_IMAGE`; if unset, Wegent uses `ghcr.io/wecode-ai/wegent-device:latest`. If a deployment must use an internal registry, the deployer should set `REMOTE_DEVICE_DOCKER_IMAGE=<your-registry>/<your-image>:<tag>` in the Backend runtime environment. Users do not need to enter an image address manually.

By default, the device image only starts `wegent-executor` and the code-server session gateway. Wework project terminals are relayed through the existing Socket.IO connection between Backend and Executor, so devices do not need a public address. IDE/code-server and Desktop VNC/VPN entries remain cloud-device-only.

- `POST /api/projects/{project_id}/terminal`: starts a writable PTY in the project path and returns a `transport=socketio` terminal session ID. The browser connects through Backend's `/terminal` Socket.IO namespace.
- `POST /api/projects/{project_id}/code-server`: returns a short-token code-server URL. The code-server process inside the device image runs with a fixed password, and the session gateway logs in server-side so the browser does not see the code-server login page or password.

Terminal sessions work for local and cloud devices. Backend records the `session_id`, user, device, and executor socket binding, and the frontend connects to the `/terminal` namespace with the existing login JWT. After the browser joins the session room, Backend sends an acknowledged `terminal:attach` event through the `/local-executor` namespace. Executor only then reads the initial output buffered by the PTY and returns `terminal:output` and `terminal:exit` events, so the first shell prompt cannot be lost before the browser subscribes. Backend also relays input, resize, and close events to the device, while Executor manages the PTY directly. Code-server is a persistent in-container process, and the gateway opens the requested project path through it. Local devices do not support code-server project sessions.

When a project configures `workspace.localPath`, `workspace.devicePath`, or `workspace.checkoutPath`, the device creates that directory before starting terminal or code-server. `localPath` is for the user's local executor, while `devicePath` is a sandbox directory bound to a specific cloud or remote device. If the request includes a task ID and that task records an execution workspace path, such as a Git worktree, terminal or code-server starts directly in the task workspace path and does not fall back to the project directory.

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

The installer and first startup create `~/.wegent-executor/device-config.json`. Configuration priority is environment variables, device config, then defaults. If `WEGENT_EXECUTOR_HOME` is not set, the executor uses `~/.wegent-executor`. The executor always starts the HTTP server; non-`docker` mode also starts the local socket and, after `WEGENT_BACKEND_URL` or `connection.backend_url` is set, connects to Backend. Wework App manages executors it starts itself; if you start an executor manually outside the App, the App attaches to the existing socket but does not terminate that external process on exit. Do not run multiple manual executors with the same executor home or socket path. Logs are written to `~/.wegent-executor/logs/executor.log`.

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
| **Desktop VNC/VPN**         | Not supported        |
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

Local devices display device name, online status, and executor version. They do not show CPU, MEM, or disk monitoring data or the resource monitoring note, and they do not show cloud-only actions such as Terminal, IDE, Desktop VNC/VPN, restart, or cloud-resource deletion. Offline local devices show a delete entry for removing the device registration. If the device reconnects, it automatically registers again.

Online cloud devices can open interactive sessions directly:

| Action       | Backend API                                 | Description                                                                                                                                                                                           |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Terminal** | `POST /api/devices/{device_id}/terminal`    | Starts a PTY in the default working directory `/home/ubuntu/.wegent-executor/workspace`; the request body may include `path` to choose the working directory, and Backend relays it through Socket.IO |
| **IDE**      | `POST /api/devices/{device_id}/code-server` | Opens a code-server session                                                                                                                                                                           |

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
