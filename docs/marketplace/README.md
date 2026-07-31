# WeWork 插件市场文档索引

本目录包含插件市场功能的所有设计和实现文档。

## 📁 文档结构

```
docs/marketplace/
├── design-specs/                         # 设计规范文档（5份）
│   ├── 00-完整交互规范文档.md
│   ├── 01-组件库和样式规范.md
│   ├── 02-插件市场页面详细设计.md
│   ├── 03-多仓库市场管理规范.md
│   ├── 04-@创建插件交互规范.md
│   └── README.md
│
├── MARKETPLACE_IMPLEMENTATION.md         # 详细实现说明
├── MARKETPLACE_DELIVERY.md               # 交付说明文档
├── plugin-marketplace-login-fix.md       # 登录修复文档
├── check_github_plugin.sql               # GitHub 插件检查 SQL
├── 发布官方插件说明.md                   # 官方插件发布指南
├── 发布EchoID插件.md                     # EchoID 企业内部发布上手
├── 发布微博开放平台内部WIKI插件.md       # 微博开放平台内部WIKI 企业发布上手
└── README.md                             # 本文件
```

## 📖 文档说明

### 设计规范文档 (design-specs/)

这是实现的核心参考文档，包含完整的产品设计：

- **00-完整交互规范文档.md** - 整体架构、设计决策、技术栈
- **01-组件库和样式规范.md** - UI 设计规范、色彩、间距、组件
- **02-插件市场页面详细设计.md** - 主页、管理页、详情页设计
- **03-多仓库市场管理规范.md** - 多市场功能、智能命名、API
- **04-@创建插件交互规范.md** - @ 快捷面板、引用语法

### 实现文档

**MARKETPLACE_IMPLEMENTATION.md** - 实现详情
- ✅ 已完成功能清单（60%）
- ⏳ 待完成工作列表（40%）
- 📂 文件结构说明
- 📊 代码统计和质量报告
- ⚠️ 已知问题和注意事项

**MARKETPLACE_DELIVERY.md** - 交付说明
- 🎯 核心功能介绍
- 🚀 快速集成指南
- 💡 技术亮点说明
- 📋 后续工作建议
- ✅ 设计规范遵循情况

### 运维文档

**plugin-marketplace-login-fix.md**
- 插件市场登录问题修复方案

**check_github_plugin.sql**
- GitHub 插件数据检查 SQL 脚本

**发布官方插件说明.md**
- 官方插件发布流程和检查清单

## 🎯 快速导航

### 👨‍💻 我是开发者

1. **快速了解** → 阅读 `MARKETPLACE_DELIVERY.md`
2. **查看设计** → 浏览 `design-specs/` 目录
3. **实现细节** → 参考 `MARKETPLACE_IMPLEMENTATION.md`
4. **开始集成** → 按照交付文档的集成指南操作

### 👨‍🎨 我是设计师

1. **整体架构** → `design-specs/00-完整交互规范文档.md`
2. **视觉规范** → `design-specs/01-组件库和样式规范.md`
3. **页面设计** → `design-specs/02-插件市场页面详细设计.md`

### 👨‍💼 我是产品经理

1. **产品概述** → `MARKETPLACE_DELIVERY.md`
2. **功能规范** → `design-specs/00-完整交互规范文档.md`
3. **实现进度** → `MARKETPLACE_IMPLEMENTATION.md`

### 🔧 我是运维

1. **部署检查** → `check_github_plugin.sql`
2. **插件发布** → `发布官方插件说明.md`

## 📍 相关代码位置

```
wework/src/
├── types/
│   └── marketplace.ts                    # 类型定义
├── lib/marketplace/
│   ├── gitUrl.ts                         # Git URL 解析
│   ├── marketName.ts                     # 智能市场命名
│   └── pluginParser.ts                   # 插件引用解析
├── api/
│   └── marketplace.ts                    # API 接口层
└── features/marketplace/
    ├── MarketplaceContext.tsx            # 状态管理
    ├── components/                       # UI 组件
    │   ├── MarketSourceTab.tsx
    │   ├── SearchBox.tsx
    │   ├── PluginCard.tsx
    │   └── CategoryTab.tsx
    └── pages/                            # 页面组件
        ├── MarketplacePage.tsx
        └── PluginDetailPage.tsx
```

## 🎨 核心设计特性

### 1. 统一插件概念
前端统一为"插件"，底层区分类型（Connector、MCP、Skill、CLI）

### 2. 智能市场命名
```
openai/plugins         → "OpenAI"
modelscope/mcp-servers → "ModelScope"
```

### 3. @ 快捷引用
```
@GitHub 查看最新 PR
@GitHub repo:openai/gpt-3 查看提交
```

## 📊 实现进度

| 模块 | 进度 | 状态 |
|------|------|------|
| 类型定义 | 100% | ✅ 完成 |
| 工具函数 | 100% | ✅ 完成 |
| API 接口 | 100% | ✅ 完成（Mock） |
| 状态管理 | 100% | ✅ 完成 |
| UI 组件 | 80% | 🟡 进行中 |
| 页面组件 | 60% | 🟡 进行中 |
| 路由集成 | 0% | ⏳ 待开始 |
| 国际化 | 0% | ⏳ 待开始 |
| 测试 | 0% | ⏳ 待开始 |

**总体进度**: 60% 完成

## 🚀 后续工作

### 高优先级（本周）
- [ ] 完成添加市场弹窗
- [ ] 插件管理页面
- [ ] 路由集成和导航

### 中优先级（下周）
- [ ] @ 快捷面板
- [ ] 国际化翻译
- [ ] 后端 API 对接

### 低优先级（后续）
- [ ] 单元测试
- [ ] E2E 测试
- [ ] 性能优化

## 📞 技术支持

### 文档问题
- 查看相关文档的 README
- 参考设计规范原文

### 开发问题
- 参考 `/wework/AGENTS.md`
- 参考 `/wework/DESIGN.md`
- 查看实现文档中的代码示例

### 集成问题
- 参考 `MARKETPLACE_DELIVERY.md` 集成指南
- 查看相关代码的注释

---

**最后更新**: 2026-07-27  
**实现进度**: 60%  
**维护者**: WeWork 开发团队
