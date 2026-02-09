# 响应式开发指南

## 概述

本指南说明如何在 Wegent 中开发响应式功能，遵循移动优先、组件分离的架构。

## 何时分离组件

### ✅ 使用独立的移动端/桌面端组件的情况：

1. **布局结构存在根本性差异（>30% 差异）**
   - 示例：桌面端有永久侧边栏，移动端使用抽屉式
   - 示例：桌面端显示多列布局，移动端显示单列

2. **不同的交互模式**
   - 示例：桌面端使用下拉菜单，移动端使用底部弹出层
   - 示例：桌面端有内联控件，移动端将它们整合到设置菜单中

3. **需要性能优化**
   - 示例：移动端版本需要简化渲染以获得更好的性能
   - 示例：代码分割有助于减小包体积

### ❌ 使用 Tailwind 响应式类的情况：

1. **仅样式差异**（间距、字体大小、颜色）
   ```tsx
   // 好：简单的样式调整
   <div className="px-4 md:px-6 lg:px-8">
     <h1 className="text-lg md:text-xl lg:text-2xl">标题</h1>
   </div>
   ```

2. **简单的显示/隐藏场景**
   ```tsx
   // 好：简单的可见性切换
   <div className="hidden md:block">仅桌面端内容</div>
   <div className="md:hidden">仅移动端内容</div>
   ```

3. **轻微的布局调整**
   ```tsx
   // 好：响应式 flex 方向
   <div className="flex flex-col md:flex-row gap-4">
     {children}
   </div>
   ```

## 架构模式

### 页面级分离

对于响应式差异显著的页面，使用以下模式：

```
app/(tasks)/chat/
├── page.tsx                 # 路由组件
├── ChatPageDesktop.tsx      # 桌面端实现
└── ChatPageMobile.tsx       # 移动端实现
```

**路由组件 (page.tsx)：**

```typescript
'use client'

import dynamic from 'next/dynamic'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

// 使用代码分割的动态导入
const ChatPageDesktop = dynamic(
  () => import('./ChatPageDesktop').then(mod => ({ default: mod.ChatPageDesktop })),
  { ssr: false }
)

const ChatPageMobile = dynamic(
  () => import('./ChatPageMobile').then(mod => ({ default: mod.ChatPageMobile })),
  { ssr: false }
)

export default function ChatPage() {
  const isMobile = useIsMobile()

  return (
    <>
      {/* 共享的处理器和设置 */}
      <OidcTokenHandler />
      <OnboardingTour {...props} />

      {/* 路由到适当的组件 */}
      {isMobile ? <ChatPageMobile /> : <ChatPageDesktop />}
    </>
  )
}
```

### 组件级分离

对于具有不同移动端/桌面端实现的单个组件：

```
features/tasks/components/input/
├── ChatInputControls.tsx        # 桌面端版本（默认）
└── MobileChatInputControls.tsx  # 移动端版本
```

**模式：**

```typescript
// ChatInputControls.tsx（包含路由逻辑）
export function ChatInputControls(props: Props) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <MobileChatInputControls {...props} />
  }

  // 桌面端实现
  return (
    <div className="flex items-center gap-3">
      {/* 桌面端布局 */}
    </div>
  )
}
```

## 响应式断点

Wegent 使用以下断点系统：

| 断点 | 屏幕尺寸 | 用途 |
|------|---------|------|
| Mobile | ≤767px | 触摸优化 UI，带抽屉式侧边栏 |
| Tablet | 768px-1023px | 使用桌面端布局，带轻微调整 |
| Desktop | ≥1024px | 全功能 UI，所有控件 |

**Hook 用法：**

```typescript
import { useIsMobile, useIsTablet, useIsDesktop } from '@/features/layout/hooks/useMediaQuery'

function MyComponent() {
  const isMobile = useIsMobile()    // max-width: 767px
  const isTablet = useIsTablet()    // 768px - 1023px
  const isDesktop = useIsDesktop()  // min-width: 1024px

  // 注意：平板设备使用桌面端布局
  return isMobile ? <MobileView /> : <DesktopView />
}
```

