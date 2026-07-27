# WeWork 插件市场 UI 改进

## 概述

根据设计规范的反馈，对插件市场页面进行了以下改进，使其更符合 Codex 的交互模式和中国用户习惯。

## 改进内容

### 1. 创建下拉菜单优化 ✅

**问题**：原有的创建菜单包含"技能"和"MCP"，与设计规范不符。

**解决方案**：
按照设计规范更新创建下拉菜单，现在包含：
- **创建插件** (插件图标)
- **添加插件市场** (+ 图标)
- **录制技能** (圆形录制图标)

**文件修改**：
- `/wework/src/components/plugins/PluginCreateMenu.tsx`
- 移除了 `onCreateSkill` 和 `onCreateMcp` 回调
- 添加了 `onAddMarket` 和 `onRecordSkill` 回调
- 更新菜单项的图标和文本

### 2. 管理按钮改为齿轮图标 ✅

**问题**：右上角的"管理"按钮是文字按钮，不符合设计规范。

**解决方案**：
将"管理"文字按钮改为齿轮图标按钮（Settings 图标）

**修改位置**：
- `/wework/src/components/plugins/PluginsWorkspace.tsx`
- 从 `<button>管理</button>` 改为 `<button><Settings /></button>`
- 保持相同的功能：点击进入 `/plugins/manage` 页面

### 3. 市场源 Tabs UI ✅

**已实现功能**：
- 在插件市场页面顶部显示市场源 tabs
- 第一个 tab 为"Wegent 云端市场"（固定）
- 后续 tabs 为用户添加的本地市场
- 本地市场 tab 带有删除按钮（X）
- 右侧带有添加按钮（+）

### 4. 添加市场对话框 ✅

**已实现功能**：
- 完整的添加市场表单
- 支持 GitHub 简写、Git URL、本地路径
- Git 引用（可选）
- 子路径（可选）
- 市场显示名称（可选）

### 5. 国际化支持 ✅

**新增翻译键**：
```
plugins_record_skill: "录制技能" / "Record skill"
plugins_add_market: "添加插件市场" / "Add plugin market"
plugins_remove_market: "删除市场" / "Remove market"
plugins_market_source: "来源" / "Source"
plugins_market_git_ref: "Git 引用" / "Git reference"
plugins_market_sub_path: "输入路径" / "Sub path"
plugins_market_display_name: "市场显示名称" / "Market display name"
... 等等
```

## UI 对比

### 创建下拉菜单

#### 修改前
```
创建 ▼
  ├─ 技能
  ├─ MCP
  └─ 插件
```

#### 修改后（符合设计规范）
```
创建 ▼
  ├─ 插件
  ├─ 添加插件市场
  └─ 录制技能
```

### 顶部操作栏

#### 修改前
```
[刷新图标] [管理按钮] [创建菜单（隐藏）]
```

#### 修改后
```
[刷新图标] [齿轮图标] [创建菜单]
```

### 页面结构

```
┌─────────────────────────────────────────────┐
│ 插件市场                                     │
│ 发现并接入开发工具、企业数据和专业方法。       │
│                                             │
│ [Wegent 云端市场] [其他市场...] [+]          │  ← 市场源 tabs
│                                             │
│ [全部] [生产力] [开发工具]      [搜索框]     │
│ ─────────────────────────────────────────── │
│ 插件列表...                                  │
└─────────────────────────────────────────────┘
```

## 技术细节

### 组件修改

1. **PluginCreateMenu.tsx**
   - 简化接口，只保留必要的回调
   - 更新菜单项以符合设计规范
   - 移除未使用的图标导入

2. **PluginsWorkspace.tsx**
   - 添加 Settings 图标导入
   - 将"管理"按钮改为图标按钮
   - 更新创建菜单的回调处理
   - 添加录制技能的占位符（TODO）

3. **PluginManagementWorkspace.tsx**
   - 更新创建菜单的使用方式
   - 移除不再需要的回调

### 类型安全

- ✅ TypeScript 类型检查通过（0 errors）
- ✅ 所有组件接口更新
- ✅ 移除未使用的参数和导入

## 待实现功能

### 录制技能功能

当前"录制技能"菜单项的点击处理是一个 TODO：

```typescript
onRecordSkill={() => {
  setIsCreateMenuOpen(false)
  // TODO: 实现录制技能功能
  console.log('录制技能功能待实现')
}}
```

**下一步**：
需要根据产品需求实现录制技能的具体功能：
1. 可能是打开一个录制对话框
2. 或者导航到一个新的录制页面
3. 或者启动某种录制流程

## 用户体验改进

1. **更清晰的创建入口**：创建菜单现在只包含3个明确的选项
2. **一致的图标语言**：管理功能使用通用的齿轮图标
3. **完整的市场管理**：用户可以轻松添加、切换和删除市场源
4. **双语支持**：所有新功能都有完整的中英文翻译

## 验证清单

- ✅ 创建菜单包含：创建插件、添加插件市场、录制技能
- ✅ 管理按钮改为齿轮图标
- ✅ 市场源 tabs 正常显示
- ✅ 添加市场对话框可以打开
- ✅ 所有文本已汉化
- ✅ TypeScript 类型检查通过
- ⏳ 录制技能功能待实现

## 参考

- 设计规范：`/docs/marketplace/design-specs/00-完整交互规范文档.md`
- 多仓库管理规范：`/docs/marketplace/design-specs/03-多仓库市场管理规范.md`
- @ 创建插件规范：`/docs/marketplace/design-specs/04-@创建插件交互规范.md`
