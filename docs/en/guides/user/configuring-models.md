# 🧠 Model Configuration Guide

A Model in Wegent defines the AI model configuration, specifying which AI service to use, how to authenticate, and which model to employ. This guide will help you configure models through the Web interface.

---

## 📋 Table of Contents

- [What is a Model](#-what-is-a-model)
- [Model Selection Guide](#-model-selection-guide)
- [Configuring Models via Web Interface](#-configuring-models-via-web-interface)
- [API Key Acquisition](#-api-key-acquisition)
- [Testing Model Connection](#-testing-model-connection)
- [Using Models in Bots](#-using-models-in-bots)
- [Frequently Asked Questions](#-frequently-asked-questions)

---

## 🎯 What is a Model

A Model is the "brain" of a Bot, determining which AI model the Bot uses for thinking and reasoning.

### Position in Architecture

```
Agent (Team) = Bot(s) + Collaboration Mode
Bot = Executor (Shell) + Model (Brain) + Prompt (Personality)
```

**Analogy**:
- **Executor (Shell)**: The runtime environment (ClaudeCode, Agno, Dify, Chat)
- **Model**: The AI brain (Claude, GPT-4, Gemini)
- **Prompt**: The personality and expertise

### Model Types

Wegent supports multiple model types:

| Type | Description | Use Cases |
|------|-------------|-----------|
| **LLM** | Large Language Models for chat and code | General AI tasks, coding |
| **Embedding** | Text embedding models | Knowledge base, RAG |
| **Rerank** | Reranking models | Search result optimization |

---

## 📊 Model Selection Guide

### Anthropic Claude Series (Recommended for Code)

| Model | Speed | Cost | Capability | Best For |
|-------|-------|------|------------|----------|
| **Claude Haiku 4.5** | ⚡⚡⚡ Fast | 💰 Low | ⭐⭐ Basic | Simple tasks, documentation |
| **Claude Sonnet 4** | ⚡⚡ Medium | 💰💰 Medium | ⭐⭐⭐⭐ Strong | Daily development (Recommended) |
| **Claude Opus 4** | ⚡ Slow | 💰💰💰 High | ⭐⭐⭐⭐⭐ Strongest | Complex architecture |

### OpenAI GPT Series

| Model | Speed | Cost | Capability | Best For |
|-------|-------|------|------------|----------|
| **GPT-4o** | ⚡⚡ Medium | 💰💰 Medium | ⭐⭐⭐⭐ Strong | General tasks (Recommended) |
| **GPT-4 Turbo** | ⚡⚡ Medium | 💰💰 Medium | ⭐⭐⭐⭐ Strong | Complex reasoning |
| **GPT-3.5 Turbo** | ⚡⚡⚡ Fast | 💰 Low | ⭐⭐⭐ Medium | Quick prototyping |

### Google Gemini Series

| Model | Speed | Cost | Capability | Best For |
|-------|-------|------|------------|----------|
| **Gemini 3 Pro** | ⚡⚡ Medium | 💰💰 Medium | ⭐⭐⭐⭐ Strong | Multimodal tasks |
| **Gemini 2.5 Flash** | ⚡⚡⚡ Fast | 💰 Low | ⭐⭐⭐ Medium | Quick responses |

### Recommendations by Task Type

| Task Type | Recommended Model | Alternative |
|-----------|-------------------|-------------|
| **Daily Development** | Claude Sonnet 4 | GPT-4o |
| **Simple Tasks** | Claude Haiku 4.5 | GPT-3.5 Turbo |
| **Code Review** | Claude Sonnet 4 | GPT-4o |
| **Complex Architecture** | Claude Opus 4 | GPT-4 |
| **Documentation** | Claude Haiku 4.5 | GPT-3.5 Turbo |

---

## 🚀 Configuring Models via Web Interface

### Step 1: Navigate to Model Settings

1. Log in to Wegent Web interface
2. Click **Settings** in the sidebar
3. Select the **Models** tab

You'll see a unified model list showing both public (system) and your personal models.

### Step 2: Create a New Model

1. Click the **Create Model** button
2. Fill in the model configuration form:

#### Basic Information

| Field | Required | Description |
|-------|----------|-------------|
| **Model Type** | Yes | Select: LLM, Embedding, or Rerank |
| **Model ID** | Yes | Unique identifier (lowercase, hyphens allowed) |
| **Display Name** | No | Human-readable name for the UI |

#### Provider Configuration

| Field | Required | Description |
|-------|----------|-------------|
| **Model Protocol** | Yes | OpenAI, Anthropic, Gemini, etc. |
| **Model ID** | Yes | Select from presets or enter custom |
| **API Key** | Yes | Your API key from the provider |
| **Base URL** | No | Custom endpoint (for proxies) |

### Step 3: Configure Model Details

**For LLM Models:**

```
Model Protocol: OpenAI / Anthropic / Gemini
Model ID: gpt-4o / claude-sonnet-4 / gemini-3-pro
API Key: sk-xxx... / sk-ant-xxx...
Base URL: (optional, for proxy services)
```

**For Embedding Models:**

```
Model Protocol: OpenAI / Cohere / Jina
Model ID: text-embedding-3-small
Dimensions: 1536 (optional)
```

**For Rerank Models:**

```
Model Protocol: Cohere / Jina
Model ID: rerank-english-v3.0
Top N: 10 (optional)
```

### Step 4: Test Connection

Before saving, click **Test Connection** to verify:
- ✅ API Key validity
- ✅ Model availability
- ✅ Network connectivity

### Step 5: Save Configuration

Click **Save** to create the model. It will appear in your model list and can be used in Bot configurations.

---

## 🔑 API Key Acquisition

### Anthropic API Key

1. Visit [Anthropic Console](https://console.anthropic.com/settings/keys)
2. Log in or create an account
3. Click **Create Key**
4. Copy and save the key (format: `sk-ant-api03-xxx...`)

⚠️ **Important**: API Key is only shown once!

### OpenAI API Key

1. Visit [OpenAI Platform](https://platform.openai.com/api-keys)
2. Log in or create an account
3. Click **Create new secret key**
4. Copy and save the key (format: `sk-xxx...`)

### Google Gemini API Key

1. Visit [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Log in with your Google account
3. Click **Create API Key**
4. Copy and save the key (format: `AIza...`)

### Security Best Practices

✅ **Do:**
- Store keys in environment variables
- Use key management services for production
- Rotate keys regularly
- Limit access to authorized team members

❌ **Don't:**
- Commit keys to Git repositories
- Share keys in public places
- Write keys in frontend code
- Store keys in plain text files

---

## 🔄 Testing Model Connection

### Via Web Interface

1. In the Model Edit dialog, fill in all required fields
2. Click the **Test Connection** button
3. Check the result:
   - ✅ "Successfully connected" - Configuration is valid
   - ❌ Error message - Check your settings

### Common Test Errors

| Error | Cause | Solution |
|-------|-------|----------|
| **401 Unauthorized** | Invalid API Key | Regenerate and update key |
| **404 Not Found** | Wrong model ID | Check model name spelling |
| **429 Rate Limit** | Too many requests | Wait and retry |
| **Network Error** | Connection issue | Check network/proxy settings |

---

## 🤖 Using Models in Bots

### Method 1: Select from Dropdown (Recommended)

When creating or editing a Bot:

1. In the **Bind Model** section, keep "Advanced Mode" OFF
2. Select a model from the dropdown list
3. The dropdown shows both public and your personal models

### Method 2: Advanced Mode (Custom Configuration)

For custom model configurations:

1. Toggle **Advanced Mode** ON
2. Select the **Model Protocol** (OpenAI/Claude/Gemini)
3. Enter the JSON configuration:

```json
{
  "env": {
    "model": "openai",
    "model_id": "gpt-4o",
    "api_key": "sk-xxx...",
    "base_url": "https://api.openai.com/v1"
  }
}
```

### Per-Task Model Override

When sending a task, you can override the Bot's default model:

1. In the chat input area, click the **Model** selector
2. Choose a different model
3. Optionally enable **Force Override** to ensure your selection is used

---

## ⚠️ Frequently Asked Questions

### Q1: What's the difference between public and personal models?

| Type | Description | Visibility |
|------|-------------|------------|
| **Public** | System-provided models | All users |
| **Personal** | Your custom configurations | Only you |

Personal models take priority when names conflict.

### Q2: How do I use a proxy service?

Set the **Base URL** field to your proxy endpoint:

```
OpenRouter: https://openrouter.ai/api/v1
Custom Proxy: https://your-proxy.example.com
```

### Q3: Why can't I see my model in the Bot dropdown?

Check:
1. Model status is "Available"
2. Model type matches the executor (e.g., Anthropic for ClaudeCode)
3. Model is an LLM type (not Embedding/Rerank)

### Q4: How do I control costs?

**Strategy 1: Use appropriate models**
- Simple tasks → Claude Haiku / GPT-3.5
- Complex tasks → Claude Sonnet / GPT-4o

**Strategy 2: Set usage limits**
- Configure limits in your API provider's console
- Monitor usage regularly

### Q5: Can I use the same API key for multiple models?

Yes! You can create multiple model configurations with the same API key but different model IDs.

---

## 🔗 Related Resources

### Next Steps
- [Agent Settings](./agent-settings.md) - Configure agents and bots with models

### Reference
- [Anthropic API Docs](https://docs.anthropic.com/claude/reference)
- [OpenAI API Docs](https://platform.openai.com/docs/api-reference)
- [Google AI Docs](https://ai.google.dev/docs)

---

## 💬 Get Help

Need assistance?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/anthropics/anthropic-cookbook/issues)
- 💬 Join community discussions

---

<p align="center">Configure your models and power up your AI agents! 🚀</p>
