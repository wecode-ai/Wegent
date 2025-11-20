# Wegent 设计系统文档

本文档定义了 Wegent 前端项目的统一设计系统,包括颜色、间距、字体、组件等规范。

---

## 目录

1. [设计原则](#设计原则)
2. [技术栈](#技术栈)
3. [颜色系统](#颜色系统)
4. [间距系统](#间距系统)
5. [圆角规范](#圆角规范)
6. [字体排版](#字体排版)
7. [组件库](#组件库)
8. [布局模式](#布局模式)

---

## 设计原则

### 核心理念
- **一致性**：所有页面保持统一的视觉风格和交互模式
- **简洁性**：减少视觉噪音,突出核心内容
- **响应式**：适配桌面端、平板和移动端
- **可访问性**：支持暗黑模式和无障碍访问

### 设计参考
以 `/code` 页面（代码任务页面）的 ChatArea 组件为设计标准,统一全站风格。

---

## 技术栈

### UI 框架
- **shadcn/ui**: 基于 Radix UI 的组件库
- **Radix UI**: 无障碍的 headless UI 组件
- **Tailwind CSS**: 实用优先的 CSS 框架
- **lucide-react**: 图标库

### 表单管理
- **react-hook-form**: 高性能表单管理
- **zod**: TypeScript 优先的模式验证

### 其他依赖
- **vaul**: Drawer 组件基础库
- **class-variance-authority**: 组件变体管理
- **clsx** & **tailwind-merge**: 类名合并工具

---

## 颜色系统

### 设计理念

采用 **Calm UI（安静界面）** 设计：
- **低饱和度 + 低对比度**：减少视觉疲劳
- **无阴影或极轻阴影**：保持界面简洁
- **大量留白**：提升可读性
- **组件颜色差异小**：背景层级差异 <10%
- **克制使用高亮色**：仅在操作按钮使用薄荷蓝主题色

### CSS 变量定义

所有颜色通过 CSS 变量定义，支持明亮/暗黑主题自动切换。

#### 背景色

```css
--color-bg-base: 主背景色
  • Light: rgb(255 255 255) - 纯白
  • Dark: rgb(14 15 15) - 接近全黑但略带灰 (#0E0F0F)

--color-bg-surface: 卡片/表面背景色
  • Light: rgb(247 247 248) - 浅灰 (#F7F7F8)
  • Dark: rgb(26 28 28) - 比主背景略亮 (#1A1C1C)

--color-bg-muted: 弱化背景色
  • Light: rgb(242 242 242) - 中性灰 (#F2F2F2)
  • Dark: rgb(33 36 36) - 微亮低对比度 (#212424)

--color-bg-hover: 悬停背景色
  • Light: rgb(224 224 224) - 悬停灰 (#E0E0E0)
  • Dark: rgb(42 45 45) - 轻微对比 (#2A2D2D)
```

#### 边框色

```css
--color-border: 默认边框色
  • Light: rgb(224 224 224) - 轻微对比 (#E0E0E0)
  • Dark: rgb(42 45 45) - 轻微对比 (#2A2D2D)

--color-border-strong: 强调边框色
  • Light: rgb(192 192 192) - 中等对比 (#C0C0C0)
  • Dark: rgb(52 53 53) - 稍强对比 (#343535)
```

#### 文字色

```css
--color-text-primary: 主要文字色
  • Light: rgb(26 26 26) - 深灰不刺眼 (#1A1A1A)
  • Dark: rgb(236 236 236) - 高亮白但不刺眼 (#ECECEC)

--color-text-secondary: 次要文字色
  • Light: rgb(102 102 102) - 中等灰度 (#666666)
  • Dark: rgb(212 212 212) - 低亮度灰白 (#D4D4D4)

--color-text-muted: 弱化文字色
  • Light: rgb(160 160 160) - 用于提示、时间戳 (#A0A0A0)
  • Dark: rgb(160 160 160) - 用于提示、时间戳 (#A0A0A0)

--color-text-inverted: 反转文字色
  • Light: rgb(255 255 255) - 白色
  • Dark: rgb(14 15 15) - 深色
```

#### 主题色

```css
--color-primary: 主题色（薄荷蓝）
  • rgb(20 184 166) - 薄荷蓝 (#14B8A6)

--color-primary-contrast: 主题色对比色
  • rgb(255 255 255) - 白色

--color-success: 成功色
  • rgb(20 184 166) - 与主题色一致 (#14B8A6)

--color-error: 错误色
  • Light: rgb(239 68 68) - 红色
  • Dark: rgb(248 81 73) - 红色

--color-link: 链接色
  • rgb(85 185 247) - 接近 GPT UI 的链接蓝 (#55B9F7)

--color-code-bg: 代码块背景色
  • Light: rgb(246 248 250) - 浅灰 (#F6F8FA)
  • Dark: rgb(13 17 23) - GitHub 风格深色 (#0D1117)
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
className="text-link"                          // 链接文字
className="bg-code-bg"                         // 代码块背景
```

### ChatGPT 风格配色参考

#### 暗黑主题（最常用）

| 角色 | 色值 | 说明 |
|------|------|------|
| 主背景 | `#0E0F0F` | 接近全黑但略带灰 |
| 侧边栏背景 | `#1A1C1C` | 比主背景略亮 |
| 消息框（AI） | `#212424` | 微亮、低对比度 |
| 消息框（用户） | `#171919` | 深一些，区分用户 |
| 标题文字 | `#ECECEC` | 高亮白但不刺眼 |
| 正文文字 | `#D4D4D4` | 低亮度灰白 |
| 次要文字 | `#A0A0A0` | 用于提示、时间戳 |
| 边框色 | `#2A2D2D` | 轻微对比 |
| 按钮主色 | `#14B8A6` | 薄荷蓝主题色 |
| 按钮 hover | `#0D9488` | 更深一点 |
| 链接 | `#55B9F7` | 接近 GPT UI 的链接蓝 |
| 代码块背景 | `#0D1117` | GitHub 风格深色 |

#### 浅色主题

| 角色 | 色值 | 说明 |
|------|------|------|
| 主背景 | `#FFFFFF` | 纯白 |
| 侧边栏背景 | `#F7F7F8` | 浅灰 |
| 消息框（AI） | `#F2F2F2` | 浅灰 |
| 消息框（用户） | `#FFFFFF` | 白色 |
| 正文文字 | `#1A1A1A` | 深灰 |
| 次要文字 | `#666666` | 中等灰度 |
| 边框色 | `#E0E0E0` | 轻微对比 |
| 按钮主色 | `#14B8A6` | 与暗黑主题一致 |
| 代码块背景 | `#F6F8FA` | 浅灰 |
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

本项目使用 shadcn/ui 组件系统,所有组件位于 `frontend/src/components/ui/` 目录。

### 基础组件

#### Button 按钮

**文件位置**: [`frontend/src/components/ui/button.tsx`](../frontend/src/components/ui/button.tsx)

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

#### Card 卡片

**文件位置**: [`frontend/src/components/ui/card.tsx`](../frontend/src/components/ui/card.tsx)

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

#### Input 输入框

**文件位置**: [`frontend/src/components/ui/input.tsx`](../frontend/src/components/ui/input.tsx)

基础文本输入组件,支持各种 HTML input 类型。

```jsx
import { Input } from '@/components/ui/input';

<Input type="text" placeholder="Enter text..." />
<Input type="email" placeholder="Email address" />
```

---

#### Tag 标签

**文件位置**: [`frontend/src/components/ui/tag.tsx`](../frontend/src/components/ui/tag.tsx)

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

#### Badge 徽章

**文件位置**: [`frontend/src/components/ui/badge.tsx`](../frontend/src/components/ui/badge.tsx)

用于小型状态指示器、通知数量等。

#### 使用示例

```jsx
import { Badge } from '@/components/ui/badge';

<Badge variant="success">New</Badge>
<Badge variant="error" size="sm">3</Badge>
```

#### Alert 警告提示

**文件位置**: [`frontend/src/components/ui/alert.tsx`](../frontend/src/components/ui/alert.tsx)

用于页面级别的提示信息。

```jsx
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';

<Alert variant="destructive">
  <AlertCircle className="h-4 w-4" />
  <AlertTitle>Error</AlertTitle>
  <AlertDescription>
    Your session has expired. Please log in again.
  </AlertDescription>
</Alert>
```

---

#### Spinner 加载指示器

**文件位置**: [`frontend/src/components/ui/spinner.tsx`](../frontend/src/components/ui/spinner.tsx)

用于显示加载状态。

```jsx
import { Spinner } from '@/components/ui/spinner';

<Spinner size="sm" />
<Spinner size="default" />
<Spinner size="lg" />
```

---

### 交互组件

#### Switch 开关

**文件位置**: [`frontend/src/components/ui/switch.tsx`](../frontend/src/components/ui/switch.tsx)

基于 Radix UI 的开关组件。

#### 使用示例

```jsx
import { Switch } from '@/components/ui/switch';

<div className="flex items-center space-x-2">
  <Switch id="notifications" checked={enabled} onCheckedChange={setEnabled} />
  <label htmlFor="notifications">Enable notifications</label>
</div>
```

#### Checkbox 复选框

**文件位置**: [`frontend/src/components/ui/checkbox.tsx`](../frontend/src/components/ui/checkbox.tsx)

```jsx
import { Checkbox } from '@/components/ui/checkbox';

<div className="flex items-center space-x-2">
  <Checkbox id="terms" checked={accepted} onCheckedChange={setAccepted} />
  <label htmlFor="terms">Accept terms and conditions</label>
</div>
```

---

#### Radio Group 单选框组

**文件位置**: [`frontend/src/components/ui/radio-group.tsx`](../frontend/src/components/ui/radio-group.tsx)

```jsx
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';

<RadioGroup value={value} onValueChange={setValue}>
  <div className="flex items-center space-x-2">
    <RadioGroupItem value="option1" id="option1" />
    <Label htmlFor="option1">Option 1</Label>
  </div>
  <div className="flex items-center space-x-2">
    <RadioGroupItem value="option2" id="option2" />
    <Label htmlFor="option2">Option 2</Label>
  </div>
</RadioGroup>
```

---

#### Select 选择器

**文件位置**: [`frontend/src/components/ui/select.tsx`](../frontend/src/components/ui/select.tsx)

```jsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

<Select value={value} onValueChange={setValue}>
  <SelectTrigger>
    <SelectValue placeholder="Select an option" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="option1">Option 1</SelectItem>
    <SelectItem value="option2">Option 2</SelectItem>
  </SelectContent>
</Select>
```

---

### 反馈组件

#### Dialog 对话框

**文件位置**: [`frontend/src/components/ui/dialog.tsx`](../frontend/src/components/ui/dialog.tsx)

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

#### Drawer 抽屉

**文件位置**: [`frontend/src/components/ui/drawer.tsx`](../frontend/src/components/ui/drawer.tsx)

基于 vaul 的抽屉组件,用于从屏幕边缘滑出的面板。

```jsx
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription, DrawerFooter } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';

<Drawer open={open} onOpenChange={setOpen}>
  <DrawerContent>
    <DrawerHeader>
      <DrawerTitle>Edit Profile</DrawerTitle>
      <DrawerDescription>Make changes to your profile here.</DrawerDescription>
    </DrawerHeader>
    <div className="p-4">
      {/* Content */}
    </div>
    <DrawerFooter>
      <Button onClick={handleSave}>Save</Button>
      <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
    </DrawerFooter>
  </DrawerContent>
</Drawer>
```

---

#### Toast 通知

**文件位置**:
- [`frontend/src/components/ui/toast.tsx`](../frontend/src/components/ui/toast.tsx)
- [`frontend/src/components/ui/toaster.tsx`](../frontend/src/components/ui/toaster.tsx)
- [`frontend/src/hooks/use-toast.ts`](../frontend/src/hooks/use-toast.ts)

用于显示临时通知消息。

```jsx
import { useToast } from '@/hooks/use-toast';

const { toast } = useToast();

// 成功提示
toast({
  title: "Success",
  description: "Your changes have been saved.",
});

// 错误提示
toast({
  variant: "destructive",
  title: "Error",
  description: "Something went wrong.",
});
```

**注意**: 需要在根布局中添加 `<Toaster />` 组件。

---

#### Tooltip 工具提示

**文件位置**: [`frontend/src/components/ui/tooltip.tsx`](../frontend/src/components/ui/tooltip.tsx)

```jsx
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

<TooltipProvider>
  <Tooltip>
    <TooltipTrigger asChild>
      <Button variant="ghost" size="icon">
        <InfoIcon className="h-4 w-4" />
      </Button>
    </TooltipTrigger>
    <TooltipContent>
      <p>Additional information</p>
    </TooltipContent>
  </Tooltip>
</TooltipProvider>
```

---

### 导航组件

#### Dropdown Menu 下拉菜单

**文件位置**: [`frontend/src/components/ui/dropdown-menu.tsx`](../frontend/src/components/ui/dropdown-menu.tsx)

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

### 表单组件

#### Form 表单

**文件位置**: [`frontend/src/components/ui/form.tsx`](../frontend/src/components/ui/form.tsx)

基于 react-hook-form 的表单组件系统。

```jsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const formSchema = z.object({
  username: z.string().min(2).max(50),
  email: z.string().email(),
});

function MyForm() {
  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      username: "",
      email: "",
    },
  });

  function onSubmit(values) {
    console.log(values);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Username</FormLabel>
              <FormControl>
                <Input placeholder="Enter username" {...field} />
              </FormControl>
              <FormDescription>This is your public display name.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit">Submit</Button>
      </form>
    </Form>
  );
}
```

---

#### Label 标签

**文件位置**: [`frontend/src/components/ui/label.tsx`](../frontend/src/components/ui/label.tsx)

表单标签组件。

```jsx
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

<div className="space-y-2">
  <Label htmlFor="email">Email</Label>
  <Input id="email" type="email" />
</div>
```

---

### 数据展示组件

#### Transfer 穿梭框

**文件位置**: [`frontend/src/components/ui/transfer.tsx`](../frontend/src/components/ui/transfer.tsx)

用于在两个列表之间移动项目。

```jsx
import { Transfer } from '@/components/ui/transfer';

<Transfer
  dataSource={allItems}
  targetKeys={selectedKeys}
  onChange={setSelectedKeys}
  render={item => item.title}
/>
```

---

#### Scroll Area 滚动区域

**文件位置**: [`frontend/src/components/ui/scroll-area.tsx`](../frontend/src/components/ui/scroll-area.tsx)

自定义滚动条的滚动容器。

```jsx
import { ScrollArea } from '@/components/ui/scroll-area';

<ScrollArea className="h-[200px] w-full rounded-md border p-4">
  {/* Long content */}
</ScrollArea>
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

## 相关资源

### 官方文档
- [Tailwind CSS](https://tailwindcss.com/docs) - CSS 框架
- [Radix UI](https://www.radix-ui.com/) - Headless UI 组件
- [shadcn/ui](https://ui.shadcn.com/) - 组件库参考
- [React Hook Form](https://react-hook-form.com/) - 表单管理
- [Zod](https://zod.dev/) - 模式验证
- [lucide-react](https://lucide.dev/) - 图标库

### 项目参考
- [ChatArea 组件](../frontend/src/features/tasks/components/ChatArea.tsx) - 设计标准参考
- [组件目录](../frontend/src/components/ui/) - 所有 UI 组件

---

**维护者**: Wegent Team
**最后更新**: 2025-01-20
**版本**: 2.2.0 - 采用薄荷蓝主题色配色方案
