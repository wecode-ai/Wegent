# Wegent 设计系统文档

本文档定义了 Wegent 前端项目的统一设计系统，包括颜色、间距、字体、组件等规范。

---

## 目录

1. [设计原则](#设计原则)
2. [颜色系统](#颜色系统)
3. [间距系统](#间距系统)
4. [圆角规范](#圆角规范)
5. [字体排版](#字体排版)
6. [组件库](#组件库)
7. [布局模式](#布局模式)

---

## 设计原则

### 核心理念
- **一致性**：所有页面保持统一的视觉风格和交互模式
- **简洁性**：减少视觉噪音，突出核心内容
- **响应式**：适配桌面端、平板和移动端
- **可访问性**：支持暗黑模式和无障碍访问

### 设计参考
以 `/code` 页面（代码任务页面）的 ChatArea 组件为设计标准，统一全站风格。

---

## 颜色系统

### CSS 变量定义

所有颜色通过 CSS 变量定义，支持明亮/暗黑主题自动切换。

#### 背景色

```css
--color-bg-base: 主背景色
  • Light: rgb(255 255 255)
  • Dark: rgb(33 33 33)

--color-bg-surface: 卡片/表面背景色
  • Light: rgb(247 247 248)
  • Dark: rgb(52 53 65)

--color-bg-muted: 弱化背景色
  • Light: rgb(249 250 251)
  • Dark: rgb(64 65 79)

--color-bg-hover: 悬停背景色
  • Light: rgb(236 236 241)
  • Dark: rgb(64 65 79)
```

#### 边框色

```css
--color-border: 默认边框色
  • Light: rgb(217 217 227)
  • Dark: rgb(64 65 79)

--color-border-strong: 强调边框色
  • Light: rgb(192 192 207)
  • Dark: rgb(86 88 105)
```

#### 文字色

```css
--color-text-primary: 主要文字色
  • Light: rgb(13 13 13)
  • Dark: rgb(236 236 241)

--color-text-secondary: 次要文字色
  • Light: rgb(64 64 64)
  • Dark: rgb(217 217 227)

--color-text-muted: 弱化文字色
  • Light: rgb(115 115 115)
  • Dark: rgb(172 172 190)

--color-text-inverted: 反转文字色
  • Light: rgb(255 255 255)
  • Dark: rgb(33 33 33)
```

#### 主题色

```css
--color-primary: 主题色
  • rgb(16 163 127) - 青绿色

--color-primary-contrast: 主题色对比色
  • rgb(255 255 255)

--color-success: 成功色
  • Light: rgb(34 197 94)
  • Dark: rgb(86 211 100)

--color-error: 错误色
  • Light: rgb(239 68 68)
  • Dark: rgb(248 81 73)
```

### Tailwind 使用方式

```jsx
// 背景色
className="bg-base"          // 主背景
className="bg-surface"       // 卡片背景
className="bg-muted"         // 弱化背景
className="bg-hover"         // 悬停背景

// 文字色
className="text-text-primary"    // 主要文字
className="text-text-secondary"  // 次要文字
className="text-text-muted"      // 弱化文字

// 边框色
className="border-border"         // 默认边框
className="border-border-strong"  // 强调边框

// 主题色
className="bg-primary text-primary-contrast"  // 主题按钮
className="text-primary"                       // 主题色文字
className="bg-success"                         // 成功状态
className="bg-error"                           // 错误状态
```

---

## 间距系统

基于 Tailwind 的标准间距（1 单位 = 0.25rem = 4px）。

### 标准间距

| 类名 | 尺寸 | 用途 |
|------|------|------|
| `p-2` | 8px | 小元素内边距 |
| `p-3` | 12px | 中等元素内边距 |
| `p-4` | 16px | 默认卡片内边距 |
| `p-6` | 24px | 大卡片内边距 |
| `gap-2` | 8px | 小间距 |
| `gap-3` | 12px | 默认间距 |
| `gap-4` | 16px | 较大间距 |
| `space-y-3` | 12px | 垂直堆叠间距 |

### 使用示例

```jsx
// 卡片内边距
<Card className="p-4">...</Card>

// 元素间隔
<div className="flex gap-3">...</div>

// 垂直堆叠
<div className="space-y-3">
  <Card>...</Card>
  <Card>...</Card>
</div>

// 页面边距（响应式）
<div className="px-4 sm:px-6">...</div>
```

---

## 圆角规范

### 分级使用

根据元素类型使用不同级别的圆角：

| 级别 | Tailwind 类名 | 尺寸 | 用途 |
|------|--------------|------|------|
| **大卡片** | `rounded-2xl` | 16px | 容器类：ChatArea 输入卡片、Modal |
| **中等卡片** | `rounded-lg` | 12px | 列表项：BotList/TeamList 卡片、Dropdown |
| **小元素** | `rounded-md` | 6px | 按钮、Tag、Input |
| **微小元素** | `rounded-sm` | 4px | Badge（使用 rounded-full 为完全圆形） |
| **圆形** | `rounded-full` | ∞ | Badge、Avatar、状态指示点 |

### 使用示例

```jsx
// 大卡片 - 输入区域
<div className="rounded-2xl border border-border bg-base shadow-lg">
  ...
</div>

// 中等卡片 - 列表项
<Card className="rounded-lg">
  ...
</Card>

// 小元素 - 按钮
<Button className="rounded-md">
  ...
</Button>

// 圆形 - Badge
<Badge className="rounded-full">
  ...
</Badge>
```

---

## 字体排版

### 字体层级

| 层级 | Tailwind 类名 | 尺寸 | 字重 | 用途 |
|------|--------------|------|------|------|
| **H1** | `text-xl font-semibold` | 20px | 600 | 页面主标题 |
| **H2** | `text-lg font-semibold` | 18px | 600 | 区块标题 |
| **H3** | `text-base font-medium` | 16px | 500 | 卡片标题、列表项标题 |
| **正文** | `text-sm` | 14px | 400 | 正文内容、按钮文字 |
| **辅助** | `text-xs text-text-muted` | 12px | 400 | 辅助信息、状态文字 |

### 使用示例

```jsx
// 页面标题
<h2 className="text-xl font-semibold text-text-primary mb-1">
  Bots Management
</h2>

// 区块说明
<p className="text-sm text-text-muted mb-1">
  Manage your AI bots and configurations
</p>

// 卡片标题
<h3 className="text-base font-medium text-text-primary">
  Bot Name
</h3>

// 辅助信息
<span className="text-xs text-text-muted">
  Active • 2 days ago
</span>
```

---

## 组件库

### Button 按钮

**文件位置**：`/components/ui/button.tsx`

#### 变体 (variants)

| 变体 | 样式 | 用途 |
|------|------|------|
| `default` | 主题色背景 | 主要操作 |
| `secondary` | 边框+透明背景 | 次要操作 |
| `ghost` | 无边框+透明背景 | 图标按钮、文字按钮 |
| `outline` | 边框+透明背景 | 轮廓按钮 |
| `link` | 下划线文字 | 链接样式 |

#### 尺寸 (sizes)

- `sm`: 高度 36px
- `default`: 高度 40px
- `lg`: 高度 44px
- `icon`: 40×40px 正方形

#### 使用示例

```jsx
import { Button } from '@/components/ui/button';

// 主要按钮
<Button variant="default">Save</Button>

// 次要按钮
<Button variant="secondary">Cancel</Button>

// 图标按钮
<Button variant="ghost" size="icon">
  <PencilIcon className="w-4 h-4" />
</Button>

// 危险操作
<Button className="bg-error hover:bg-error/90">
  Delete
</Button>
```

---

### Card 卡片

**文件位置**：`/components/ui/card.tsx`

#### 变体 (variants)

- `default`: 默认边框卡片
- `elevated`: 带阴影的卡片
- `ghost`: 无边框卡片

#### 内边距 (padding)

- `none`: 无内边距
- `sm`: p-3 (12px)
- `default`: p-4 (16px)
- `lg`: p-6 (24px)

#### 使用示例

```jsx
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

// 基础卡片
<Card className="p-4 hover:shadow-md transition-shadow">
  <div className="flex items-center justify-between">
    <h3>Card Title</h3>
    <Button variant="ghost" size="icon">
      <PencilIcon className="w-4 h-4" />
    </Button>
  </div>
</Card>

// 结构化卡片
<Card>
  <CardHeader>
    <CardTitle>Settings</CardTitle>
  </CardHeader>
  <CardContent>
    ...
  </CardContent>
</Card>
```

---

### Tag 标签

**文件位置**：`/components/ui/tag.tsx`

#### 变体 (variants)

| 变体 | 样式 | 用途 |
|------|------|------|
| `default` | 灰色边框+背景 | 默认标签 |
| `success` | 绿色边框+背景 | 成功状态 |
| `error` | 红色边框+背景 | 错误状态 |
| `warning` | 橙色边框+背景 | 警告状态 |
| `info` | 主题色边框+背景 | 信息标签 |

#### 使用示例

```jsx
import { Tag } from '@/components/ui/tag';

<Tag variant="default">Agent Name</Tag>
<Tag variant="success">Active</Tag>
<Tag variant="info" closable onClose={() => {}}>
  Filter Tag
</Tag>
```

---

### Badge 徽章

**文件位置**：`/components/ui/badge.tsx`

用于小型状态指示器、通知数量等。

#### 使用示例

```jsx
import { Badge } from '@/components/ui/badge';

<Badge variant="success">New</Badge>
<Badge variant="error" size="sm">3</Badge>
```

---

### Switch 开关

**文件位置**：`/components/ui/switch.tsx`

基于 Radix UI 的开关组件。

#### 使用示例

```jsx
import { Switch } from '@/components/ui/switch';

<div className="flex items-center space-x-2">
  <Switch id="notifications" checked={enabled} onCheckedChange={setEnabled} />
  <label htmlFor="notifications">Enable notifications</label>
</div>
```

---

### Dialog 对话框

**文件位置**：`/components/ui/dialog.tsx`

替代 Ant Design Modal 的对话框组件。

#### 使用示例

```jsx
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

<Dialog open={open} onOpenChange={setOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Confirm Delete</DialogTitle>
      <DialogDescription>
        Are you sure you want to delete this item?
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button className="bg-error hover:bg-error/90" onClick={onConfirm}>
        Delete
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

---

### Dropdown 下拉菜单

**文件位置**：`/components/ui/dropdown.tsx`

基于 Radix UI 的下拉菜单组件。

#### 使用示例

```jsx
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown';
import { Button } from '@/components/ui/button';

<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button variant="ghost" size="icon">
      <EllipsisVerticalIcon className="w-4 h-4" />
    </Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onClick={handleEdit}>
      <PencilIcon className="w-4 h-4 mr-2" />
      Edit
    </DropdownMenuItem>
    <DropdownMenuItem danger onClick={handleDelete}>
      <TrashIcon className="w-4 h-4 mr-2" />
      Delete
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

---

## 布局模式

### 卡片式列表布局

用于设置页面的 BotList、TeamList 等组件。

#### 设计要点

1. **卡片间距**：使用 `space-y-3` (12px 垂直间距)
2. **卡片内边距**：使用 `p-4` (16px)
3. **卡片圆角**：使用 `rounded-lg` (12px)
4. **悬停效果**：`hover:shadow-md transition-shadow`
5. **移除分隔线**：不再使用 border-t 分隔，卡片间的空白已足够

#### 代码示例

```jsx
{/* 列表容器 */}
<div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
  {items.map(item => (
    <Card key={item.id} className="p-4 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between min-w-0">
        {/* 左侧内容 */}
        <div className="flex items-center space-x-3 min-w-0 flex-1">
          <Icon className="w-5 h-5 text-primary flex-shrink-0" />
          <div className="flex flex-col min-w-0 flex-1">
            <h3 className="text-base font-medium text-text-primary truncate">
              {item.name}
            </h3>
            <div className="flex gap-1.5 mt-2">
              <Tag variant="default">{item.type}</Tag>
              <Tag variant="info">{item.status}</Tag>
            </div>
          </div>
        </div>

        {/* 右侧操作按钮 */}
        <div className="flex gap-1 ml-3">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <PencilIcon className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 hover:text-error">
            <TrashIcon className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Card>
  ))}
</div>
```

---

### 任务页面布局（三栏）

**参考**：`/app/(tasks)/code/page.tsx`

- **左栏**：任务侧边栏 (TaskSidebar)
- **中栏**：聊天/代码区域 (ChatArea / Workbench)
- **右栏**：（可选）详情面板

#### 特点

- 响应式：移动端单栏，桌面端三栏
- 可调整宽度：使用 ResizableSidebar
- 固定布局：防止内容溢出

---

### 设置页面布局

**结构**：侧边导航 + 内容区

```
┌─────────────┬──────────────────────────┐
│             │                          │
│  Settings   │   Content Area           │
│  Nav        │   (BotList/TeamList)     │
│             │                          │
└─────────────┴──────────────────────────┘
```

---

### 登录页面布局

**特点**：居中卡片布局

```jsx
<div className="flex items-center justify-center min-h-screen">
  <Card className="w-full max-w-md p-8 rounded-2xl">
    <h1 className="text-2xl font-bold mb-6">Login</h1>
    {/* 表单内容 */}
  </Card>
</div>
```

---

## 响应式断点

遵循 Tailwind 默认断点：

| 断点 | 最小宽度 | 用途 |
|------|---------|------|
| `sm` | 640px | 小屏幕 |
| `md` | 768px | 平板 |
| `lg` | 1024px | 桌面 |
| `xl` | 1280px | 大屏 |

### 使用示例

```jsx
<div className="px-4 sm:px-6">  {/* 响应式内边距 */}
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">  {/* 响应式网格 */}
<p className="hidden sm:block">  {/* 小屏隐藏 */}
```

---

## 暗黑模式

### 实现方式

通过 `data-theme="dark"` 属性自动切换 CSS 变量。

### 注意事项

1. 使用 CSS 变量定义颜色，自动适配主题
2. 避免硬编码颜色值
3. 测试两种主题下的可读性

---

## 迁移指南

### 从 Ant Design 迁移

| Ant Design | 自定义组件 | 说明 |
|-----------|----------|------|
| `<Button type="primary">` | `<Button variant="default">` | 主要按钮 |
| `<Button type="default">` | `<Button variant="secondary">` | 次要按钮 |
| `<Button type="text">` | `<Button variant="ghost">` | 文字按钮 |
| `<Modal>` | `<Dialog>` | 对话框 |
| `<Tag>` | `<Tag variant="default">` | 标签 |
| `<Dropdown>` | `<DropdownMenu>` | 下拉菜单 |
| `<Switch>` | `<Switch>` | 开关 |

### 迁移示例

**Before (Ant Design):**
```jsx
<Button type="text" size="small" onClick={handleEdit}>
  <PencilIcon />
</Button>
```

**After (Custom Components):**
```jsx
<Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleEdit}>
  <PencilIcon className="w-4 h-4" />
</Button>
```

---

## 最佳实践

### 1. 使用语义化类名

```jsx
// ✅ Good
<div className="flex items-center gap-3">

// ❌ Bad
<div className="flex items-center space-x-3 ml-2 mr-2">
```

### 2. 保持一致的间距

```jsx
// ✅ Good - 统一使用 gap
<div className="flex gap-3">
  <Button>Action 1</Button>
  <Button>Action 2</Button>
</div>

// ❌ Bad - 混用不同间距方式
<div className="flex">
  <Button className="mr-2">Action 1</Button>
  <Button className="ml-1">Action 2</Button>
</div>
```

### 3. 响应式优先

```jsx
// ✅ Good - 移动端优先
<div className="px-4 sm:px-6 lg:px-8">

// ❌ Bad - 桌面端优先
<div className="px-8 sm:px-6 xs:px-4">
```

### 4. 使用组合而非继承

```jsx
// ✅ Good - 组合 Card 和 Button
<Card className="p-4">
  <Button variant="ghost">Edit</Button>
</Card>

// ❌ Bad - 创建特殊的 EditableCard
<EditableCard onEdit={...} />
```

---

## 开发工具

### VS Code 插件推荐

- **Tailwind CSS IntelliSense**: 自动补全 Tailwind 类名
- **Headwind**: 自动排序 Tailwind 类名
- **PostCSS Language Support**: CSS 变量支持

### 调试技巧

```jsx
// 使用 Tailwind 的调试类
<div className="debug-screens">  {/* 显示当前断点 */}
```

---

## 更新日志

### v1.0.0 (2025-01-XX)

- ✅ 创建设计系统文档
- ✅ 定义颜色、间距、圆角、字体规范
- ✅ 创建基础组件：Button, Card, Tag, Badge, Switch, Dialog, Dropdown
- ✅ 改造 BotList 为卡片式布局
- ⏳ 计划改造 TeamList、其他设置页面组件
- ⏳ 计划统一任务页面组件样式

---

## 相关资源

- [Tailwind CSS 官方文档](https://tailwindcss.com/docs)
- [Radix UI 组件库](https://www.radix-ui.com/)
- [shadcn/ui 设计参考](https://ui.shadcn.com/)
- [Wegent ChatArea 组件](../frontend/src/features/tasks/components/ChatArea.tsx) - 设计标准参考

---

**维护者**: Wegent Team
**最后更新**: 2025-01
**版本**: 1.0.0
