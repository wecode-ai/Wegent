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

| Benefit | Description |
|---------|-------------|
| **Lower Latency** | Direct local execution without network transmission delays |
| **Data Privacy** | Your code and data never leave your local machine |
| **Environment Control** | Use your locally installed tools, dependencies, and configurations |
| **Cost Savings** | Reduce cloud execution resource consumption |
| **Custom Setup** | Access to local credentials, custom tools, and specialized software |

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

#### Linux AMD64 Without Bundled Claude

GitHub Releases also provide `wegent-executor-linux-amd64-no-claude`. This binary does not bundle the Claude CLI into the executor and is intended for these cases:

- Cloud device or local device Docker images already install the `claude` command through npm, the base image, or another provisioning path
- You want a smaller executor binary
- The image or host environment should manage the Claude Code version centrally

When using this variant, make sure the runtime environment already has an executable `claude` command that meets Wegent's minimum Claude Code version requirement. The standard `wegent-executor-linux-amd64` still bundles the Claude CLI and is better for direct installation on regular Linux hosts.

Manual download example:

```bash
curl -fL -o wegent-executor \
  https://github.com/wecode-ai/Wegent/releases/latest/download/wegent-executor-linux-amd64-no-claude
chmod +x wegent-executor
```

#### Use Personal Codex CLI Configuration

By default, the executor uses the Claude/Codex model and provider configuration issued by Wegent. To use personal Codex login information, open Wework **Settings** -> **Personal**, import or upload `~/.codex/auth.json` from a device, and enable the personal configuration. When device heartbeat reports that the local Codex auth file is missing, Wegent syncs the saved auth in the background; if `~/.codex/auth.json` already exists on the device, it is not overwritten. GPT models that use Codex access Codex through that authenticated account.

Wegent now marks whether Codex should use personal configuration explicitly on the execution request. It no longer uses the `WEGENT_LOCAL_CLI_CONFIG_RUNTIMES` environment variable for this decision.

### Building a Device Image

The repository provides `docker/device/Dockerfile` for cloud device or local device base images. The image installs `code-server`, the `weiboplat.wecoder-agent` extension, Claude Code CLI, `ttyd`, Node.js 22, Python, Git, and copies `executor/dist/wegent-executor` to `/app/executor` and `~/.wegent-executor/bin/wegent-executor`.

The default user inside the image is `wegent`, and the default password is `wegent`. This account is intended for interactive terminal, code-server, or ttyd access inside the container. For production deployments, restrict access through runtime configuration, access control, or upstream platform authentication.

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

If the image already installs Claude Code, use `wegent-executor-linux-amd64-no-claude` as the input for `executor/dist/wegent-executor` to avoid carrying the Claude CLI in both the executor binary and the image.

Pass executor connection settings as runtime environment variables when running the device image. Do not bake the token into the image:

```bash
docker run -d --platform linux/amd64 \
  --name wegent-device \
  -p 17888:17888 \
  -e CODE_SERVER_PASSWORD=wegent \
  -e EXECUTOR_MODE=local \
  -e WEGENT_BACKEND_URL=http://localhost:8000 \
  -e WEGENT_AUTH_TOKEN="$WEGENT_AUTH_TOKEN" \
  -e DEVICE_PUBLIC_BASE_URL=http://localhost:17888 \
  wegent-device:linux-amd64
```

By default, the device image only starts `wegent-executor` and the interactive session gateway. Note that Wework currently exposes project connection tools only for cloud devices. Local devices can be bound to projects and execute AI tasks, but they do not support the project toolbar Terminal, IDE/code-server, or Desktop VNC/VPN entries.

- `POST /api/projects/{project_id}/terminal`: starts a writable ttyd in the project path and returns a short-token URL.
- `POST /api/projects/{project_id}/code-server`: returns a short-token code-server URL. The code-server process inside the device image runs with a fixed password, and the session gateway logs in server-side so the browser does not see the code-server login page or password.

These project session APIs are for cloud-device project connections. If the project is bound to a local device, Backend rejects terminal and code-server session startup. Cloud-device URLs include a short-lived session token and are exposed through the device-side session gateway. Each terminal or code-server session has an isolated path, so a user can open multiple projects at the same time or open multiple terminal/code-server sessions for one project. Terminal sessions are created dynamically on the device and the matching ttyd process is cleaned up when the browser disconnects. Code-server is a persistent in-container process, and the gateway opens the requested project path through it. To keep the legacy fixed `8080` code-server and `7681` ttyd entrypoints, add `-e START_DEVICE_UI=1` and map those ports at container runtime.

When a project configures `workspace.localPath` or `workspace.checkoutPath`, the device creates that directory before starting terminal or code-server.

