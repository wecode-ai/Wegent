# Responsive Development Guide

## Overview

This guide explains how to develop responsive features in Wegent, following the mobile-first, component-separation architecture.

## When to Separate Components

### ✅ Use Separate Mobile/Desktop Components When:

1. **Layout structure is fundamentally different (>30% difference)**
   - Example: Desktop has a permanent sidebar, mobile uses a drawer
   - Example: Desktop shows a multi-column layout, mobile shows a single column

2. **Different interaction patterns**
   - Example: Desktop uses dropdown menu, mobile uses bottom sheet
   - Example: Desktop has inline controls, mobile consolidates them in a settings menu

3. **Performance optimization needed**
   - Example: Mobile version needs simplified rendering for better performance
   - Example: Code splitting is beneficial to reduce bundle size

### ❌ Use Tailwind Responsive Classes When:

1. **Only styling differences** (spacing, font size, colors)
   ```tsx
   // Good: Simple styling adjustments
   <div className="px-4 md:px-6 lg:px-8">
     <h1 className="text-lg md:text-xl lg:text-2xl">Title</h1>
   </div>
   ```

2. **Simple show/hide scenarios**
   ```tsx
   // Good: Simple visibility toggle
   <div className="hidden md:block">Desktop only content</div>
   <div className="md:hidden">Mobile only content</div>
   ```

3. **Minor layout adjustments**
   ```tsx
   // Good: Responsive flex direction
   <div className="flex flex-col md:flex-row gap-4">
     {children}
   </div>
   ```

## Architecture Pattern

### Page-Level Separation

For pages with significant responsive differences, use the following pattern:

```
app/(tasks)/chat/
├── page.tsx                 # Router component
├── ChatPageDesktop.tsx      # Desktop implementation
└── ChatPageMobile.tsx       # Mobile implementation
```

**Router Component (page.tsx):**

```typescript
'use client'

import dynamic from 'next/dynamic'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

// Dynamic imports with code splitting
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
      {/* Shared handlers and setup */}
      <OidcTokenHandler />
      <OnboardingTour {...props} />

      {/* Route to appropriate component */}
      {isMobile ? <ChatPageMobile /> : <ChatPageDesktop />}
    </>
  )
}
```

### Component-Level Separation

For individual components with different mobile/desktop implementations:

```
features/tasks/components/input/
├── ChatInputControls.tsx        # Desktop version (default)
└── MobileChatInputControls.tsx  # Mobile version
```

**Pattern:**

```typescript
// ChatInputControls.tsx (contains routing logic)
export function ChatInputControls(props: Props) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <MobileChatInputControls {...props} />
  }

  // Desktop implementation
  return (
    <div className="flex items-center gap-3">
      {/* Desktop layout */}
    </div>
  )
}
```

## Responsive Breakpoints

Wegent uses the following breakpoint system:

| Breakpoint | Screen Size | Usage |
|------------|------------|-------|
| Mobile | ≤767px | Touch-optimized UI with drawer sidebar |
| Tablet | 768px-1023px | Uses desktop layout with minor adjustments |
| Desktop | ≥1024px | Full-featured UI with all controls |

**Hook Usage:**

```typescript
import { useIsMobile, useIsTablet, useIsDesktop } from '@/features/layout/hooks/useMediaQuery'

function MyComponent() {
  const isMobile = useIsMobile()    // max-width: 767px
  const isTablet = useIsTablet()    // 768px - 1023px
  const isDesktop = useIsDesktop()  // min-width: 1024px

  // Note: Tablet devices use desktop layout
  return isMobile ? <MobileView /> : <DesktopView />
}
```

## Mobile-First Best Practices

### 1. Touch-Friendly Targets

All interactive elements on mobile must meet the minimum touch target size:

```typescript
// Constants for touch targets
const MOBILE_TOUCH_TARGET = {
  minHeight: '44px',  // iOS Human Interface Guidelines
  minWidth: '44px',
  padding: '12px',
}

// Example usage
<Button className="h-11 min-w-[44px] px-4">
  <Icon className="h-5 w-5" />
</Button>
```

**✅ Good Examples:**

```tsx
// Touch-friendly button
<button className="h-11 min-w-[44px] p-3 rounded-lg">
  <MenuIcon className="h-5 w-5" />
</button>

// Touch-friendly list item
<div className="p-4 min-h-[44px] cursor-pointer hover:bg-surface">
  List Item
</div>
```

**❌ Bad Examples:**

```tsx
// Too small for touch
<button className="h-6 w-6 p-1">
  <MenuIcon />
</button>

// Insufficient padding
<div className="p-1 cursor-pointer">
  Clickable Item
</div>
```