## 移动优先最佳实践

### 1. 触摸友好的目标

移动端上的所有交互元素必须满足最小触摸目标尺寸：

```typescript
// 触摸目标常量
const MOBILE_TOUCH_TARGET = {
  minHeight: '44px',  // iOS 人机界面指南
  minWidth: '44px',
  padding: '12px',
}

// 使用示例
<Button className="h-11 min-w-[44px] px-4">
  <Icon className="h-5 w-5" />
</Button>
```

**✅ 好的示例：**

```tsx
// 触摸友好的按钮
<button className="h-11 min-w-[44px] p-3 rounded-lg">
  <MenuIcon className="h-5 w-5" />
</button>

// 触摸友好的列表项
<div className="p-4 min-h-[44px] cursor-pointer hover:bg-surface">
  列表项
</div>
```

**❌ 不好的示例：**

```tsx
// 触摸目标太小
<button className="h-6 w-6 p-1">
  <MenuIcon />
</button>

// 内边距不足
<div className="p-1 cursor-pointer">
  可点击项
</div>
```

### 2. 移动端导航模式

**抽屉式侧边栏：**

```tsx
import { Transition, Dialog } from '@headlessui/react'

function MobileSidebar({ isOpen, onClose }: Props) {
  return (
    <Transition show={isOpen} as={Dialog} onClose={onClose}>
      {/* 遮罩层 */}
      <Transition.Child
        enter="transition-opacity ease-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in duration-200"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        className="fixed inset-0 bg-black/30 z-40"
      />

      {/* 抽屉 */}
      <Transition.Child
        enter="transition ease-out duration-300 transform"
        enterFrom="-translate-x-full"
        enterTo="translate-x-0"
        leave="transition ease-in duration-200 transform"
        leaveFrom="translate-x-0"
        leaveTo="-translate-x-full"
        className="fixed left-0 top-0 bottom-0 w-80 max-w-[85vw] bg-base border-r z-50"
      >
        {/* 侧边栏内容 */}
      </Transition.Child>
    </Transition>
  )
}
```

### 3. 性能优化

**代码分割：**

```typescript
// 使用动态导入进行基于路由的代码分割
const MobileComponent = dynamic(() => import('./MobileComponent'), {
  ssr: false,
  loading: () => <PageSkeleton />,
})
```

**懒加载：**

```typescript
import { lazy, Suspense } from 'react'

const HeavyComponent = lazy(() => import('./HeavyComponent'))

function MyComponent() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <HeavyComponent />
    </Suspense>
  )
}
```

**图片优化：**

```typescript
import Image from 'next/image'

<Image
  src={avatarUrl}
  width={40}
  height={40}
  loading="lazy"
  alt="用户头像"
/>
```

### 4. 处理水合不匹配

使用 `useIsMobile()` hook 时，避免水合不匹配：

```typescript
// ✅ 好：抑制响应式组件的水合警告
<div suppressHydrationWarning>
  {isMobile ? <MobileView /> : <DesktopView />}
</div>

// ✅ 更好：使用动态导入避免在服务器上渲染
const MobileView = dynamic(() => import('./MobileView'), { ssr: false })
const DesktopView = dynamic(() => import('./DesktopView'), { ssr: false })
```

## 代码示例

### 示例 1：完整的组件分离

**场景：** 输入控件在移动端和桌面端有根本不同的布局。

```typescript
// ChatInputControls.tsx（桌面端版本）
export function ChatInputControls(props: Props) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <MobileChatInputControls {...props} />
  }

  // 桌面端：所有控件内联
  return (
    <div className="flex items-center justify-between px-3 gap-3">
      <div className="flex-1 flex items-center gap-3">
        <ChatContextInput {...contextProps} />
        <AttachmentButton {...attachmentProps} />
        <ClarificationToggle {...clarificationProps} />
        <ModelSelector {...modelProps} />
        <RepositorySelector {...repoProps} />
      </div>
      <div className="flex items-center gap-2">
        <QuotaUsage />
        <SendButton {...sendProps} />
      </div>
    </div>
  )
}
```

