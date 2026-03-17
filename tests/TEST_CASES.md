# Wegent E2E 测试用例文档

本文档描述 Wegent 项目中的所有 E2E 测试用例。

**注意：** 添加新的测试用例时，请按照 [CLAUDE.md 中的规则2](./CLAUDE.md) 更新本文档。

---

## 聊天流程测试 (`specs/chat-flow.spec.ts`)

| 测试用例 | 描述 |
|-----------|-------------|
| `should send message and receive AI response` | 测试基本聊天功能 - 发送消息并验证收到 AI 回复 |
| `should use clarification mode for vague requests` | 测试澄清模式 - 当用户输入模糊或不完整时的澄清流程 |

**环境要求：**
- 需要 `wegent-chat` 智能体可用
- 需要模型 `公网:GLM-5` 可用

---

## 代码流程测试 (`specs/code-flow.spec.ts`)

| 测试用例 | 描述 |
|-----------|-------------|
| `should analyze repository and provide code suggestions` | 测试代码仓库分析功能 - 选择 dev-team 智能体、wecode-ai/Wegent 仓库并请求代码分析 |
| `should create a new file in the repository` | 测试在代码编辑器中创建新文件的工作流程 |

**环境要求：**
- 需要 `dev-team` 智能体可用
- 需要 `wecode-ai/Wegent` 仓库可访问
- 需要配置 git 工作区

---

## 知识库流程测试 (`specs/knowledge-flow.spec.ts`)

| 测试用例 | 描述 |
|-----------|-------------|
| `should create and display a new notebook knowledge base` | 测试创建 Notebook 类型知识库并验证其在列表中显示 |
| `should create and convert knowledge base type` | 测试创建 Classic 知识库并转换为 Notebook 类型 |
| `should navigate between knowledge scopes` | 测试在个人、团队、组织知识库之间的 Tab 导航 |
| `should search knowledge bases` | 测试知识库的搜索过滤功能 |
| `should open knowledge base detail` | 测试从列表打开知识库详情页面 |

**环境要求：**
- 用户必须已登录
- 需要处理自动生成摘要开关（禁用以避免模型选择要求）

---

## 群聊流程测试 (`specs/chat-group-flow.spec.ts`)

| 测试用例 | 描述 |
|-----------|-------------|
| `should create a new group chat` | 测试创建新群聊，包括标题、团队、模型选择 |
| `should send message in group chat` | 测试在群聊中发送消息并验证消息显示 |
| `should open members panel in group chat` | 测试打开成员面板查看群成员 |
| `should generate invite link for group chat` | 测试生成邀请链接用于邀请其他用户 |
| `should leave group chat` | 测试离开群聊（非群主成员） |

**环境要求：**
- 用户必须已登录
- 需要至少一个聊天类型智能体可用
- 需要至少一个模型可用

---

## 测试统计

| 测试套件 | 用例数量 |
|------------|------------|
| 聊天流程 | 2 |
| 代码流程 | 2 |
| 知识库流程 | 5 |
| 群聊流程 | 5 |
| **总计** | **14** |

---

## 通用设置函数

### 聊天页面设置 (`setupChatPage`)
- 导航到 `/chat`
- 通过 localStorage 跳过新手引导
- 从快速访问卡片选择 wegent-chat 智能体
- 选择 公网:GLM-5 模型

### 代码页面设置 (`setupCodePage`)
- 导航到 `/code`
- 通过 localStorage 跳过新手引导
- 选择 dev-team 智能体
- 选择 wecode-ai/Wegent 仓库
- 选择 main 分支

### 知识库页面设置 (`setupKnowledgePage`)
- 导航到 `/knowledge`
- 如需则处理登录 (admin/Wegent2025!)
- 通过 localStorage 跳过新手引导
- 移除 driver.js 覆盖层

### 群聊页面设置 (`setupChatGroupPage`)
- 导航到 `/chat`
- 如需则处理登录 (admin/Wegent2025!)
- 通过 localStorage 跳过新手引导
- 移除 driver.js 覆盖层