### 2. Mobile Navigation Patterns

**Drawer Sidebar:**

```tsx
import { Transition, Dialog } from '@headlessui/react'

function MobileSidebar({ isOpen, onClose }: Props) {
  return (
    <Transition show={isOpen} as={Dialog} onClose={onClose}>
      {/* Overlay */}
      <Transition.Child
        enter="transition-opacity ease-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in duration-200"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        className="fixed inset-0 bg-black/30 z-40"
      />

      {/* Drawer */}
      <Transition.Child
        enter="transition ease-out duration-300 transform"
        enterFrom="-translate-x-full"
        enterTo="translate-x-0"
        leave="transition ease-in duration-200 transform"
        leaveFrom="translate-x-0"
        leaveTo="-translate-x-full"
        className="fixed left-0 top-0 bottom-0 w-80 max-w-[85vw] bg-base border-r z-50"
      >
        {/* Sidebar content */}
      </Transition.Child>
    </Transition>
  )
}
```

### 3. Performance Optimization

**Code Splitting:**

```typescript
// Use dynamic imports for route-based code splitting
const MobileComponent = dynamic(() => import('./MobileComponent'), {
  ssr: false,
  loading: () => <PageSkeleton />,
})
```

**Lazy Loading:**

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

**Image Optimization:**

```typescript
import Image from 'next/image'

<Image
  src={avatarUrl}
  width={40}
  height={40}
  loading="lazy"
  alt="User avatar"
/>
```

### 4. Handling Hydration Mismatches

When using `useIsMobile()` hook, avoid hydration mismatches:

```typescript
// ✅ Good: Suppress hydration warning for responsive components
<div suppressHydrationWarning>
  {isMobile ? <MobileView /> : <DesktopView />}
</div>

// ✅ Better: Use dynamic imports to avoid rendering on server
const MobileView = dynamic(() => import('./MobileView'), { ssr: false })
const DesktopView = dynamic(() => import('./DesktopView'), { ssr: false })
```

## Code Examples

### Example 1: Complete Component Separation

**Scenario:** Input controls have fundamentally different layouts on mobile vs desktop.

```typescript
// ChatInputControls.tsx (Desktop version)
export function ChatInputControls(props: Props) {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <MobileChatInputControls {...props} />
  }

  // Desktop: All controls inline
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
// MobileChatInputControls.tsx (Mobile version)
export function MobileChatInputControls(props: Props) {
  const [menuOpen, setMenuOpen] = useState(false)

  // Mobile: Simplified with settings in dropdown
  return (
    <div className="flex items-center justify-between px-3 gap-2 pb-2 pt-1">
      <div className="flex items-center gap-1">
        <AttachmentButton {...attachmentProps} />
        <ChatContextInput {...contextProps} />

        {/* Settings dropdown consolidates less-used controls */}
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

### Example 2: Shared Logic with Different UIs

**Extract shared logic into a custom hook:**

```typescript
// hooks/useChatInputLogic.ts
export function useChatInputLogic(props: Props) {
  const [selectedModel, setSelectedModel] = useState(null)
  const [isStreaming, setIsStreaming] = useState(false)

  const handleSend = useCallback(() => {
    // Shared send logic
  }, [])

  const handleStop = useCallback(() => {
    // Shared stop logic
  }, [])

  return {
    selectedModel,
    setSelectedModel,
    isStreaming,
    handleSend,
    handleStop,
  }
}

// Use in both mobile and desktop components
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

## Testing Responsive Components

### Unit Tests

```typescript
import { render, screen } from '@testing-library/react'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

jest.mock('@/features/layout/hooks/useMediaQuery')

describe('ChatPage Responsive Behavior', () => {
  it('renders mobile version on small screens', () => {
    ;(useIsMobile as jest.Mock).mockReturnValue(true)

    render(<ChatPage />)
    expect(screen.getByTestId('chat-page-mobile')).toBeInTheDocument()
  })

  it('renders desktop version on large screens', () => {
    ;(useIsMobile as jest.Mock).mockReturnValue(false)

    render(<ChatPage />)
    expect(screen.getByTestId('chat-page-desktop')).toBeInTheDocument()
  })

  it('touch targets meet minimum size requirements on mobile', () => {
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

### E2E Tests (Playwright)

```typescript
// tests/e2e/responsive/mobile-navigation.spec.ts
import { test, expect } from '@playwright/test'