```typescript
// MobileChatInputControls.tsx（移动端版本）
export function MobileChatInputControls(props: Props) {
  const [menuOpen, setMenuOpen] = useState(false)

  // 移动端：简化，设置放在下拉菜单中
  return (
    <div className="flex items-center justify-between px-3 gap-2 pb-2 pt-1">
      <div className="flex items-center gap-1">
        <AttachmentButton {...attachmentProps} />
        <ChatContextInput {...contextProps} />

        {/* 设置下拉菜单整合不常用的控件 */}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-11 min-w-[44px]">
              <Settings2 className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <ClarificationToggle {...clarificationProps} />
            <RepositorySelector {...repoProps} />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-center gap-2">
        <MobileModelSelector {...modelProps} />
        <SendButton {...sendProps} compact />
      </div>
    </div>
  )
}
```

### 示例 2：共享逻辑，不同 UI

**将共享逻辑提取到自定义 hook：**

```typescript
// hooks/useChatInputLogic.ts
export function useChatInputLogic(props: Props) {
  const [selectedModel, setSelectedModel] = useState(null)
  const [isStreaming, setIsStreaming] = useState(false)

  const handleSend = useCallback(() => {
    // 共享发送逻辑
  }, [])

  const handleStop = useCallback(() => {
    // 共享停止逻辑
  }, [])

  return {
    selectedModel,
    setSelectedModel,
    isStreaming,
    handleSend,
    handleStop,
  }
}

// 在移动端和桌面端组件中使用
function ChatInputControls(props: Props) {
  const logic = useChatInputLogic(props)
  const isMobile = useIsMobile()

  return isMobile ? (
    <MobileChatInputControls {...logic} />
  ) : (
    <DesktopChatInputControls {...logic} />
  )
}
```

## 测试响应式组件

### 单元测试

```typescript
import { render, screen } from '@testing-library/react'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

jest.mock('@/features/layout/hooks/useMediaQuery')

describe('ChatPage 响应式行为', () => {
  it('在小屏幕上渲染移动端版本', () => {
    ;(useIsMobile as jest.Mock).mockReturnValue(true)

    render(<ChatPage />)
    expect(screen.getByTestId('chat-page-mobile')).toBeInTheDocument()
  })

  it('在大屏幕上渲染桌面端版本', () => {
    ;(useIsMobile as jest.Mock).mockReturnValue(false)

    render(<ChatPage />)
    expect(screen.getByTestId('chat-page-desktop')).toBeInTheDocument()
  })

  it('移动端上触摸目标满足最小尺寸要求', () => {
    ;(useIsMobile as jest.Mock).mockReturnValue(true)

    render(<MobileChatInputControls {...props} />)
    const buttons = screen.getAllByRole('button')

    buttons.forEach(button => {
      const { height, width } = button.getBoundingClientRect()
      expect(height).toBeGreaterThanOrEqual(44)
      expect(width).toBeGreaterThanOrEqual(44)
    })
  })
})
```

### E2E 测试 (Playwright)

```typescript
// tests/e2e/responsive/mobile-navigation.spec.ts
import { test, expect } from '@playwright/test'

test.describe('移动端导航', () => {
  test.use({ viewport: { width: 375, height: 667 } }) // iPhone SE

  test('点击汉堡菜单应打开侧边栏', async ({ page }) => {
    await page.goto('/chat')
    await page.click('[aria-label="打开侧边栏"]')
    await expect(page.locator('[data-testid="mobile-sidebar"]')).toBeVisible()
  })

  test('点击遮罩层应关闭侧边栏', async ({ page }) => {
    await page.goto('/chat')
    await page.click('[aria-label="打开侧边栏"]')
    await page.click('.overlay') // 点击遮罩层
    await expect(page.locator('[data-testid="mobile-sidebar"]')).not.toBeVisible()
  })
})

test.describe('桌面端导航', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('应显示永久侧边栏', async ({ page }) => {
    await page.goto('/chat')
    await expect(page.locator('[data-testid="desktop-sidebar"]')).toBeVisible()
  })

  test('应支持侧边栏折叠', async ({ page }) => {
    await page.goto('/chat')
    await page.click('[aria-label="折叠侧边栏"]')
    await expect(page.locator('[data-testid="collapsed-sidebar"]')).toBeVisible()
  })
})
```

