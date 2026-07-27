# WeWork 插件详情页重构 - 按照 trae 布局

## 概述

根据反馈，将插件详情页重构为与 trae 一致的布局结构，清晰地展示插件的三种主要能力类型。

## 修改内容

### 原有布局问题

**之前的布局**：所有组件混在一个"包含能力"部分中
```
┌─────────────────────────────────────┐
│ GitHub                              │
│ DEVELOPMENT_TOOLS · by OpenAI       │
├─────────────────────────────────────┤
│ 描述信息                             │
├─────────────────────────────────────┤
│ 应用授权  1                          │
│ ├─ github                           │
├─────────────────────────────────────┤
│ 包含能力  8                          │
│ ├─ 技能 gh-address-comments         │
│ ├─ 技能 gh-fix-ci                   │
│ ├─ 技能 github                      │
│ ├─ 技能 yeet                        │
│ ├─ MCP github                       │
│ ├─ 命令 xxx                         │
│ └─ ...混在一起                      │
└─────────────────────────────────────┘
```

### 新布局结构（参考 trae）

**现在的布局**：按类型分成三个独立部分
```
┌─────────────────────────────────────┐
│ GitHub                              │
│ DEVELOPMENT_TOOLS · by OpenAI       │
├─────────────────────────────────────┤
│ 描述信息                             │
├─────────────────────────────────────┤
│ 应用授权  1                          │
│ ├─ github                           │
│    └─ [管理连接]                    │
├─────────────────────────────────────┤
│ 技能  4                             │
│ ├─ gh-address-comments              │
│    Address actionable GitHub...     │
│    [开关]                           │
│ ├─ gh-fix-ci                        │
│    Use when a user asks to...       │
│    [开关]                           │
│ ├─ github                           │
│    Triage and orient GitHub...      │
│    [开关]                           │
│ └─ yeet                             │
│    Publish local changes to...      │
│    [开关]                           │
├─────────────────────────────────────┤
│ MCP 服务器  1                        │
│ └─ github                           │
│    https://api.githubcopilot...     │
└─────────────────────────────────────┘
```

## 代码修改

### 1. 组件分组逻辑

**文件**：`/wework/src/components/plugins/PluginDetailView.tsx`

```typescript
// 按照 trae 布局分组组件
const connectorItems = componentItems.filter(item => item.type === 'connector')
const skillItems = componentItems.filter(item => item.type === 'skill')
const mcpItems = componentItems.filter(item => item.type === 'mcp')
const otherItems = componentItems.filter(
  item => !['connector', 'skill', 'mcp'].includes(item.type)
)
```

### 2. 三个独立部分

#### 2.1 应用授权（已有，保持不变）
- 显示需要授权的应用连接
- 带有"管理连接"按钮
- 适用于 GitHub、Slack 等需要 OAuth 的服务

#### 2.2 技能（新增独立部分）
- **标题**：技能 + 数量徽章
- **图标**：BookOpenText（书本图标）
- **内容**：
  - 技能名称
  - 技能描述（支持多行显示）
  - 开关按钮（可启用/禁用）
- **特点**：每个技能都可以独立控制开关

#### 2.3 MCP 服务器（新增独立部分）
- **标题**：MCP 服务器 + 数量徽章
- **图标**：Boxes（方块图标）
- **内容**：
  - MCP 服务器名称
  - 服务器描述或 URL
- **特点**：只读显示，不带开关

### 3. UI 细节

#### 技能部分的改进
```tsx
<div className="min-w-0">
  <h3 className="truncate text-sm font-medium leading-5">{item.name}</h3>
  <p className="line-clamp-2 text-xs leading-4 text-text-secondary">
    {item.description}
  </p>
</div>
```
- 标题只显示技能名，不显示"技能"标签
- 描述支持最多 2 行显示（`line-clamp-2`）
- 更好地利用空间展示完整描述

#### MCP 服务器部分
```tsx
<div className="grid grid-cols-[38px_minmax(0,1fr)] items-center gap-3">
  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface">
    <Boxes className="h-4 w-4" />
  </div>
  <div className="min-w-0">
    <h3 className="truncate text-sm font-medium leading-5">{item.name}</h3>
    <p className="truncate text-xs leading-4 text-text-secondary">
      {item.description}
    </p>
  </div>
</div>
```
- 2 列布局（图标 + 内容），不带操作按钮
- 描述显示为单行，支持截断

### 4. 其他组件（向后兼容）

为了保持向后兼容，保留了"其他组件"部分：
- 显示不属于上述三类的组件（命令、Hook、Agent 等）
- 使用原有的显示逻辑
- 带类型标签和图标

## 国际化

### 新增翻译键

| 键名 | 中文 | 英文 |
|------|------|------|
| `plugin_detail_skills` | 技能 | Skills |
| `plugin_detail_mcp_servers` | MCP 服务器 | MCP Servers |
| `plugin_detail_other_components` | 其他组件 | Other components |

### 已有翻译键

| 键名 | 中文 | 英文 |
|------|------|------|
| `plugin_detail_authorization` | 应用授权 | App authorization |
| `plugin_manage_connection` | 管理连接 | Manage connection |

## 与 trae 的对比

### 相同点 ✅
1. 三个独立的部分：应用授权、技能、MCP 服务器
2. 每个部分带有数量徽章
3. 技能可以开关控制
4. MCP 服务器只读显示
5. 清晰的视觉层次

### 差异点（适配 WeWork）
1. **保留其他组件部分**：WeWork 支持更多组件类型（命令、Hook、Agent 等）
2. **描述显示优化**：技能描述支持 2 行显示，更充分展示信息
3. **开关状态**：保持 WeWork 原有的开关样式和交互逻辑

## 验证清单

- ✅ 应用授权部分独立显示
- ✅ 技能部分独立显示（带开关）
- ✅ MCP 服务器部分独立显示
- ✅ 技能描述支持多行显示
- ✅ 所有文本已汉化
- ✅ TypeScript 类型检查通过
- ✅ 向后兼容其他组件类型

## 用户体验改进

1. **更清晰的信息架构**：用户可以快速了解插件包含什么类型的能力
2. **更好的扫描性**：三个独立部分，各司其职
3. **更详细的技能描述**：2 行描述让用户更了解技能功能
4. **符合产品规范**：与 trae 保持一致的设计语言

## 示例：GitHub 插件

### 显示效果
```
应用授权  1
├─ github
   安装和使用此插件需要授权
   [管理连接]

技能  4
├─ gh-address-comments
   Address actionable GitHub pull request review
   feedback. Use when the user wants to inspect...
   [●]
├─ gh-fix-ci
   Use when a user asks to debug or fix failing
   GitHub PR checks that run in GitHub Actions...
   [●]
├─ github
   Triage and orient GitHub repository, pull
   request, and issue work through the...
   [●]
└─ yeet
   Publish local changes to GitHub by confirming
   scope, committing intentionally...
   [●]

MCP 服务器  1
└─ github
   https://api.githubcopilot.com/mcp/
```

## 技术细节

- **文件修改**：`PluginDetailView.tsx`（约 200 行改动）
- **新增翻译**：3 个翻译键（中英文）
- **类型安全**：✅ 0 TypeScript 错误
- **性能影响**：无，只是重新组织 UI 结构

## 参考

- trae 插件详情页设计（参考图片）
- WeWork 插件详情页现有实现
- Codex 插件系统架构
