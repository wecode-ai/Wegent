# 🧠 Model Configuration Guide

A Model in Wegent defines the AI model configuration parameters, specifying which AI service a Bot uses, how it authenticates, and which model it employs. This guide will help you complete the full configuration and validation of a Model.

---

## 📋 Table of Contents

- [What is a Model](#-what-is-a-model)
- [Model Selection Guide](#-model-selection-guide)
- [API Key Acquisition Tutorial](#-api-key-acquisition-tutorial)
- [Environment Variables Explained](#-environment-variables-explained)
- [Configuration Steps](#-configuration-steps)
- [Configuration Validation](#-configuration-validation)
- [Complete Configuration Examples](#-complete-configuration-examples)
- [Frequently Asked Questions](#-frequently-asked-questions)
- [Related Resources](#-related-resources)

---

## 🎯 What is a Model

A Model is the "brain" of a Bot, determining which AI model the Bot uses for thinking and reasoning.

### Position in Bot Architecture

```
Bot = Ghost (Soul) + Shell (Body) + Model (Brain)
```

**Analogy**:
- **Ghost**: A person's personality and expertise
- **Shell**: A person's body and hands
- **Model**: A person's brain (strength of thinking ability)

### Relationship Between Model and Shell

```
Shell (Execution Environment) + Model (AI Model) = Complete Intelligence

Shell determines "what can be done"
Model determines "how strong the thinking ability is"
```

### Relationship with Database

Model resources are stored in the following database tables:
- `public_models`: Stores Model configuration information
- `kinds`: Defines the resource type as `Model`

---

## 📊 Model Selection Guide

### Anthropic Claude Series (Recommended)

#### Claude Haiku 4

**Characteristics**:
- ⚡ Fastest response speed
- 💰 Lowest cost
- ⭐⭐ Basic but sufficient capability

**Use Cases**:
- Simple code modifications and formatting
- Documentation writing
- Quick Q&A
- Daily simple tasks

**Recommendation**: ⭐⭐⭐⭐ (Cost-sensitive tasks)

#### Claude Sonnet 4 (Most Recommended)

**Characteristics**:
- ⚡⚡ Medium response speed
- 💰💰 Moderate cost
- ⭐⭐⭐⭐ Powerful capability

**Use Cases**:
- Regular code development
- Code review
- Feature implementation
- Test writing
- Most development tasks

**Recommendation**: ⭐⭐⭐⭐⭐ (Best balanced choice)

#### Claude Opus

**Characteristics**:
- ⚡ Slower response
- 💰💰💰 Highest cost
- ⭐⭐⭐⭐⭐ Most powerful capability

**Use Cases**:
- Complex architecture design
- Algorithm optimization
- System-level refactoring
- Tasks requiring deep reasoning

**Recommendation**: ⭐⭐⭐ (Only for complex tasks)

### OpenAI GPT Series

#### GPT-4

**Characteristics**:
- ⚡⚡ Medium response speed
- 💰💰💰 Higher cost
- ⭐⭐⭐⭐⭐ Powerful capability

**Use Cases**:
- Complex reasoning tasks
- Multi-step problem solving
- Creative work

**Recommendation**: ⭐⭐⭐⭐

#### GPT-3.5 Turbo

**Characteristics**:
- ⚡⚡⚡ Fast response speed
- 💰 Low cost
- ⭐⭐⭐ Medium capability

**Use Cases**:
- Simple conversations
- Basic code generation
- Quick prototyping

**Recommendation**: ⭐⭐⭐

### Model Recommendations by Task Type

| Task Type | Recommended Model | Alternative Model |
|---------|---------|---------|
| **Daily Development** | Claude Sonnet 4 | GPT-4 |
| **Simple Tasks** | Claude Haiku 4 | GPT-3.5 Turbo |
| **Code Review** | Claude Sonnet 4 | GPT-4 |
| **Complex Architecture** | Claude Opus | GPT-4 |
| **Documentation Writing** | Claude Haiku 4 | Claude Sonnet 4 |
| **Test Writing** | Claude Sonnet 4 | Claude Haiku 4 |

---

## 🔑 API Key Acquisition Tutorial

### Anthropic API Key Acquisition

#### Step 1: Visit Anthropic Console

Visit the official site: https://console.anthropic.com/settings/keys

<!-- TODO: Add screenshot - Anthropic Console login page -->

#### Step 2: Register or Log In

- If you already have an account, log in directly
- If you don't have an account, click "Sign Up" to register a new account

#### Step 3: Create API Key

1. After logging in, go to the "API Keys" page
2. Click the "Create Key" button
3. Name the API Key (e.g., "Wegent Development")
4. Click "Create" to create

<!-- TODO: Add screenshot - API Key creation interface -->

#### Step 4: Save API Key

⚠️ **Important**: API Key will only be displayed once!

- Copy and save it to a secure location immediately
- API Key format example: `sk-ant-api03-xxxxxxxxxxxxx`

#### API Key Format Description

**Correct Format**: Starts with `sk-ant-`
```
sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Official Link**: https://console.anthropic.com/settings/keys

---

### OpenAI API Key Acquisition

#### Step 1: Visit OpenAI Platform

Visit the official site: https://platform.openai.com/api-keys

<!-- TODO: Add screenshot - OpenAI Platform login page -->

#### Step 2: Register or Log In

- If you already have an account, log in directly
- If you don't have an account, click "Sign up" to register a new account

#### Step 3: Create API Key

1. After logging in, go to the "API keys" page
2. Click the "Create new secret key" button
3. Name the API Key (e.g., "Wegent Bot")
4. Select permissions (usually select "All")
5. Click "Create secret key" to create

<!-- TODO: Add screenshot - OpenAI API Key creation interface -->

#### Step 4: Save API Key

⚠️ **Important**: API Key will only be displayed once!

- Copy and save it to a secure location immediately
- API Key format example: `sk-xxxxxxxxxxxxxxxxxxxxx`

#### API Key Format Description

**Correct Format**: Starts with `sk-`
```
sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**Official Link**: https://platform.openai.com/api-keys

---

### API Key Secure Storage Recommendations

#### ✅ Recommended Practices

1. **Use Environment Variable Management**
   - Don't write directly in code
   - Use `.env` file (but don't commit to Git)

2. **Use Key Management Services**
   - AWS Secrets Manager
   - Azure Key Vault
   - HashiCorp Vault

3. **Limit Access Permissions**
   - Only authorize necessary team members
   - Regularly rotate API Keys

#### ❌ Avoid Practices

1. ❌ Don't commit to Git repository
2. ❌ Don't share in public places
3. ❌ Don't write in frontend code
4. ❌ Don't store in plain text

---

## 🔧 Environment Variables Explained

### ClaudeCode Runtime - Anthropic Model Environment Variables

When running Anthropic Claude models with ClaudeCode Shell, you need to configure the following environment variables:

#### Complete Variable Table

| Variable Name | Description | Example Value | Required |
|--------|------|--------|------|
| `ANTHROPIC_MODEL` | Primary model configuration, format as `provider,model-name` or directly `model-name` | `anthropic/claude-sonnet-4` or `claude-4.1-opus` | Yes |
| `ANTHROPIC_AUTH_TOKEN` | Authentication token, obtained from Anthropic Console | `sk-ant-api03-xxxx...` | Yes* |
| `ANTHROPIC_API_KEY` | Authentication key, used by some runtimes | `sk-ant-api03-xxxx...` | Yes* |
| `ANTHROPIC_BASE_URL` | API base URL, defaults to official API | `https://api.anthropic.com` | No |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Fast model configuration, used for simple tasks to reduce cost | `anthropic/claude-haiku-4.5` | No |

**Note**:
- `*` indicates that at least one of `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` is required
- It's recommended to configure both for compatibility with different runtime versions

#### Detailed Field Descriptions

##### 1. ANTHROPIC_MODEL (Required)

**Purpose**: Specifies the primary Claude model to use

**Format Options**:
- Method 1: `provider,model-name` (recommended)
  ```json
  "ANTHROPIC_MODEL": "anthropic,claude-sonnet-4"
  ```

- Method 2: `provider/model-name`
  ```json
  "ANTHROPIC_MODEL": "anthropic/claude-sonnet-4"
  ```

- Method 3: Direct model name
  ```json
  "ANTHROPIC_MODEL": "claude-sonnet-4"
  ```

**Available Model Names**:
- `claude-sonnet-4` - Claude Sonnet 4 (recommended)
- `claude-haiku-4.5` - Claude Haiku 4.5
- `claude-4.1-opus` - Claude Opus (if available)

##### 2. ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY (One Required)

**Purpose**: Provides API authentication credentials

**Acquisition Method**: Create from https://console.anthropic.com/settings/keys

**Format**: String starting with `sk-ant-`

**Example**:
```json
"ANTHROPIC_AUTH_TOKEN": "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
"ANTHROPIC_API_KEY": "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**Best Practice**: Configure both variables
```json
{
  "ANTHROPIC_AUTH_TOKEN": "sk-ant-api03-xxxx",
  "ANTHROPIC_API_KEY": "sk-ant-api03-xxxx"
}
```

##### 3. ANTHROPIC_BASE_URL (Optional)

**Purpose**: Specifies the base URL for the API

**Default Value**: `https://api.anthropic.com`

**Use Cases**:
- When using a proxy service
- Using self-hosted API gateway
- Using third-party API forwarding service (like OpenRouter)

**Examples**:
```json
// Official API (default)
"ANTHROPIC_BASE_URL": "https://api.anthropic.com"

// Using OpenRouter
"ANTHROPIC_BASE_URL": "https://openrouter.ai/api/v1"

// Custom proxy
"ANTHROPIC_BASE_URL": "https://your-proxy.example.com"
```

##### 4. ANTHROPIC_DEFAULT_HAIKU_MODEL (Optional but Recommended)

**Purpose**: Specifies a fast model for simple tasks to reduce costs

**Recommended Value**: `anthropic/claude-haiku-4.5`

**Use Cases**:
- System automatically uses this model for simple tasks
- Reduces overall API call costs
- Improves response speed

**Example**:
```json
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4.5"
```

---

### OpenAI Model Environment Variables

When using OpenAI GPT models, you need to configure the following environment variables:

#### Complete Variable Table

| Variable Name | Description | Example Value | Required |
|--------|------|--------|------|
| `OPENAI_API_KEY` | OpenAI API key | `sk-xxxxxxxxxxxxxxxx` | Yes |
| `OPENAI_MODEL` | Model name | `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo` | Yes |
| `OPENAI_BASE_URL` | API base URL, defaults to official API | `https://api.openai.com/v1` | No |

#### Detailed Field Descriptions

##### 1. OPENAI_API_KEY (Required)

**Purpose**: Provides OpenAI API authentication credentials

**Acquisition Method**: Create from https://platform.openai.com/api-keys

**Format**: String starting with `sk-`

**Example**:
```json
"OPENAI_API_KEY": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

##### 2. OPENAI_MODEL (Required)

**Purpose**: Specifies the GPT model to use

**Available Models**:
- `gpt-4` - GPT-4 (powerful, high cost)
- `gpt-4-turbo` - GPT-4 Turbo (faster, lower cost)
- `gpt-3.5-turbo` - GPT-3.5 Turbo (fast, low cost)

**Example**:
```json
"OPENAI_MODEL": "gpt-4"
```

##### 3. OPENAI_BASE_URL (Optional)

**Purpose**: Specifies the base URL for the API

**Default Value**: `https://api.openai.com/v1`

**Use Cases**:
- Using Azure OpenAI Service
- Using proxy service
- Using third-party API forwarding service

**Examples**:
```json
// Official API (default)
"OPENAI_BASE_URL": "https://api.openai.com/v1"

// Azure OpenAI
"OPENAI_BASE_URL": "https://your-resource.openai.azure.com"

// Custom proxy
"OPENAI_BASE_URL": "https://your-proxy.example.com/v1"
```

---

## 🚀 Configuration Steps

### Method 1: Configure via Web Interface (Recommended for Beginners)

#### Step 1: Go to Model Configuration Page

1. Log in to Wegent Web interface (http://localhost:3000)
2. Go to **Resource Management** → **Model Configuration**
3. Click **Create New Model** button

<!-- TODO: Add screenshot - Model configuration page -->

#### Step 2: Use Preset Template (Recommended)

Above the JSON configuration input box, you will see a "Quick Configuration" area:

📋 **Use Preset Templates for Quick Configuration**

- Click **[Claude Sonnet 4 Template]** button (primary recommendation)
- Or click **[OpenAI GPT-4 Template]** button (alternative)

Clicking will automatically fill the complete JSON configuration into the input box.

#### Step 3: Modify API Key

⚠️ **Important**: Please replace the API Key in the configuration with your actual key

The API Key in the template is a placeholder, you need to:
1. Find the `ANTHROPIC_AUTH_TOKEN` or `OPENAI_API_KEY` field in the configuration
2. Replace the value with your real API Key obtained from the official site
3. If it's an Anthropic model, it's recommended to also modify `ANTHROPIC_API_KEY`

#### Step 4: Fill in Other Fields

- **Name**: Give the Model a descriptive name (e.g., `claude-sonnet-4-prod`)
- **Namespace**: Usually use `default`
- **JSON Configuration**: Already filled via template, just need to modify API Key

#### Step 5: Submit Configuration

Click the **Submit** button to create the Model.

The system will validate the configuration format and will prompt if there are errors.

---

### Method 2: Configure via YAML File

#### Step 1: Create YAML File

Create a YAML configuration file, for example `my-model.yaml`

#### Step 2: Write Configuration

Refer to the "Complete Configuration Examples" section below to write the configuration content.

#### Step 3: Import Configuration

Import the YAML configuration via the Web interface or API.

---

## ✅ Configuration Validation

After configuring a Model, **validation is essential** to ensure the configuration is correct and avoid errors during subsequent use.

### Validation Method 1: View Status via Web Interface

#### Step 1: Go to Model List

1. Log in to Wegent Web interface
2. Go to **Resource Management** → **Model Configuration**
3. View the Model list

#### Step 2: Check Status

- ✅ Status shows `Available`: Configuration is correct, can be used
- ❌ Status shows `Unavailable`: Configuration has issues, needs troubleshooting

#### Step 3: View Configuration Details

Click the Model name to view detailed configuration, confirm:
- API Key is correct
- Model name is correct
- BASE_URL is correct (if using proxy)

<!-- TODO: Add screenshot - Model status display -->

---

### Validation Method 2: Create Test Bot

#### Step 1: Create Test Bot

Create a simple Bot using the newly configured Model:

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: test-bot
  namespace: default
spec:
  ghostRef:
    name: developer-ghost  # Use existing Ghost
    namespace: default
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: my-new-model  # Reference newly configured Model
    namespace: default
```

#### Step 2: Assign Simple Task

Assign a simple test task to the Bot, for example:

```
Please write a Python function to calculate the sum of two numbers.
```

#### Step 3: View Execution Result

- ✅ If task executes successfully, the Model configuration is correct
- ❌ If task fails, check error messages for troubleshooting

#### Step 4: View Task Logs

View execution logs in the task details page, confirm:
- API call is successful
- No authentication errors
- No model unavailable errors

---

### Validation Method 3: Test via API

#### Step 1: Access API Documentation

Visit: http://localhost:8000/api/docs

#### Step 2: Test Model Interface

1. Find Model-related API interface (e.g., `GET /api/v1/models`)
2. Click "Try it out"
3. Enter your Model name
4. Click "Execute" to execute request

#### Step 3: Check Response

- **Status Code 200**: Configuration is correct
- **Status Code 401**: Authentication failed, check API Key
- **Status Code 404**: Model doesn't exist, check name and namespace
- **Status Code 500**: Server error, check configuration format

#### Example: Successful Response

```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "Model",
  "metadata": {
    "name": "claude-sonnet-4",
    "namespace": "default"
  },
  "spec": {
    "env": {
      "ANTHROPIC_MODEL": "anthropic/claude-sonnet-4",
      "ANTHROPIC_AUTH_TOKEN": "sk-ant-***",
      "ANTHROPIC_API_KEY": "sk-ant-***",
      "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
    }
  },
  "status": {
    "state": "Available"
  }
}
```

---

### Validation Method 4: View Logs for Troubleshooting

If validation fails, view logs for troubleshooting:

#### View Backend Logs

```bash
docker-compose logs backend
```

#### View Executor Logs

```bash
docker-compose logs executor_manager
```

#### Common Error Codes and Solutions

| Error Code | Error Message | Reason | Solution |
|--------|---------|------|---------|
| **401** | `Unauthorized` / `Invalid API Key` | API Key invalid or expired | 1. Check if API Key format is correct<br>2. Regenerate API Key<br>3. Confirm API Key is activated |
| **429** | `Too Many Requests` / `Rate Limit Exceeded` | Rate limit exceeded | 1. Wait for some time and retry<br>2. Check if other programs are using the same API Key<br>3. Upgrade API plan |
| **500** | `Internal Server Error` | Configuration format error or server internal error | 1. Check if JSON format is correct<br>2. Check environment variable name spelling<br>3. View backend logs for detailed error information |
| **404** | `Model not found` | Model name doesn't exist | 1. Check model name spelling<br>2. Confirm model is available at API provider<br>3. Refer to official documentation to confirm model name |

#### Debugging Steps

1. **Check API Key Format**
   ```bash
   # Anthropic API Key should start with sk-ant-
   echo $ANTHROPIC_AUTH_TOKEN | grep "^sk-ant-"

   # OpenAI API Key should start with sk-
   echo $OPENAI_API_KEY | grep "^sk-"
   ```

2. **Test API Connection**
   ```bash
   # Test Anthropic API
   curl https://api.anthropic.com/v1/messages \
     -H "x-api-key: YOUR_API_KEY" \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -d '{
       "model": "claude-sonnet-4",
       "max_tokens": 1024,
       "messages": [{"role": "user", "content": "Hello"}]
     }'
   ```

3. **Check Configuration File Format**
   - Use JSON/YAML validator to check format
   - Ensure no extra commas or quotes
   - Ensure all field names are spelled correctly

---

## 💡 Complete Configuration Examples

### Example 1: Claude Sonnet 4 Complete Configuration (Recommended)

#### YAML Format

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: claude-sonnet-4
  namespace: default
spec:
  env:
    # Primary model configuration - Claude Sonnet 4
    ANTHROPIC_MODEL: "anthropic/claude-sonnet-4"

    # API authentication token (required, obtained from Anthropic Console)
    ANTHROPIC_AUTH_TOKEN: "sk-ant-api03-your-api-key-here"

    # API key (recommended, compatible with different runtimes)
    ANTHROPIC_API_KEY: "sk-ant-api03-your-api-key-here"

    # API base URL (optional, defaults to official API)
    ANTHROPIC_BASE_URL: "https://api.anthropic.com"

    # Fast model configuration (optional but recommended, for simple tasks to reduce cost)
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5"
status:
  state: "Available"
```

#### JSON Format (Used in Web Interface)

```json
{
  "env": {
    "ANTHROPIC_MODEL": "anthropic/claude-sonnet-4",
    "ANTHROPIC_AUTH_TOKEN": "sk-ant-api03-your-api-key-here",
    "ANTHROPIC_API_KEY": "sk-ant-api03-your-api-key-here",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4.5"
  }
}
```

**Use Cases**:
- Daily development tasks
- Code review
- Feature implementation
- Best balance of performance and cost

---

### Example 2: Claude Haiku 4 Complete Configuration (Economy)

#### YAML Format

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: claude-haiku-4
  namespace: default
spec:
  env:
    # Primary model configuration - Claude Haiku 4.5
    ANTHROPIC_MODEL: "anthropic/claude-haiku-4.5"

    # API authentication
    ANTHROPIC_AUTH_TOKEN: "sk-ant-api03-your-api-key-here"
    ANTHROPIC_API_KEY: "sk-ant-api03-your-api-key-here"

    # API base URL
    ANTHROPIC_BASE_URL: "https://api.anthropic.com"
status:
  state: "Available"
```

#### JSON Format

```json
{
  "env": {
    "ANTHROPIC_MODEL": "anthropic/claude-haiku-4.5",
    "ANTHROPIC_AUTH_TOKEN": "sk-ant-api03-your-api-key-here",
    "ANTHROPIC_API_KEY": "sk-ant-api03-your-api-key-here",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com"
  }
}
```

**Use Cases**:
- Simple code modifications
- Documentation writing
- Formatting tasks
- Cost-sensitive scenarios

---

### Example 3: OpenAI GPT-4 Complete Configuration

#### YAML Format

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: gpt-4
  namespace: default
spec:
  env:
    # OpenAI API key (required)
    OPENAI_API_KEY: "sk-your-openai-api-key-here"

    # Model name (required)
    OPENAI_MODEL: "gpt-4"

    # API base URL (optional, defaults to official API)
    OPENAI_BASE_URL: "https://api.openai.com/v1"
status:
  state: "Available"
```

#### JSON Format

```json
{
  "env": {
    "OPENAI_API_KEY": "sk-your-openai-api-key-here",
    "OPENAI_MODEL": "gpt-4",
    "OPENAI_BASE_URL": "https://api.openai.com/v1"
  }
}
```

**Use Cases**:
- Complex reasoning tasks
- Scenarios requiring GPT-4 specific capabilities
- Users with existing OpenAI accounts

---

### Example 4: Multi-Model Coexistence Configuration

Multiple Model resources can be configured in the same Wegent system for use by different Bots:

```yaml
# Model 1: Fast economy type
---
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: fast-model
  namespace: default
spec:
  env:
    ANTHROPIC_MODEL: "anthropic/claude-haiku-4.5"
    ANTHROPIC_AUTH_TOKEN: "sk-ant-api03-your-key"
    ANTHROPIC_API_KEY: "sk-ant-api03-your-key"
    ANTHROPIC_BASE_URL: "https://api.anthropic.com"
status:
  state: "Available"

---
# Model 2: Standard development type
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: standard-model
  namespace: default
spec:
  env:
    ANTHROPIC_MODEL: "anthropic/claude-sonnet-4"
    ANTHROPIC_AUTH_TOKEN: "sk-ant-api03-your-key"
    ANTHROPIC_API_KEY: "sk-ant-api03-your-key"
    ANTHROPIC_BASE_URL: "https://api.anthropic.com"
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5"
status:
  state: "Available"

---
# Model 3: GPT-4 alternative
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: gpt4-model
  namespace: default
spec:
  env:
    OPENAI_API_KEY: "sk-your-openai-key"
    OPENAI_MODEL: "gpt-4"
    OPENAI_BASE_URL: "https://api.openai.com/v1"
status:
  state: "Available"
```

**Usage**:

```yaml
# Bot 1: Use fast model
kind: Bot
metadata:
  name: quick-bot
spec:
  modelRef:
    name: fast-model  # Reference Haiku
    namespace: default

---
# Bot 2: Use standard model
kind: Bot
metadata:
  name: developer-bot
spec:
  modelRef:
    name: standard-model  # Reference Sonnet
    namespace: default

---
# Bot 3: Use GPT-4
kind: Bot
metadata:
  name: gpt-bot
spec:
  modelRef:
    name: gpt4-model  # Reference GPT-4
    namespace: default
```

---

### Example 5: Configuration Using Proxy

If you're using an API proxy service (like OpenRouter), you need to modify the `BASE_URL`:

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: claude-via-proxy
  namespace: default
spec:
  env:
    ANTHROPIC_MODEL: "anthropic/claude-sonnet-4"
    ANTHROPIC_AUTH_TOKEN: "your-proxy-api-key"
    ANTHROPIC_API_KEY: "your-proxy-api-key"
    # Modify to proxy URL
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1"
status:
  state: "Available"
```

---

## ⚠️ Frequently Asked Questions

### Q1: What to do if API Key is invalid?

**Symptoms**:
- Bot task execution fails
- Error message contains "401 Unauthorized" or "Invalid API Key"

**Solution Steps**:

1. **Check API Key Format**
   - Anthropic: Should start with `sk-ant-`
   - OpenAI: Should start with `sk-`

2. **Regenerate API Key**
   - Visit Anthropic Console or OpenAI Platform
   - Delete old API Key
   - Create new API Key
   - Update Model configuration

3. **Check if API Key is Activated**
   - Confirm account status is normal
   - Confirm API Key is not deleted or disabled

4. **Check Variable Name Spelling**
   - `ANTHROPIC_AUTH_TOKEN` (not `ANTHROPIC_API_TOKEN`)
   - `ANTHROPIC_API_KEY` (not `ANTHROPIC_KEY`)

---

### Q2: How to troubleshoot model call failures?

**Troubleshooting Steps**:

1. **View Backend Logs**
   ```bash
   docker-compose logs backend | grep -i error
   ```

2. **View Executor Logs**
   ```bash
   docker-compose logs executor_manager | grep -i error
   ```

3. **Check Network Connection**
   ```bash
   # Test if Anthropic API is accessible
   curl -I https://api.anthropic.com

   # Test if OpenAI API is accessible
   curl -I https://api.openai.com
   ```

4. **Validate Configuration Format**
   - Use JSON/YAML validator to check format
   - Confirm no syntax errors

5. **Check Model Name**
   - Confirm model name spelling is correct
   - Refer to official documentation to confirm model availability

---

### Q3: Cost Control Recommendations

**Strategy 1: Use Different Models for Task Tiers**

```yaml
# Simple tasks use Haiku (cheap)
fast-bot → claude-haiku-4

# Regular tasks use Sonnet (balanced)
developer-bot → claude-sonnet-4

# Complex tasks use Opus (expensive but powerful)
expert-bot → claude-opus
```

**Strategy 2: Configure DEFAULT_HAIKU_MODEL**

The system automatically uses Haiku for simple tasks, reducing costs:

```json
{
  "ANTHROPIC_MODEL": "anthropic/claude-sonnet-4",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4.5"
}
```

**Strategy 3: Set API Usage Limits**

Set in the API provider's console:
- Monthly usage quota
- Daily usage quota
- Per-call token limit

**Strategy 4: Monitor Usage**

Regularly check:
- API usage statistics
- Cost reports
- Call frequency

---

### Q4: How to switch models?

**Method 1: Update Bot's modelRef**

```yaml
# Modify Bot configuration to reference a different Model
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: my-bot
spec:
  modelRef:
    name: claude-haiku-4  # Changed from Sonnet to Haiku
    namespace: default
```

**Method 2: Update Model Configuration**

```yaml
# Modify Model resource to change model version
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: my-model
spec:
  env:
    ANTHROPIC_MODEL: "anthropic/claude-sonnet-4"  # Changed from Haiku to Sonnet
```

**Note**: Method 2 will affect all Bots using this Model.

---

### Q5: How to use the sample Models in initialization data?

Wegent may have already created some sample Model configurations during initialization.

**How to View**:

1. **Via Web Interface**
   - Go to **Resource Management** → **Model Configuration**
   - View existing Model list

2. **Check Initialization Scripts**
   - View `backend/init.sql` or related initialization files
   - View preset Model configurations

**How to Use**:

If you find a sample Model (e.g., `claude-model`):
1. View its configuration details
2. Copy configuration as a template
3. Modify API Key to your actual key
4. Create a new Model resource

**Don't directly modify sample Models**: It's recommended to create new Model resources to avoid affecting system default configurations.

---

### Q6: Which model providers are supported?

Currently Wegent primarily supports:

✅ **Anthropic Claude**
- Claude Haiku 4.5
- Claude Sonnet 4
- Claude Opus (if available)

✅ **OpenAI GPT**
- GPT-4
- GPT-4 Turbo
- GPT-3.5 Turbo

⚠️ **Other Providers** (may require custom configuration):
- Azure OpenAI
- Local models (via compatible API)
- Third-party API services (like OpenRouter)

---

### Q7: When does BASE_URL need to be modified?

**Scenarios Requiring Modification**:

1. **Using API Proxy**
   ```json
   "ANTHROPIC_BASE_URL": "https://your-proxy.example.com"
   ```

2. **Using OpenRouter**
   ```json
   "ANTHROPIC_BASE_URL": "https://openrouter.ai/api/v1"
   ```

3. **Using Azure OpenAI**
   ```json
   "OPENAI_BASE_URL": "https://your-resource.openai.azure.com"
   ```

4. **Enterprise Internal API Gateway**
   ```json
   "ANTHROPIC_BASE_URL": "https://internal-gateway.company.com"
   ```

**Scenarios Not Requiring Modification**:

- Directly using official Anthropic API
- Directly using official OpenAI API

---

## 🔗 Related Resources

### Related Configuration Guides
- [Shell (Executor) Complete Configuration Guide](./configuring-shells.md) - Configure runtime environment

### Next Steps
- [Creating Bots](./creating-bots.md) - Use Model to create complete Bot instances
- [Creating Ghosts](./creating-ghosts.md) - Define the "soul" of a Bot

### Reference Documentation
- [Core Concepts](../../concepts/core-concepts.md) - Understand Model's role in architecture
- [YAML Specification](../../reference/yaml-specification.md) - Complete configuration format

### Official Resources
- [Anthropic API Documentation](https://docs.anthropic.com/claude/reference/getting-started-with-the-api)
- [OpenAI API Documentation](https://platform.openai.com/docs/api-reference)
- [Anthropic Console](https://console.anthropic.com/settings/keys)
- [OpenAI Platform](https://platform.openai.com/api-keys)

---

## 💬 Get Help

Encountering issues?

- 📖 Check [FAQ](../../faq.md)
- 🐛 Submit [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 Join community discussions

---

<p align="center">Configure your Model and give your Bot powerful AI capabilities! 🚀</p>