## 常见陷阱和解决方案

### 陷阱 1：水合不匹配

**问题：**
```tsx
// ❌ 服务器渲染一种情况，客户端渲染另一种情况
function MyComponent() {
  const isMobile = useIsMobile()
  return isMobile ? <Mobile /> : <Desktop />
}
```

**解决方案：**
```tsx
// ✅ 使用动态导入跳过 SSR
const Mobile = dynamic(() => import('./Mobile'), { ssr: false })
const Desktop = dynamic(() => import('./Desktop'), { ssr: false })

function MyComponent() {
  const isMobile = useIsMobile()
  return isMobile ? <Mobile /> : <Desktop />
}
```

### 陷阱 2：忘记触摸目标

**问题：**
```tsx
// ❌ 按钮对触摸来说太小
<button className="h-6 w-6 p-1">
  <Icon />
</button>
```

**解决方案：**
```tsx
// ✅ 触摸友好的尺寸
<button className="h-11 min-w-[44px] p-3">
  <Icon className="h-5 w-5" />
</button>
```

### 陷阱 3：重复业务逻辑

**问题：**
```tsx
// ❌ 逻辑在移动端和桌面端组件中重复
function MobileComponent() {
  const [data, setData] = useState([])
  useEffect(() => { /* 获取逻辑 */ }, [])
  // ...
}

function DesktopComponent() {
  const [data, setData] = useState([])
  useEffect(() => { /* 相同的获取逻辑 */ }, [])
  // ...
}
```

**解决方案：**
```tsx
// ✅ 将共享逻辑提取到自定义 hook
function useDataFetching() {
  const [data, setData] = useState([])
  useEffect(() => { /* 获取逻辑 */ }, [])
  return { data, setData }
}

function MobileComponent() {
  const { data, setData } = useDataFetching()
  // 仅移动端 UI
}

function DesktopComponent() {
  const { data, setData } = useDataFetching()
  // 仅桌面端 UI
}
```

## 性能优化检查清单

- [ ] 对移动端/桌面端页面组件使用 `dynamic()` 导入
- [ ] 为使用 `useIsMobile()` 的动态导入添加 `{ ssr: false }`
- [ ] 实现加载骨架屏以提高感知性能
- [ ] 对所有图片使用 `next/image` 并设置 `loading="lazy"`
- [ ] 通过路由级代码分割最小化包体积
- [ ] 对长列表使用虚拟滚动（例如 `@tanstack/react-virtual`）
- [ ] 通过适当的事件处理优化触摸交互
- [ ] 在真实移动设备上测试，而不仅仅是浏览器 DevTools

## 无障碍访问考虑

```tsx
// 始终包含适当的 ARIA 标签
<button
  aria-label="打开导航菜单"
  className="h-11 min-w-[44px]"
>
  <MenuIcon className="h-5 w-5" />
  <span className="sr-only">打开导航菜单</span>
</button>

// 支持键盘导航
<div
  role="button"
  tabIndex={0}
  onKeyDown={(e) => e.key === 'Enter' && handleClick()}
  onClick={handleClick}
>
  交互元素
</div>
```

## 总结

- **分离组件** 当布局差异超过 30%
- **使用 Tailwind 类** 进行简单的样式调整
- **提取共享逻辑** 到自定义 hooks
- **确保触摸目标** 在移动端至少为 44px × 44px
- **使用动态导入** 进行代码分割和性能优化
- **在真实设备上测试** 以确保最佳用户体验
- **记录你的决策** 以便未来维护

更多示例请参考：
- `/app/(tasks)/chat/ChatPageDesktop.tsx` 和 `ChatPageMobile.tsx`
- `/app/(tasks)/code/CodePageDesktop.tsx` 和 `CodePageMobile.tsx`
- `/features/tasks/components/input/ChatInputControls.tsx` 和 `MobileChatInputControls.tsx`