### Standalone Chat Workspaces

When a chat has no selected project but is bound to an online device, executor-side independent Chats workspaces are currently disabled by default. To enable them, set `WEGENT_EXECUTOR_STANDALONE_CHATS_ENABLED=true` in the device runtime environment.

Once enabled, the first task runs in a temporary task directory. After the response finishes, the Executor generates a dated directory name from the response summary and moves the temporary directory into the Chats workspace tree. The default root is `~/.wecode/wegent-executor/workspace/chats`. To use another location, set `WEGENT_EXECUTOR_CHATS_DIR` in the device runtime environment. Backend stores the final path in the task metadata label `standaloneChatWorkspacePath`, so continuing the conversation or opening it from history reuses the same directory.

Project chats do not use this path. They continue to use the project's configured `workspace.localPath` or `workspace.checkoutPath`.

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
# Start with default settings
wegent-executor --mode local --token YOUR_JWT_TOKEN

# Or with environment variables
export WEGENT_AUTH_TOKEN=your_jwt_token
export WEGENT_BACKEND_URL=https://your-wegent-instance.com
EXECUTOR_MODE=local wegent-executor
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

| Status | Icon | Description |
|--------|------|-------------|
| **Online** | 🟢 | Device connected, slots available |
| **Offline** | 🔴 | Device not connected |
| **Busy** | 🟡 | All 5 concurrent slots in use |
| **Default** | ⭐ | Your default device for new tasks |

### Concurrent Task Slots

Each device supports up to **5 concurrent tasks**:

- View slot usage: "2/5 slots in use"
- Device shows "Busy" when all slots are occupied
- Tasks queue if you select a busy device

### Switching Between Cloud and Local

You can dynamically choose execution location:

| Selection | Behavior |
|-----------|----------|
| **Cloud** (default) | Task executes on Wegent cloud infrastructure |
| **Local Device** | Task executes on your selected local machine |

Simply change the device selection before sending each message.

### Using Local Devices in Projects

When creating a project, you can select an online or busy ClaudeCode local device. After the project is created, AI tasks execute on that local device and use the project's configured local path or checkout path.

Local devices do not support cloud connection capabilities in the project toolbar:

| Feature | Local Device Support |
|---------|----------------------|
| **Terminal** | Not supported |
| **IDE/code-server** | Not supported |
| **Desktop VNC/VPN** | Not supported |
| **CPU/MEM/Disk monitoring** | Not supported |

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

| Action | Backend API | Description |
|--------|-------------|-------------|
| **Terminal** | `POST /api/devices/{device_id}/terminal` | Starts ttyd in the default working directory `/home/ubuntu/.wegent-executor/workspace` |
| **IDE** | `POST /api/devices/{device_id}/code-server` | Opens a code-server session |

The returned URL includes a short-lived session token and is exposed through the device-side session gateway. Terminal and IDE buttons are disabled while the device is offline.

The more menu contains lower-frequency management actions:

| Action | Description |
|--------|-------------|
| **Rename** | Click the device name or edit icon; the list refreshes after saving |
| **Restart Device** | Requires confirmation; the device briefly goes offline and active connections may be interrupted |
| **Delete Device** | Requires confirmation; the cloud resources are released |

### Device Information

Each device shows:

| Field | Description |
|-------|-------------|
| **Name** | Device hostname (e.g., "Darwin - MacBook-Pro.local") |
| **Status** | Online/Offline indicator |
| **Version** | Executor version, when available |
| **Resource Usage** | CPU, memory, and disk usage for cloud devices only |
| **Slots** | Concurrent task capacity (X/5) |
| **Default** | Star indicator if set as default |

### Managing Devices

| Action | How To |
|--------|--------|
| **Set Default** | Click star icon |
| **Remove Default** | Click star again on current default |
| **Delete Device** | Click delete icon |

> **Note**: Deleting a local device only removes the registration. If the device reconnects, it will automatically re-register. Deleting a cloud device from the Connections settings page releases the corresponding cloud resources.

### Offline Device Handling

When a device goes offline:

1. Running tasks are automatically marked as **FAILED**
2. Error message indicates device disconnection
3. Task slots are freed immediately
4. Device appears grayed out in selector

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
3. Verify `WEGENT_BACKEND_URL` environment variable

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

| Use Case | Recommendation |
|----------|----------------|
| **Sensitive codebases** | ✅ Local device |
| **Quick iterations** | ✅ Local device |
| **Custom tool requirements** | ✅ Local device |
| **Batch processing** | Cloud (more capacity) |
| **Team collaboration** | Cloud (shared access) |
| **Mobile/remote access** | Cloud (no local setup) |

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