test.describe('Mobile Navigation', () => {
  test.use({ viewport: { width: 375, height: 667 } }) // iPhone SE

  test('should open sidebar on hamburger click', async ({ page }) => {
    await page.goto('/chat')
    await page.click('[aria-label="Open sidebar"]')
    await expect(page.locator('[data-testid="mobile-sidebar"]')).toBeVisible()
  })

  test('should close sidebar on overlay click', async ({ page }) => {
    await page.goto('/chat')
    await page.click('[aria-label="Open sidebar"]')
    await page.click('.overlay') // Click overlay
    await expect(page.locator('[data-testid="mobile-sidebar"]')).not.toBeVisible()
  })
})

test.describe('Desktop Navigation', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('should show permanent sidebar', async ({ page }) => {
    await page.goto('/chat')
    await expect(page.locator('[data-testid="desktop-sidebar"]')).toBeVisible()
  })

  test('should support sidebar collapse', async ({ page }) => {
    await page.goto('/chat')
    await page.click('[aria-label="Collapse sidebar"]')
    await expect(page.locator('[data-testid="collapsed-sidebar"]')).toBeVisible()
  })
})
```

## Common Pitfalls and Solutions

### Pitfall 1: Hydration Mismatch

**Problem:**
```tsx
// ❌ Server renders one thing, client renders another
function MyComponent() {
  const isMobile = useIsMobile()
  return isMobile ? <Mobile /> : <Desktop />
}
```

**Solution:**
```tsx
// ✅ Use dynamic import to skip SSR
const Mobile = dynamic(() => import('./Mobile'), { ssr: false })
const Desktop = dynamic(() => import('./Desktop'), { ssr: false })

function MyComponent() {
  const isMobile = useIsMobile()
  return isMobile ? <Mobile /> : <Desktop />
}
```

### Pitfall 2: Forgetting Touch Targets

**Problem:**
```tsx
// ❌ Button too small for touch
<button className="h-6 w-6 p-1">
  <Icon />
</button>
```

**Solution:**
```tsx
// ✅ Touch-friendly size
<button className="h-11 min-w-[44px] p-3">
  <Icon className="h-5 w-5" />
</button>
```

### Pitfall 3: Duplicating Business Logic

**Problem:**
```tsx
// ❌ Logic duplicated in mobile and desktop components
function MobileComponent() {
  const [data, setData] = useState([])
  useEffect(() => { /* fetch logic */ }, [])
  // ...
}

function DesktopComponent() {
  const [data, setData] = useState([])
  useEffect(() => { /* same fetch logic */ }, [])
  // ...
}
```

**Solution:**
```tsx
// ✅ Extract shared logic to custom hook
function useDataFetching() {
  const [data, setData] = useState([])
  useEffect(() => { /* fetch logic */ }, [])
  return { data, setData }
}

function MobileComponent() {
  const { data, setData } = useDataFetching()
  // Mobile UI only
}

function DesktopComponent() {
  const { data, setData } = useDataFetching()
  // Desktop UI only
}
```

## Performance Optimization Checklist

- [ ] Use `dynamic()` imports for mobile/desktop page components
- [ ] Add `{ ssr: false }` to dynamic imports that use `useIsMobile()`
- [ ] Implement loading skeletons for better perceived performance
- [ ] Use `next/image` for all images with `loading="lazy"`
- [ ] Minimize bundle size by code splitting at route level
- [ ] Use virtual scrolling for long lists (e.g., `@tanstack/react-virtual`)
- [ ] Optimize touch interactions with proper event handling
- [ ] Test on real mobile devices, not just browser DevTools

## Accessibility Considerations

```tsx
// Always include proper ARIA labels
<button
  aria-label="Open navigation menu"
  className="h-11 min-w-[44px]"
>
  <MenuIcon className="h-5 w-5" />
  <span className="sr-only">Open navigation menu</span>
</button>

// Support keyboard navigation
<div
  role="button"
  tabIndex={0}
  onKeyDown={(e) => e.key === 'Enter' && handleClick()}
  onClick={handleClick}
>
  Interactive element
</div>
```

## Summary

- **Separate components** when layout differences exceed 30%
- **Use Tailwind classes** for simple styling adjustments
- **Extract shared logic** into custom hooks
- **Ensure touch targets** are at least 44px × 44px on mobile
- **Use dynamic imports** for code splitting and performance
- **Test on real devices** to ensure optimal UX
- **Document your decisions** for future maintainability

For more examples, refer to:
- `/app/(tasks)/chat/ChatPageDesktop.tsx` and `ChatPageMobile.tsx`
- `/app/(tasks)/code/CodePageDesktop.tsx` and `CodePageMobile.tsx`
- `/features/tasks/components/input/ChatInputControls.tsx` and `MobileChatInputControls.tsx`
