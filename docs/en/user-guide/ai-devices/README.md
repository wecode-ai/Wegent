---
sidebar_position: 5
---

# 💻 AI Devices

The AI Devices module allows you to use your personal computer (Mac, Linux, or Windows) as a task executor, running AI tasks directly on your local machine.

---

## 📋 Documents in This Module

| Document | Description |
|----------|-------------|
| [Local Device Support Guide](./local-device-support.md) | Complete guide to configuring and using local devices |

---

## 🎯 Core Features

### Local Execution

Register your personal computer as a Wegent task executor:

| Advantage | Description |
|-----------|-------------|
| **Lower Latency** | Direct local execution without network transmission delay |
| **Data Privacy** | Your code and data never leave your local machine |
| **Environment Control** | Use locally installed tools, dependencies, and configurations |
| **Cost Savings** | Reduce cloud execution resource consumption |
| **Custom Setup** | Access local credentials, custom tools, and specialized software |

### Device Management

- **Device Registration**: Automatically generate stable device IDs
- **Status Monitoring**: Real-time device online status
- **Concurrency Control**: Each device supports up to 5 concurrent tasks
- **Heartbeat Mechanism**: Automatic connection and status synchronization

### Security Mechanisms

- **JWT Authentication**: WebSocket connections require tokens
- **User Isolation**: Devices can only execute tasks from their owner
- **Hardware Binding**: Device IDs based on hardware identifiers

---

## 🚀 Quick Start

1. **Install Executor**:
   ```bash
   cd executor
   pip install -e .
   ```

2. **Start Executor**:
   ```bash
   wegent-executor --mode local --token YOUR_JWT_TOKEN
   ```

3. **Select Device**: Choose your local device in the chat interface device selector

4. **Execute Tasks**: Send messages, and tasks will execute locally

---

## 📊 Device Status

| Status | Icon | Description |
|--------|------|-------------|
| **Online** | 🟢 | Device connected with available slots |
| **Offline** | 🔴 | Device not connected |
| **Busy** | 🟡 | All 5 concurrent slots occupied |
| **Default** | ⭐ | Your default device for new tasks |

---

## 🔗 Related Resources

- [AI Chat](../ai-chat/README.md) - Execute chat tasks using local devices
- [Configuring Shells](../settings/configuring-shells.md) - Configure execution environment
- [Core Concepts](../../../concepts/core-concepts.md) - Understand Wegent architecture
