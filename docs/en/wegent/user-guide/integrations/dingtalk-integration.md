---
sidebar_position: 2
---

# DingTalk Integration Guide

This guide provides detailed instructions for configuring DingTalk IM channel integration in Wegent.

---

## 📋 Table of Contents

- [Prerequisites](#-prerequisites)
- [Step 1: Create DingTalk Application](#-step-1-create-dingtalk-application)
- [Step 2: Configure Application Permissions](#-step-2-configure-application-permissions)
- [Step 3: Get Application Credentials](#-step-3-get-application-credentials)
- [Step 4: Enable Message Stream Mode](#-step-4-enable-message-stream-mode)
- [Step 5: Configure IM Channel in Wegent](#-step-5-configure-im-channel-in-wegent)
- [Step 6: Verify Connection](#-step-6-verify-connection)
- [Step 7: Test the Integration](#-step-7-test-the-integration)
- [DingTalk-Specific Features](#-dingtalk-specific-features)
- [Troubleshooting](#-troubleshooting)
- [Related Resources](#-related-resources)

---

## ✅ Prerequisites

Before setting up DingTalk integration, ensure you have:

- [ ] DingTalk Enterprise account with admin access
- [ ] Access to [DingTalk Open Platform](https://open.dingtalk.com)
- [ ] Wegent instance with admin privileges
- [ ] At least one configured Agent (Team) in Wegent

---

## 🔧 Step 1: Create DingTalk Application

1. Log in to [DingTalk Open Platform](https://open.dingtalk.com)
2. Navigate to **Application Development** → **Enterprise Internal Application**
3. Click **Create Application**
4. Fill in application details:
   - **Application Name**: Your bot name (e.g., "Wegent AI Assistant")
   - **Application Description**: Brief description of the bot's purpose
   - **Application Icon**: Upload an appropriate icon

---

## 🔐 Step 2: Configure Application Permissions

Enable the following permissions for your application:

**Robot Permissions:**

- `qyapi_robot_sendmsg` - Send robot messages
- `qyapi_chat_manage` - Manage group chats

**AI Card Permissions (for streaming responses):**

- `Card.Instance.Write` - Create and update AI card instances
- `Card.Streaming.Write` - Stream write AI card content

**User Information Permissions:**

- `Contact.User.Read` - Read user information
- `Contact.User.mobile` - Access user mobile (optional)

> 💡 **Note**: AI Card permissions are required for streaming response effects. Without these permissions, the bot will not be able to use AI Card features and will fall back to plain text message mode.

---

## 📝 Step 3: Get Application Credentials

1. In your application settings, navigate to **Credentials and Basic Info**
2. Copy the following values:
   - **Client ID** (AppKey)
   - **Client Secret** (AppSecret)

> ⚠️ **Security Note**: Keep your Client Secret secure. Never share it or commit it to version control.

---

## 🔄 Step 4: Enable Message Stream Mode

1. In application settings, go to **Robot Configuration**
2. Enable **Message Receiving Mode**: Stream Mode
3. This allows Wegent to receive messages via WebSocket without configuring callback URLs

---

## ⚙️ Step 5: Configure IM Channel in Wegent

1. Log in to Wegent as an administrator
2. Navigate to **Admin Panel** → **IM Channels**
3. Click **Add Channel**
4. Fill in the configuration:

| Field                                 | Description                                               | Example                            |
| ------------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| **Channel Name**                      | Display name for this channel                             | "DingTalk Bot"                     |
| **Channel Type**                      | Select platform                                           | DingTalk                           |
| **Client ID**                         | From Step 3                                               | `dingxxxxxxxx`                     |
| **Client Secret**                     | From Step 3                                               | `xxxxxxxxxxxxxxxx`                 |
| **Default Agent**                     | Agent to handle messages                                  | Select from list                   |
| **Default Model**                     | Override model (optional)                                 | Leave empty to use agent's default |
| **Enable AI Card**                    | Use streaming AI Card                                     | ✅ Recommended                     |
| **Conversation Card Template ID**     | Show a Session Settings action after an answer (optional) | `xxxxxxxx.schema`                  |
| **Session Settings Card Template ID** | Clickable model, device, and task selection (optional)    | `xxxxxxxx.schema`                  |

5. Click **Save** to create the channel
6. Toggle **Enable** to activate the channel

---

## ✔️ Step 6: Verify Connection

1. Check the channel status in the IM Channels list
2. Status should show **Connected** (green indicator)
3. View uptime and last error information if available

---

## 🧪 Step 7: Test the Integration

1. Open DingTalk and find your bot
2. Send a test message: "Hello"
3. Verify you receive an AI response

---

## 🎨 DingTalk-Specific Features

### Group Chat Bot

Add the bot to DingTalk group chats:

1. In the group chat, click **Group Settings** → **Smart Group Assistant**
2. Click **Add Robot**
3. Select your created robot
4. The bot can now respond to @mentions in the group chat

### Direct Message Bot

Users can chat with the bot directly:

1. Search for the bot name in DingTalk
2. Click on the bot card
3. Start the conversation

### AI Card Streaming

DingTalk AI Cards provide a rich streaming response experience:

- Display masked, bounded progress summaries while a task is running
- Replace progress with the final answer when execution completes
- Keep tool arguments, tool output, and private model reasoning out of the card
- Support Markdown formatting
- Code block syntax highlighting
- Collapsible long content

### Clickable session settings

After configuring the **Session Settings Card Template ID**, users can send `设置` to open the console, `切模型` or `切设备` to open a selector, and `切任务` in a direct message to select a task. The existing `/status`, `/models`, `/devices`, and `/switch` commands remain available. Commands with arguments still use their text flow, and a card creation failure falls back to the original text response.

The console displays the current model, device, and direct-message task:

- Selecting an option applies it immediately and returns the same card to the console.
- Each page contains up to eight options, with previous, next, refresh, back, and close actions.
- Offline devices, current options, and non-Claude models that are incompatible with device mode are disabled.
- Tasks are available only in direct messages and include the user's five most recent Wework tasks.
- In a group, only the user who opened the card can act on it. The server also revalidates identity, ownership, and current availability.
- Cards contain random 15-minute option tokens rather than internal model, device, or task IDs. Repeated clicks are applied only once.

When the **Conversation Card Template ID** is also configured, completed, failed, and cancelled answers show a Session Settings action on the answer card. Configuring only the conversation template does not replace the built-in answer card, which prevents a non-functional action.

#### Create the two DingTalk card templates

Create two IM card templates in DingTalk Card Platform, then configure their variables, visibility conditions, and request actions according to these contracts:

- [Conversation answer card contract](../../../../examples/dingtalk-conversation-card-contract.json)
- [Session settings card contract](../../../../examples/dingtalk-session-settings-card-contract.json)

The conversation card's `content` must use an AI Markdown streaming component that supports `flowStatus`. Its settings button sends the fixed parameter `action=open_console`. The settings card uses a loop container for `options`; each row action must send that row's `token`, never an internal resource ID. Use server request actions and select **Stream** as the callback mode.

After publishing both templates, enter their `.schema` template IDs in Wegent Admin and restart the IM channel. The settings template works by itself; the answer-card entry requires both IDs.

> Only one Stream consumer may use the same Client ID and Client Secret at a time. Use separate development-app credentials for live testing so another instance cannot consume the card callback.

---

## ❓ Troubleshooting

### Connection Issues

#### Channel shows "Disconnected"

**Possible causes:**

1. Invalid Client ID or Client Secret
2. Network connectivity issues
3. DingTalk API service disruption

**Solutions:**

1. Verify credentials in DingTalk Open Platform
2. Check network connectivity from Wegent server
3. Try restarting the channel
4. Check DingTalk service status

#### Messages not being received

**Possible causes:**

1. Stream mode not enabled in DingTalk
2. Robot permissions not configured
3. Channel not enabled in Wegent

**Solutions:**

1. Verify Stream Mode is enabled in DingTalk app settings
2. Check all required permissions are granted
3. Ensure channel is enabled (toggle is on)

### Response Issues

#### Bot not responding

**Possible causes:**

1. Default Agent not configured
2. Agent has no model assigned
3. Rate limiting

**Solutions:**

1. Verify a default Agent is selected for the channel
2. Ensure the Agent has a working model configuration
3. Check for rate limit errors in channel status

#### Slow or incomplete responses

**Possible causes:**

1. AI Card streaming issues
2. Network latency
3. Large response content

**Solutions:**

1. Try disabling AI Card streaming temporarily
2. Check network connectivity
3. The system will fall back to sync mode if streaming fails

#### Card clicks do not respond

**Possible causes:**

1. The settings card callback mode is not Stream
2. Template action parameters do not match the contract
3. Card creation and Stream callback registration use different Client IDs
4. Multiple Stream consumers use the same application credentials

**Solutions:**

1. Verify every template variable and request action against the contract
2. Restart the Wegent channel and confirm the settings card is reported as configured
3. Use the same Client ID for card creation and callback registration
4. Stop other Stream instances using the same credentials and test again

### User Issues

#### User not recognized

**Possible causes:**

1. User mapping configuration issues
2. DingTalk user info not accessible

**Solutions:**

1. Check user permissions in DingTalk app
2. Verify user mapping configuration
3. Contact administrator for enterprise user mapping

#### User creation failed

**Possible causes:**

1. Missing `Contact.User.Read` permission
2. Failed to retrieve DingTalk staff ID

**Solutions:**

1. Ensure permission to read user information is granted
2. Re-authorize application permissions
3. Check if DingTalk user is in the enterprise organization

---

## 🔗 Related Resources

### Wegent Documentation

- [IM Channel Integration Overview](./im-channel-integration.md) - General IM integration concepts and features
- [Agent Settings](../settings/agent-settings.md) - Configure agents for IM channels
- [Configuring Models](../settings/configuring-models.md) - Set up AI models

### DingTalk Official Resources

- [DingTalk Open Platform Documentation](https://open.dingtalk.com/document/)
- [DingTalk Stream Mode Guide](https://open.dingtalk.com/document/orgapp/receive-message)
- [DingTalk Robot Development Guide](https://open.dingtalk.com/document/robots/develop-robots)
- [Enterprise Application Development Guide](https://open.dingtalk.com/document/isvapp-server/create-an-application)

### Get Help

- 📖 Check [Wegent FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 DingTalk Open Platform Technical Support

---

<p align="center">Connect your AI agents to DingTalk and empower your team! 🚀</p>
