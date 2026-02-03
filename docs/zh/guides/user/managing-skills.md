# ✨ 管理 Skills

Skills 是 Claude Code 的能力扩展包,可以为您的 Bot 添加专门的功能。本指南将教您如何上传、管理和使用 Wegent 中的 Skills。

---

## 📋 目录

- [什么是 Skill](#-什么是-skill)
- [创建 Skill 包](#-创建-skill-包)
- [上传 Skills](#-上传-skills)
- [管理 Skills](#-管理-skills)
- [在 Bot 中使用 Skills](#-在-bot-中使用-skills)
- [最佳实践](#-最佳实践)
- [常见问题](#-常见问题)
- [相关资源](#-相关资源)

---

## 🎯 什么是 Skill

**Skill** 是一个 Claude Code 能力扩展包,包含可执行代码、配置和文档。当任务启动时,Skills 会被部署到 `~/.claude/skills/` 目录,扩展智能体的能力。

**类比**: 如果 Bot 是一个人,Skills 就像工具或特殊技能:
- **Ghost**: 人的性格和基础知识
- **Skills**: 人可以使用的专业工具和技术
- **Bot**: 拥有工具的完整的人

**Skill 示例**:
- Python 调试工具
- 代码格式化和检查工具
- API 测试工具
- 数据库查询助手
- 自定义工作流自动化

---

## 📦 创建 Skill 包

### 要求

Skill 必须打包为 ZIP 文件,包含:

1. **SKILL.md**(必需): 带有 YAML frontmatter 的文档
2. **其他文件**: 脚本、配置、资源等

### SKILL.md 格式

```markdown
---
description: "简要描述此 Skill 的功能"
version: "1.0.0"
author: "您的名字"
tags: ["分类1", "分类2"]
---

# Skill 名称

## 概述

详细描述 Skill 的功能。

## 使用方法

如何使用此 Skill...

## 示例

示例代码或命令...
```

### YAML Frontmatter 字段

| 字段 | 必填 | 说明 | 示例 |
|------|------|------|------|
| `description` | 是 | Skill 简要描述 | "带断点支持的 Python 调试工具" |
| `version` | 否 | 语义化版本号 | "1.0.0", "2.3.1" |
| `author` | 否 | 作者名称或组织 | "WeCode Team", "您的名字" |
| `tags` | 否 | 分类标签(数组) | ["python", "debugging", "development"] |

### 目录结构示例

```
my-skill.zip
├── SKILL.md                 # 必需: 带 frontmatter 的文档
├── main.py                  # 您的 Skill 代码
├── config.json              # 配置文件(可选)
├── utils/
│   ├── helper.py
│   └── formatter.py
└── README.md                # 额外文档(可选)
```

### 创建 ZIP 包

**使用命令行:**
```bash
cd my-skill-directory
zip -r my-skill.zip .
```

**重要提示**:
- 将 SKILL.md 放在根目录或子目录中
- 保持文件大小在 10MB 以下
- 避免包含敏感数据(API 密钥、password)
- 在代码中使用相对路径

---

## ⬆️ 上传 Skills

### 通过 Web UI

1. **导航到 Skills 页面**
   - 前往设置(⚙️)
   - 点击"Skills"标签页

2. **上传 Skill**
   - 点击"上传 Skill"按钮
   - 输入唯一的 Skill 名称(例如 `python-debugger`)
   - 选择或拖放您的 ZIP 文件
   - 等待上传完成

3. **验证上传**
   - Skill 卡片出现在列表中
   - 检查元数据(版本、作者、标签)
   - 状态显示为"Available"

### 上传要求

- **文件格式**: 必须是 `.zip` 文件
- **文件大小**: 最大 10MB
- **名称**: 唯一标识符(小写,允许连字符)
- **SKILL.md**: 必须存在且有效

### 验证

系统会验证:
- ✅ ZIP 文件格式
- ✅ 文件大小 < 10MB
- ✅ SKILL.md 存在
- ✅ YAML frontmatter 有效
- ✅ `description` 字段存在
- ✅ 无安全问题(Zip Slip 攻击)

---

## 🛠️ 管理 Skills

### 查看 Skills

**Skills 列表显示:**
- Skill 名称
- 描述(前 2 行)
- 版本、作者、标签
- 文件大小和状态
- 最后更新时间

### 下载 Skills

1. 在列表中找到您的 Skill
2. 点击下载图标(⬇️)
3. ZIP 文件下载到您的计算机

**用途**: 备份、与团队共享或本地修改

### 更新 Skills

1. 点击 Skill 卡片上的编辑图标(✏️)
2. 上传新的 ZIP 文件
3. 名称和命名空间无法更改
4. 元数据从新的 SKILL.md 中提取

**注意**: 所有使用此 Skill 的 Bot 在下次任务启动时会获得更新版本。

### 删除 Skills

1. 点击 Skill 卡片上的删除图标(🗑️)
2. 在对话框中确认删除

**重要**:
- ⚠️ 无法删除被 Bot/Ghost 引用的 Skills
- 首先从所有 Bot 中移除 Skill
- 错误消息会显示哪些 Bot 正在使用该 Skill

---

## 🤖 在 Bot 中使用 Skills

### 将 Skills 与 Bot 关联

1. **编辑 Bot**
   - 前往设置 > Bots
   - 点击编辑一个 Bot

2. **添加 Skills**
   - 找到"Skills"部分(在 Agent Config 下方)
   - 点击下拉菜单查看可用的 Skills
   - 选择要添加的 Skills
   - Skills 显示为可移除的标签

3. **保存 Bot**
   - 点击"保存"按钮
   - Skills 现在与 Bot 关联

### 通过 YAML 配置

```yaml
apiVersion: agent.wecode.io/v1
kind: Ghost
metadata:
  name: developer-ghost
  namespace: default
spec:
  systemPrompt: "你是一位资深开发工程师..."
  mcpServers:
    github:
      command: docker
      args: [...]
  skills:
    - python-debugger      # Skill 名称
    - code-formatter
    - api-tester
```

### Skills 如何部署

当任务启动时:

1. **Executor 获取 Bot 配置** 包括 Skills 列表
2. **从 API 下载每个 Skill**
3. **解压 ZIP 文件** 到 `~/.claude/skills/{skill-name}/`
4. **Claude Code 自动加载 Skills**
5. **智能体可以使用 Skill 能力** 在任务执行期间

**部署路径示例**:
```
~/.claude/skills/
├── python-debugger/
│   ├── SKILL.md
│   ├── main.py
│   └── utils/
├── code-formatter/
│   ├── SKILL.md
│   └── formatter.py
└── api-tester/
    ├── SKILL.md
    └── test_runner.py
```

---

## 💡 最佳实践

### 创建 Skills

1. **清晰的文档**
   - 编写全面的 SKILL.md
   - 包含使用示例
   - 记录依赖项

2. **语义化版本**
   - 使用版本号: `主版本.次版本.修订号`
   - 重大更改时增加主版本号
   - 新功能时增加次版本号
   - Bug 修复时增加修订号

3. **有意义的标签**
   - 使用描述性分类标签
   - 示例: `["python", "testing"]`, `["nodejs", "linting"]`
   - 有助于发现和组织

4. **保持专注**
   - 一个 Skill = 一个特定能力
   - 不要创建单体 Skills
   - 更易于维护和重用

### 管理 Skills

1. **命名约定**
   - 使用小写连字符: `my-skill-name`
   - 具有描述性: `python-unit-test-runner` vs `runner`
   - 如果相关,包含语言/框架

2. **版本控制**
   - 修改时更新版本号
   - 保留旧版本以便回滚(更新前下载)
   - 在 SKILL.md 中记录更改

3. **安全性**
   - 永远不要包含 API 密钥或password
   - 对secret使用环境变量
   - 上传前检查 ZIP 内容

4. **大小优化**
   - 删除不必要的文件
   - 尽可能压缩资源
   - 保持在 10MB 限制以下

### 使用 Skills

1. **单独测试**
   - 首先创建一个只有一个 Skill 的 Bot
   - 验证它是否正常工作
   - 然后组合多个 Skills

2. **记录依赖关系**
   - 记录哪些 Skills 可以协同工作
   - 记录任何冲突
   - 更新 Bot 描述

3. **监控使用情况**
   - 检查哪些 Bot 使用每个 Skill
   - 删除未使用的 Skills
   - 保持 Skills 更新

---

## ❓ 常见问题

### 上传失败

**问题**: "ZIP 包中未找到 SKILL.md"
- ✅ 确保 SKILL.md 存在于根目录或子目录中
- ✅ 检查文件名是否准确为 `SKILL.md`(区分大小写)

**问题**: "无效的 YAML frontmatter"
- ✅ 验证 `---` 标记之间的 YAML 语法
- ✅ 确保 `description` 字段存在
- ✅ 检查正确的缩进

**问题**: "文件大小超过 10MB"
- ✅ 删除不必要的文件
- ✅ 压缩大型资源
- ✅ 拆分为多个较小的 Skills

### 删除问题

**问题**: "无法删除被 Ghost 引用的 Skill"
- ✅ 检查错误消息中的 Bot/Ghost 名称
- ✅ 编辑这些 Bot 以移除 Skill
- ✅ 然后删除 Skill

### 部署问题

**问题**: Skill 在任务中不可用
- ✅ 验证 Skill 是否与 Bot 关联
- ✅ 检查任务日志中的下载错误
- ✅ 确保 Skill 状态为"Available"

**问题**: "ZIP 中检测到不安全的文件路径"
- ✅ 不要在文件路径中使用 `../`
- ✅ 不要使用绝对路径如 `/etc/`
- ✅ 仅在 ZIP 中使用相对路径

---

## 🔗 相关资源

### 文档
- [YAML 规范 - Skill](../../reference/yaml-specification.md#-skill)
- [智能体设置](./agent-settings.md) - 配置智能体和机器人

### 外部资源
- [Claude Code Skills 文档](https://docs.claude.com/en/docs/claude-code/skills)
- [语义化版本](https://semver.org/)
- [YAML 语法指南](https://yaml.org/spec/1.2/spec.html)

### 示例
- 即将推出: Wegent Skills 仓库
- 社区贡献的 Skills
- 预构建的 Skill 模板

---

## 🎓 快速入门示例

### 1. 创建一个简单的 Skill

创建目录结构:
```
hello-skill/
├── SKILL.md
└── hello.py
```

**SKILL.md**:
```markdown
---
description: "一个简单的 hello world skill"
version: "1.0.0"
author: "您的名字"
tags: ["示例", "教程"]
---

# Hello Skill

一个简单的示例 Skill,打印问候语。

## 使用方法

此 Skill 提供一个 hello() 函数,可以被智能体调用。
```

**hello.py**:
```python
def hello(name="World"):
    return f"Hello, {name}!"

if __name__ == "__main__":
    print(hello())
```

### 2. 打包 Skill

```bash
cd hello-skill
zip -r hello-skill.zip .
```

### 3. 上传到 Wegent

1. 前往设置 > Skills
2. 点击"上传 Skill"
3. 名称: `hello-skill`
4. 上传 `hello-skill.zip`
5. 等待成功消息

### 4. 在 Bot 中使用

1. 前往设置 > Bots
2. 编辑或创建一个 Bot
3. 滚动到"Skills"部分
4. 选择 `hello-skill`
5. 保存 Bot

### 5. 在任务中测试

使用此 Bot 创建任务并要求它使用 hello skill!

---

**需要帮助?**
- 查看[常见问题](#-常见问题)
- 查阅[YAML 规范](../reference/yaml-specification.md)
- 在 Wegent 社区论坛中提问
