# 🧠 Model (模型) 配置指南

Model 是 Wegent 中 AI 模型的配置参数,定义了 Bot 使用哪个 AI 服务、如何认证以及使用什么模型。本指南将帮助您完成 Model 的完整配置和验证。

---

## 📋 目录

- [什么是 Model](#-什么是-model)
- [模型选择指南](#-模型选择指南)
- [API 密钥获取教程](#-api-密钥获取教程)
- [环境变量详解](#-环境变量详解)
- [配置步骤](#-配置步骤)
- [配置验证](#-配置验证)
- [完整配置示例](#-完整配置示例)
- [常见问题](#-常见问题)
- [相关资源](#-相关资源)

---

## 🎯 什么是 Model

Model 是 Bot 的"大脑",决定了 Bot 使用哪个 AI 模型进行思考和推理。

### Bot 架构中的位置

```
Bot = Ghost (灵魂) + Shell (身体) + Model (大脑)
```

**类比**:
- **Ghost**: 人的性格和专业知识
- **Shell**: 人的身体和手脚
- **Model**: 人的大脑(思考能力的强弱)

### Model 与 Shell 的关系

```
Shell (执行环境) + Model (AI 模型) = 完整的智能能力

Shell 决定"能做什么"
Model 决定"思考能力有多强"
```

### 与数据库的关系

Model 资源存储在数据库的以下表中:
- `public_models`: 存储 Model 配置信息
- `kinds`: 定义资源类型为 `Model`

---

## 📊 模型选择指南

### Anthropic Claude 系列 (推荐)

#### Claude Haiku 4

**特点**:
- ⚡ 响应速度最快
- 💰 成本最低
- ⭐⭐ 能力基础但够用

**适用场景**:
- 简单代码修改和格式化
- 文档编写
- 快速问答
- 日常简单任务

**推荐指数**: ⭐⭐⭐⭐ (成本敏感型任务)

#### Claude Sonnet 4 (最推荐)

**特点**:
- ⚡⚡ 响应速度中等
- 💰💰 成本适中
- ⭐⭐⭐⭐ 能力强大

**适用场景**:
- 常规代码开发
- 代码审查
- 功能实现
- 测试编写
- 大多数开发任务

**推荐指数**: ⭐⭐⭐⭐⭐ (最佳平衡选择)

#### Claude Opus

**特点**:
- ⚡ 响应较慢
- 💰💰💰 成本最高
- ⭐⭐⭐⭐⭐ 能力最强

**适用场景**:
- 复杂架构设计
- 算法优化
- 系统级重构
- 需要深度推理的任务

**推荐指数**: ⭐⭐⭐ (仅用于复杂任务)

### OpenAI GPT 系列

#### GPT-4

**特点**:
- ⚡⚡ 响应速度中等
- 💰💰💰 成本较高
- ⭐⭐⭐⭐⭐ 能力强大

**适用场景**:
- 复杂推理任务
- 多步骤问题解决
- 创意性工作

**推荐指数**: ⭐⭐⭐⭐

#### GPT-3.5 Turbo

**特点**:
- ⚡⚡⚡ 响应速度快
- 💰 成本低
- ⭐⭐⭐ 能力中等

**适用场景**:
- 简单对话
- 基础代码生成
- 快速原型

**推荐指数**: ⭐⭐⭐

### 不同任务场景的模型推荐

| 任务类型 | 推荐模型 | 备选模型 |
|---------|---------|---------|
| **日常开发** | Claude Sonnet 4 | GPT-4 |
| **简单任务** | Claude Haiku 4 | GPT-3.5 Turbo |
| **代码审查** | Claude Sonnet 4 | GPT-4 |
| **复杂架构** | Claude Opus | GPT-4 |
| **文档编写** | Claude Haiku 4 | Claude Sonnet 4 |
| **测试编写** | Claude Sonnet 4 | Claude Haiku 4 |

---

## 🔑 API 密钥获取教程

### Anthropic API Key 获取

#### 步骤 1: 访问 Anthropic Console

访问官网: https://console.anthropic.com/settings/keys

<!-- TODO: 添加截图 - Anthropic Console 登录页面 -->

#### 步骤 2: 注册或登录账号

- 如果已有账号,直接登录
- 如果没有账号,点击 "Sign Up" 注册新账号

#### 步骤 3: 创建 API Key

1. 登录后进入 "API Keys" 页面
2. 点击 "Create Key" 按钮
3. 给 API Key 命名 (如 "Wegent Development")
4. 点击 "Create" 创建

<!-- TODO: 添加截图 - API Key 创建界面 -->

#### 步骤 4: 保存 API Key

⚠️ **重要**: API Key 只会显示一次!

- 立即复制并保存到安全的地方
- API Key 格式示例: `sk-ant-api03-xxxxxxxxxxxxx`

#### API Key 格式说明

**正确格式**: 以 `sk-ant-` 开头
```
sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**官网链接**: https://console.anthropic.com/settings/keys

---

### OpenAI API Key 获取

#### 步骤 1: 访问 OpenAI Platform

访问官网: https://platform.openai.com/api-keys

<!-- TODO: 添加截图 - OpenAI Platform 登录页面 -->

#### 步骤 2: 注册或登录账号

- 如果已有账号,直接登录
- 如果没有账号,点击 "Sign up" 注册新账号

#### 步骤 3: 创建 API Key

1. 登录后进入 "API keys" 页面
2. 点击 "Create new secret key" 按钮
3. 给 API Key 命名 (如 "Wegent Bot")
4. 选择权限 (通常选择 "All")
5. 点击 "Create secret key" 创建

<!-- TODO: 添加截图 - OpenAI API Key 创建界面 -->

#### 步骤 4: 保存 API Key

⚠️ **重要**: API Key 只会显示一次!

- 立即复制并保存到安全的地方
- API Key 格式示例: `sk-xxxxxxxxxxxxxxxxxxxxx`

#### API Key 格式说明

**正确格式**: 以 `sk-` 开头
```
sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

**官网链接**: https://platform.openai.com/api-keys

---

### API Key 安全存储建议

#### ✅ 推荐做法

1. **使用环境变量管理**
   - 不要直接写在代码中
   - 使用 `.env` 文件 (但不要提交到 Git)

2. **使用密钥管理服务**
   - AWS Secrets Manager
   - Azure Key Vault
   - HashiCorp Vault

3. **限制访问权限**
   - 仅授权必要的团队成员
   - 定期轮换 API Key

#### ❌ 避免做法

1. ❌ 不要提交到 Git 仓库
2. ❌ 不要在公开场合分享
3. ❌ 不要写在前端代码中
4. ❌ 不要使用明文存储

---

## 🔧 环境变量详解

### ClaudeCode 运行时 - Anthropic 模型环境变量

使用 ClaudeCode Shell 运行 Anthropic Claude 模型时,需要配置以下环境变量:

#### 完整变量表

| 变量名 | 说明 | 示例值 | 必填 |
|--------|------|--------|------|
| `ANTHROPIC_MODEL` | 主要模型配置,格式为 `提供商,模型名` 或直接 `模型名` | `anthropic/claude-sonnet-4` 或 `claude-4.1-opus` | 是 |
| `ANTHROPIC_AUTH_TOKEN` | 认证令牌,从 Anthropic Console 获取 | `sk-ant-api03-xxxx...` | 是* |
| `ANTHROPIC_API_KEY` | 认证密钥,部分运行时使用此变量 | `sk-ant-api03-xxxx...` | 是* |
| `ANTHROPIC_BASE_URL` | API 基础 URL,默认为官方 API | `https://api.anthropic.com` | 否 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | 快速模型配置,用于简单任务以降低成本 | `anthropic/claude-haiku-4.5` | 否 |

**注意**:
- `*` 表示 `ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 至少需要一个
- 建议两者都配置,以兼容不同版本的运行时

#### 字段详细说明

##### 1. ANTHROPIC_MODEL (必填)

**作用**: 指定主要使用的 Claude 模型

**格式选项**:
- 方式 1: `提供商,模型名` (推荐)
  ```json
  "ANTHROPIC_MODEL": "anthropic,claude-sonnet-4"
  ```

- 方式 2: `提供商/模型名`
  ```json
  "ANTHROPIC_MODEL": "anthropic/claude-sonnet-4"
  ```

- 方式 3: 直接使用模型名
  ```json
  "ANTHROPIC_MODEL": "claude-sonnet-4"
  ```

**可用模型名称**:
- `claude-sonnet-4` - Claude Sonnet 4 (推荐)
- `claude-haiku-4.5` - Claude Haiku 4.5
- `claude-4.1-opus` - Claude Opus (如果可用)

##### 2. ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY (必填其一)

**作用**: 提供 API 认证凭证

**获取方式**: 从 https://console.anthropic.com/settings/keys 创建

**格式**: 以 `sk-ant-` 开头的字符串

**示例**:
```json
"ANTHROPIC_AUTH_TOKEN": "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
"ANTHROPIC_API_KEY": "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**最佳实践**: 同时配置两个变量
```json
{
  "ANTHROPIC_AUTH_TOKEN": "sk-ant-api03-xxxx",
  "ANTHROPIC_API_KEY": "sk-ant-api03-xxxx"
}
```

##### 3. ANTHROPIC_BASE_URL (可选)

**作用**: 指定 API 的基础 URL

**默认值**: `https://api.anthropic.com`

**使用场景**:
- 使用代理服务时需要修改
- 使用自建 API 网关
- 使用第三方 API 转发服务 (如 OpenRouter)

**示例**:
```json
// 官方 API (默认)
"ANTHROPIC_BASE_URL": "https://api.anthropic.com"

// 使用 OpenRouter
"ANTHROPIC_BASE_URL": "https://openrouter.ai/api/v1"

// 自定义代理
"ANTHROPIC_BASE_URL": "https://your-proxy.example.com"
```

##### 4. ANTHROPIC_DEFAULT_HAIKU_MODEL (可选但推荐)

**作用**: 指定用于简单任务的快速模型,以降低成本

**推荐值**: `anthropic/claude-haiku-4.5`

**使用场景**:
- 系统会自动在简单任务中使用此模型
- 降低整体 API 调用成本
- 提升响应速度

**示例**:
```json
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4.5"
```

---

### OpenAI 模型环境变量

使用 OpenAI GPT 模型时,需要配置以下环境变量:

#### 完整变量表

| 变量名 | 说明 | 示例值 | 必填 |
|--------|------|--------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 | `sk-xxxxxxxxxxxxxxxx` | 是 |
| `OPENAI_MODEL` | 模型名称 | `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo` | 是 |
| `OPENAI_BASE_URL` | API 基础 URL,默认为官方 API | `https://api.openai.com/v1` | 否 |

#### 字段详细说明

##### 1. OPENAI_API_KEY (必填)

**作用**: 提供 OpenAI API 认证凭证

**获取方式**: 从 https://platform.openai.com/api-keys 创建

**格式**: 以 `sk-` 开头的字符串

**示例**:
```json
"OPENAI_API_KEY": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

##### 2. OPENAI_MODEL (必填)

**作用**: 指定使用的 GPT 模型

**可用模型**:
- `gpt-4` - GPT-4 (能力强,成本高)
- `gpt-4-turbo` - GPT-4 Turbo (更快,成本较低)
- `gpt-3.5-turbo` - GPT-3.5 Turbo (快速,成本低)

**示例**:
```json
"OPENAI_MODEL": "gpt-4"
```

##### 3. OPENAI_BASE_URL (可选)

**作用**: 指定 API 的基础 URL

**默认值**: `https://api.openai.com/v1`

**使用场景**:
- 使用 Azure OpenAI Service
- 使用代理服务
- 使用第三方 API 转发服务

**示例**:
```json
// 官方 API (默认)
"OPENAI_BASE_URL": "https://api.openai.com/v1"

// Azure OpenAI
"OPENAI_BASE_URL": "https://your-resource.openai.azure.com"

// 自定义代理
"OPENAI_BASE_URL": "https://your-proxy.example.com/v1"
```

---

## 🚀 配置步骤

### 方式 1: 通过 Web 界面配置 (推荐新手)

#### 步骤 1: 进入 Model 配置页面

1. 登录 Wegent Web 界面 (http://localhost:3000)
2. 进入 **资源管理** → **Model 配置**
3. 点击 **创建新 Model** 按钮

<!-- TODO: 添加截图 - Model 配置页面 -->

#### 步骤 2: 使用预设模板 (推荐)

在 JSON 配置输入框上方,您会看到 "快速配置" 区域:

📋 **使用预设模板快速配置**

- 点击 **[Claude Sonnet 4 模板]** 按钮 (主要推荐)
- 或点击 **[OpenAI GPT-4 模板]** 按钮 (备选)

点击后会自动填充完整的 JSON 配置到输入框。

#### 步骤 3: 修改 API Key

⚠️ **重要**: 请修改配置中的 API Key 为您的实际密钥

模板中的 API Key 是占位符,您需要:
1. 找到配置中的 `ANTHROPIC_AUTH_TOKEN` 或 `OPENAI_API_KEY` 字段
2. 将值替换为您从官网获取的真实 API Key
3. 如果是 Anthropic 模型,建议同时修改 `ANTHROPIC_API_KEY`

#### 步骤 4: 填写其他字段

- **名称**: 给 Model 起一个描述性的名称 (如 `claude-sonnet-4-prod`)
- **命名空间**: 通常使用 `default`
- **JSON 配置**: 已通过模板填充,只需修改 API Key

#### 步骤 5: 提交配置

点击 **提交** 按钮创建 Model。

系统会验证配置格式,如果有错误会提示。

---

### 方式 2: 通过 YAML 文件配置

#### 步骤 1: 创建 YAML 文件

创建一个 YAML 配置文件,例如 `my-model.yaml`

#### 步骤 2: 编写配置

参考下方 "完整配置示例" 章节编写配置内容。

#### 步骤 3: 导入配置

通过 Web 界面或 API 导入 YAML 配置。

---

## ✅ 配置验证

配置 Model 后,**务必进行验证**以确保配置正确,避免后续使用时出错。

### 验证方法 1: 通过 Web 界面查看状态

#### 步骤 1: 进入 Model 列表

1. 登录 Wegent Web 界面
2. 进入 **资源管理** → **Model 配置**
3. 查看 Model 列表

#### 步骤 2: 检查状态

- ✅ 状态显示为 `Available`: 配置正确,可以使用
- ❌ 状态显示为 `Unavailable`: 配置有问题,需要排查

#### 步骤 3: 查看配置详情

点击 Model 名称查看详细配置,确认:
- API Key 是否正确
- 模型名称是否正确
- BASE_URL 是否正确 (如果使用了代理)

<!-- TODO: 添加截图 - Model 状态显示 -->

---

### 验证方法 2: 通过创建测试 Bot

#### 步骤 1: 创建测试 Bot

创建一个简单的 Bot 使用新配置的 Model:

```yaml
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: test-bot
  namespace: default
spec:
  ghostRef:
    name: developer-ghost  # 使用现有的 Ghost
    namespace: default
  shellRef:
    name: ClaudeCode
    namespace: default
  modelRef:
    name: my-new-model  # 引用新配置的 Model
    namespace: default
```

#### 步骤 2: 分配简单任务

给 Bot 分配一个简单的测试任务,例如:

```
请编写一个 Python 函数,计算两个数的和。
```

#### 步骤 3: 查看执行结果

- ✅ 如果任务成功执行,说明 Model 配置正确
- ❌ 如果任务失败,查看错误信息进行排查

#### 步骤 4: 查看任务日志

在任务详情页查看执行日志,确认:
- API 调用是否成功
- 是否有认证错误
- 是否有模型不可用错误

---

### 验证方法 3: 通过 API 测试

#### 步骤 1: 访问 API 文档

访问: http://localhost:8000/api/docs

#### 步骤 2: 测试 Model 接口

1. 找到 Model 相关的 API 接口 (如 `GET /api/v1/models`)
2. 点击 "Try it out"
3. 输入您的 Model 名称
4. 点击 "Execute" 执行请求

#### 步骤 3: 检查响应

- **状态码 200**: 配置正确
- **状态码 401**: 认证失败,检查 API Key
- **状态码 404**: Model 不存在,检查名称和命名空间
- **状态码 500**: 服务器错误,检查配置格式

#### 示例: 成功响应

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

### 验证方法 4: 查看日志排查问题

如果验证失败,查看日志进行排查:

#### 查看后端日志

```bash
docker-compose logs backend
```

#### 查看 Executor 日志

```bash
docker-compose logs executor_manager
```

#### 常见错误码及解决方案

| 错误码 | 错误信息 | 原因 | 解决方案 |
|--------|---------|------|---------|
| **401** | `Unauthorized` / `Invalid API Key` | API Key 无效或过期 | 1. 检查 API Key 格式是否正确<br>2. 重新生成 API Key<br>3. 确认 API Key 已激活 |
| **429** | `Too Many Requests` / `Rate Limit Exceeded` | 超过速率限制 | 1. 等待一段时间后重试<br>2. 检查是否有其他程序在使用同一 API Key<br>3. 升级 API 套餐 |
| **500** | `Internal Server Error` | 配置格式错误或服务器内部错误 | 1. 检查 JSON 格式是否正确<br>2. 检查环境变量名称拼写<br>3. 查看后端日志获取详细错误信息 |
| **404** | `Model not found` | 模型名称不存在 | 1. 检查模型名称拼写<br>2. 确认模型在 API 提供商处可用<br>3. 参考官方文档确认模型名称 |

#### 调试步骤

1. **检查 API Key 格式**
   ```bash
   # Anthropic API Key 应该以 sk-ant- 开头
   echo $ANTHROPIC_AUTH_TOKEN | grep "^sk-ant-"

   # OpenAI API Key 应该以 sk- 开头
   echo $OPENAI_API_KEY | grep "^sk-"
   ```

2. **测试 API 连接**
   ```bash
   # 测试 Anthropic API
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

3. **检查配置文件格式**
   - 使用 JSON/YAML 验证器检查格式
   - 确保没有多余的逗号或引号
   - 确保所有字段名拼写正确

---

## 💡 完整配置示例

### 示例 1: Claude Sonnet 4 完整配置 (推荐)

#### YAML 格式

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: claude-sonnet-4
  namespace: default
spec:
  env:
    # 主要模型配置 - Claude Sonnet 4
    ANTHROPIC_MODEL: "anthropic/claude-sonnet-4"

    # API 认证令牌 (必填,从 Anthropic Console 获取)
    ANTHROPIC_AUTH_TOKEN: "sk-ant-api03-your-api-key-here"

    # API 密钥 (建议配置,兼容不同运行时)
    ANTHROPIC_API_KEY: "sk-ant-api03-your-api-key-here"

    # API 基础 URL (可选,默认为官方 API)
    ANTHROPIC_BASE_URL: "https://api.anthropic.com"

    # 快速模型配置 (可选但推荐,用于简单任务降低成本)
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5"
status:
  state: "Available"
```

#### JSON 格式 (Web 界面使用)

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

**使用场景**:
- 日常开发任务
- 代码审查
- 功能实现
- 最佳的性能和成本平衡

---

### 示例 2: Claude Haiku 4 完整配置 (经济型)

#### YAML 格式

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: claude-haiku-4
  namespace: default
spec:
  env:
    # 主要模型配置 - Claude Haiku 4.5
    ANTHROPIC_MODEL: "anthropic/claude-haiku-4.5"

    # API 认证
    ANTHROPIC_AUTH_TOKEN: "sk-ant-api03-your-api-key-here"
    ANTHROPIC_API_KEY: "sk-ant-api03-your-api-key-here"

    # API 基础 URL
    ANTHROPIC_BASE_URL: "https://api.anthropic.com"
status:
  state: "Available"
```

#### JSON 格式

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

**使用场景**:
- 简单代码修改
- 文档编写
- 格式化任务
- 成本敏感的场景

---

### 示例 3: OpenAI GPT-4 完整配置

#### YAML 格式

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: gpt-4
  namespace: default
spec:
  env:
    # OpenAI API 密钥 (必填)
    OPENAI_API_KEY: "sk-your-openai-api-key-here"

    # 模型名称 (必填)
    OPENAI_MODEL: "gpt-4"

    # API 基础 URL (可选,默认为官方 API)
    OPENAI_BASE_URL: "https://api.openai.com/v1"
status:
  state: "Available"
```

#### JSON 格式

```json
{
  "env": {
    "OPENAI_API_KEY": "sk-your-openai-api-key-here",
    "OPENAI_MODEL": "gpt-4",
    "OPENAI_BASE_URL": "https://api.openai.com/v1"
  }
}
```

**使用场景**:
- 复杂推理任务
- 需要 GPT-4 特定能力的场景
- 已有 OpenAI 账户的用户

---

### 示例 4: 多模型并存配置

在同一个 Wegent 系统中可以配置多个 Model 资源,供不同的 Bot 使用:

```yaml
# Model 1: 快速经济型
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
# Model 2: 标准开发型
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
# Model 3: GPT-4 备选
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

**使用方式**:

```yaml
# Bot 1: 使用快速模型
kind: Bot
metadata:
  name: quick-bot
spec:
  modelRef:
    name: fast-model  # 引用 Haiku
    namespace: default

---
# Bot 2: 使用标准模型
kind: Bot
metadata:
  name: developer-bot
spec:
  modelRef:
    name: standard-model  # 引用 Sonnet
    namespace: default

---
# Bot 3: 使用 GPT-4
kind: Bot
metadata:
  name: gpt-bot
spec:
  modelRef:
    name: gpt4-model  # 引用 GPT-4
    namespace: default
```

---

### 示例 5: 使用代理的配置

如果您使用 API 代理服务 (如 OpenRouter),需要修改 `BASE_URL`:

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
    # 修改为代理 URL
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1"
status:
  state: "Available"
```

---

## ⚠️ 常见问题

### Q1: API Key 无效怎么办?

**症状**:
- Bot 任务执行失败
- 错误信息包含 "401 Unauthorized" 或 "Invalid API Key"

**解决步骤**:

1. **检查 API Key 格式**
   - Anthropic: 应以 `sk-ant-` 开头
   - OpenAI: 应以 `sk-` 开头

2. **重新生成 API Key**
   - 访问 Anthropic Console 或 OpenAI Platform
   - 删除旧的 API Key
   - 创建新的 API Key
   - 更新 Model 配置

3. **检查 API Key 是否激活**
   - 确认账户状态正常
   - 确认 API Key 未被删除或禁用

4. **检查变量名拼写**
   - `ANTHROPIC_AUTH_TOKEN` (不是 `ANTHROPIC_API_TOKEN`)
   - `ANTHROPIC_API_KEY` (不是 `ANTHROPIC_KEY`)

---

### Q2: 模型调用失败如何排查?

**排查步骤**:

1. **查看后端日志**
   ```bash
   docker-compose logs backend | grep -i error
   ```

2. **查看 Executor 日志**
   ```bash
   docker-compose logs executor_manager | grep -i error
   ```

3. **检查网络连接**
   ```bash
   # 测试能否访问 Anthropic API
   curl -I https://api.anthropic.com

   # 测试能否访问 OpenAI API
   curl -I https://api.openai.com
   ```

4. **验证配置格式**
   - 使用 JSON/YAML 验证器检查格式
   - 确认没有语法错误

5. **检查模型名称**
   - 确认模型名称拼写正确
   - 参考官方文档确认模型可用

---

### Q3: 成本控制建议

**策略 1: 任务分层使用不同模型**

```yaml
# 简单任务用 Haiku (便宜)
fast-bot → claude-haiku-4

# 常规任务用 Sonnet (平衡)
developer-bot → claude-sonnet-4

# 复杂任务用 Opus (贵但强大)
expert-bot → claude-opus
```

**策略 2: 配置 DEFAULT_HAIKU_MODEL**

系统会自动在简单任务中使用 Haiku,降低成本:

```json
{
  "ANTHROPIC_MODEL": "anthropic/claude-sonnet-4",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "anthropic/claude-haiku-4.5"
}
```

**策略 3: 设置 API 使用限制**

在 API 提供商的控制台中设置:
- 每月使用限额
- 每日使用限额
- 单次调用 token 限制

**策略 4: 监控使用情况**

定期检查:
- API 使用统计
- 成本报告
- 调用频率

---

### Q4: 如何切换模型?

**方式 1: 更新 Bot 的 modelRef**

```yaml
# 修改 Bot 配置,引用不同的 Model
apiVersion: agent.wecode.io/v1
kind: Bot
metadata:
  name: my-bot
spec:
  modelRef:
    name: claude-haiku-4  # 从 Sonnet 改为 Haiku
    namespace: default
```

**方式 2: 更新 Model 配置**

```yaml
# 修改 Model 资源,更改模型版本
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: my-model
spec:
  env:
    ANTHROPIC_MODEL: "anthropic/claude-sonnet-4"  # 从 Haiku 改为 Sonnet
```

**注意**: 方式 2 会影响所有使用此 Model 的 Bot。

---

### Q5: 初始化数据中的示例 Model 如何使用?

Wegent 在初始化时可能已经创建了一些示例 Model 配置。

**查看方式**:

1. **通过 Web 界面**
   - 进入 **资源管理** → **Model 配置**
   - 查看现有 Model 列表

2. **检查初始化脚本**
   - 查看 `backend/init.sql` 或相关初始化文件
   - 查看预设的 Model 配置

**使用方式**:

如果发现示例 Model (如 `claude-model`):
1. 查看其配置详情
2. 复制配置作为模板
3. 修改 API Key 为您的实际密钥
4. 创建新的 Model 资源

**不要直接修改示例 Model**: 建议创建新的 Model 资源,避免影响系统默认配置。

---

### Q6: 支持哪些模型提供商?

当前 Wegent 主要支持:

✅ **Anthropic Claude**
- Claude Haiku 4.5
- Claude Sonnet 4
- Claude Opus (如果可用)

✅ **OpenAI GPT**
- GPT-4
- GPT-4 Turbo
- GPT-3.5 Turbo

⚠️ **其他提供商** (可能需要自定义配置):
- Azure OpenAI
- 本地模型 (通过兼容 API)
- 第三方 API 服务 (如 OpenRouter)

---

### Q7: BASE_URL 何时需要修改?

**需要修改的场景**:

1. **使用 API 代理**
   ```json
   "ANTHROPIC_BASE_URL": "https://your-proxy.example.com"
   ```

2. **使用 OpenRouter**
   ```json
   "ANTHROPIC_BASE_URL": "https://openrouter.ai/api/v1"
   ```

3. **使用 Azure OpenAI**
   ```json
   "OPENAI_BASE_URL": "https://your-resource.openai.azure.com"
   ```

4. **企业内部 API 网关**
   ```json
   "ANTHROPIC_BASE_URL": "https://internal-gateway.company.com"
   ```

**不需要修改的场景**:

- 直接使用官方 Anthropic API
- 直接使用官方 OpenAI API

---

## 🔗 相关资源

### 相关配置指南
- [Shell (执行器) 配置完整指南](./configuring-shells.md) - 配置运行时环境

### 下一步
- [创建 Bot](./creating-bots.md) - 使用 Model 创建完整的 Bot 实例
- [创建 Ghost](./creating-ghosts.md) - 定义 Bot 的"灵魂"

### 参考文档
- [核心概念](../../concepts/core-concepts.md) - 理解 Model 在架构中的角色
- [YAML 规范](../../reference/yaml-specification.md) - 完整的配置格式

### 官方资源
- [Anthropic API 文档](https://docs.anthropic.com/claude/reference/getting-started-with-the-api)
- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [Anthropic Console](https://console.anthropic.com/settings/keys)
- [OpenAI Platform](https://platform.openai.com/api-keys)

---

## 💬 获取帮助

遇到问题?

- 📖 查看 [FAQ](../../faq.md)
- 🐛 提交 [GitHub Issue](https://github.com/wecode-ai/wegent/issues)
- 💬 加入社区讨论

---

<p align="center">配置好 Model,为您的 Bot 赋予强大的 AI 能力! 🚀</p>
