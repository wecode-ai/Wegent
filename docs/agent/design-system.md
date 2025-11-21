# Wegent Design System

This document defines the unified design system for the Wegent frontend project, including colors, spacing, typography, components, and more.

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [Technology Stack](#technology-stack)
3. [Color System](#color-system)
4. [Spacing System](#spacing-system)
5. [Border Radius Specifications](#border-radius-specifications)
6. [Typography](#typography)
7. [Component Library](#component-library)
8. [Layout Patterns](#layout-patterns)

---

## Design Principles

### Core Philosophy
- **Consistency**: Maintain unified visual style and interaction patterns across all pages
- **Simplicity**: Reduce visual noise and highlight core content
- **Responsiveness**: Adapt to desktop, tablet, and mobile devices
- **Accessibility**: Support dark mode and accessible navigation

### Design Reference
Use the `/code` page (Code Task page) ChatArea component as the design standard to unify the entire site's style.

---

## Technology Stack

### UI Framework
- **shadcn/ui**: Component library based on Radix UI
- **Radix UI**: Accessible headless UI components
- **Tailwind CSS**: Utility-first CSS framework
- **lucide-react**: Icon library

### Form Management
- **react-hook-form**: High-performance form management
- **zod**: TypeScript-first schema validation

### Other Dependencies
- **vaul**: Drawer component foundation library
- **class-variance-authority**: Component variant management
- **clsx** & **tailwind-merge**: Class name merging utilities

---

## Color System

### Design Philosophy

Adopts **Calm UI** design:
- **Low saturation + Low contrast**: Reduce visual fatigue
- **No shadows or minimal shadows**: Keep interface clean
- **Generous whitespace**: Improve readability
- **Minimal component color differences**: Background layer differences < 10%
- **Restrained use of highlights**: Use mint blue theme color only for action buttons

### CSS Variable Definitions

All colors are defined via CSS variables, supporting automatic light/dark theme switching.

#### Background Colors

```css
--color-bg-base: Primary background color
  • Light: rgb(255 255 255) - Pure white
  • Dark: rgb(14 15 15) - Nearly black with slight gray (#0E0F0F)

--color-bg-surface: Card/surface background color
  • Light: rgb(247 247 248) - Light gray (#F7F7F8)
  • Dark: rgb(26 28 28) - Slightly lighter than primary background (#1A1C1C)

--color-bg-muted: Muted background color
  • Light: rgb(242 242 242) - Neutral gray (#F2F2F2)
  • Dark: rgb(33 36 36) - Slightly bright low contrast (#212424)

--color-bg-hover: Hover background color
  • Light: rgb(224 224 224) - Hover gray (#E0E0E0)
  • Dark: rgb(42 45 45) - Light contrast (#2A2D2D)
```

#### Border Colors

```css
--color-border: Default border color
  • Light: rgb(224 224 224) - Light contrast (#E0E0E0)
  • Dark: rgb(42 45 45) - Light contrast (#2A2D2D)

--color-border-strong: Emphasized border color
  • Light: rgb(192 192 192) - Medium contrast (#C0C0C0)
  • Dark: rgb(52 53 53) - Slightly stronger contrast (#343535)
```

#### Text Colors

```css
--color-text-primary: Primary text color
  • Light: rgb(26 26 26) - Deep gray, not harsh (#1A1A1A)
  • Dark: rgb(236 236 236) - Bright white but not harsh (#ECECEC)

--color-text-secondary: Secondary text color
  • Light: rgb(102 102 102) - Medium gray (#666666)
  • Dark: rgb(212 212 212) - Low brightness gray-white (#D4D4D4)

--color-text-muted: Muted text color
  • Light: rgb(160 160 160) - For hints, timestamps (#A0A0A0)
  • Dark: rgb(160 160 160) - For hints, timestamps (#A0A0A0)

--color-text-inverted: Inverted text color
  • Light: rgb(255 255 255) - White
  • Dark: rgb(14 15 15) - Dark
```

#### Theme Colors

```css
--color-primary: Theme color (Mint blue)
  • rgb(20 184 166) - Mint blue (#14B8A6)

--color-primary-contrast: Theme color contrast
  • rgb(255 255 255) - White

--color-success: Success color
  • rgb(20 184 166) - Consistent with theme color (#14B8A6)

--color-error: Error color
  • Light: rgb(239 68 68) - Red
  • Dark: rgb(248 81 73) - Red

--color-link: Link color
  • rgb(85 185 247) - Similar to GPT UI link blue (#55B9F7)

--color-code-bg: Code block background color
  • Light: rgb(246 248 250) - Light gray (#F6F8FA)
  • Dark: rgb(13 17 23) - GitHub-style dark (#0D1117)
```

### Tailwind Usage

```jsx
// Background colors
className="bg-base"          // Primary background
className="bg-surface"       // Card background
className="bg-muted"         // Muted background
className="bg-hover"         // Hover background

// Text colors
className="text-text-primary"    // Primary text
className="text-text-secondary"  // Secondary text
className="text-text-muted"      // Muted text

// Border colors
className="border-border"         // Default border
className="border-border-strong"  // Emphasized border

// Theme colors
className="bg-primary text-primary-contrast"  // Theme button
className="text-primary"                       // Theme color text
className="bg-success"                         // Success state
className="bg-error"                           // Error state
className="text-link"                          // Link text
className="bg-code-bg"                         // Code block background
```

### ChatGPT-Style Color Reference

#### Dark Theme (Most Common)

| Role | Color | Description |
|------|-------|-------------|
| Primary background | `#0E0F0F` | Nearly black with slight gray |
| Sidebar background | `#1A1C1C` | Slightly lighter than primary background |
| Message box (AI) | `#212424` | Slightly bright, low contrast |
| Message box (User) | `#171919` | Darker, distinguishes user |
| Title text | `#ECECEC` | Bright white but not harsh |
| Body text | `#D4D4D4` | Low brightness gray-white |
| Secondary text | `#A0A0A0` | For hints, timestamps |
| Border color | `#2A2D2D` | Light contrast |
| Button primary | `#14B8A6` | Mint blue theme color |
| Button hover | `#0D9488` | Slightly darker |
| Link | `#55B9F7` | Similar to GPT UI link blue |
| Code block background | `#0D1117` | GitHub-style dark |

#### Light Theme

| Role | Color | Description |
|------|-------|-------------|
| Primary background | `#FFFFFF` | Pure white |
| Sidebar background | `#F7F7F8` | Light gray |
| Message box (AI) | `#F2F2F2` | Light gray |
| Message box (User) | `#FFFFFF` | White |
| Body text | `#1A1A1A` | Deep gray |
| Secondary text | `#666666` | Medium gray |
| Border color | `#E0E0E0` | Light contrast |
| Button primary | `#14B8A6` | Consistent with dark theme |
| Code block background | `#F6F8FA` | Light gray |

---

## Spacing System

Based on Tailwind's standard spacing (1 unit = 0.25rem = 4px).

### Standard Spacing

| Class | Size | Usage |
|-------|------|-------|
| `p-2` | 8px | Small element padding |
| `p-3` | 12px | Medium element padding |
| `p-4` | 16px | Default card padding |
| `p-6` | 24px | Large card padding |
| `gap-2` | 8px | Small gap |
| `gap-3` | 12px | Default gap |
| `gap-4` | 16px | Larger gap |
| `space-y-3` | 12px | Vertical stack spacing |

### Usage Examples

```jsx
// Card padding
<Card className="p-4">...</Card>

// Element spacing
<div className="flex gap-3">...</div>

// Vertical stacking
<div className="space-y-3">
  <Card>...</Card>
  <Card>...</Card>
</div>

// Page margins (responsive)
<div className="px-4 sm:px-6">...</div>
```

---

## Border Radius Specifications

### Tiered Usage

Use different levels of border radius based on element type:

| Level | Tailwind Class | Size | Usage |
|-------|---------------|------|-------|
| **Large cards** | `rounded-2xl` | 16px | Containers: ChatArea input card, Modal |
| **Medium cards** | `rounded-lg` | 12px | List items: BotList/TeamList cards, Dropdown |
| **Small elements** | `rounded-md` | 6px | Button, Tag, Input |
| **Tiny elements** | `rounded-sm` | 4px | Badge (use rounded-full for complete circle) |
| **Circle** | `rounded-full` | ∞ | Badge, Avatar, status indicator dots |

### Usage Examples

```jsx
// Large card - Input area
<div className="rounded-2xl border border-border bg-base shadow-lg">
  ...
</div>

// Medium card - List item
<Card className="rounded-lg">
  ...
</Card>

// Small element - Button
<Button className="rounded-md">
  ...
</Button>

// Circle - Badge
<Badge className="rounded-full">
  ...
</Badge>
```

---

## Typography

### Font Hierarchy

| Level | Tailwind Class | Size | Weight | Usage |
|-------|---------------|------|--------|-------|
| **H1** | `text-xl font-semibold` | 20px | 600 | Page main title |
| **H2** | `text-lg font-semibold` | 18px | 600 | Section title |
| **H3** | `text-base font-medium` | 16px | 500 | Card title, list item title |
| **Body** | `text-sm` | 14px | 400 | Body content, button text |
| **Helper** | `text-xs text-text-muted` | 12px | 400 | Helper info, status text |

### Usage Examples

```jsx
// Page title
<h2 className="text-xl font-semibold text-text-primary mb-1">
  Bots Management
</h2>

// Section description
<p className="text-sm text-text-muted mb-1">
  Manage your AI bots and configurations
</p>

// Card title
<h3 className="text-base font-medium text-text-primary">
  Bot Name
</h3>

// Helper information
<span className="text-xs text-text-muted">
  Active • 2 days ago
</span>
```

---

## Component Library

This project uses the shadcn/ui component system. All components are located in the `frontend/src/components/ui/` directory.

### Basic Components

#### Button

**File Location**: `frontend/src/components/ui/button.tsx`

**Variants**:

| Variant | Style | Usage |
|---------|-------|-------|
| `default` | Theme color background | Primary actions |
| `secondary` | Border + transparent background | Secondary actions |
| `ghost` | No border + transparent background | Icon buttons, text buttons |
| `outline` | Border + transparent background | Outline buttons |
| `link` | Underlined text | Link style |

**Sizes**:
- `sm`: Height 36px
- `default`: Height 40px
- `lg`: Height 44px
- `icon`: 40×40px square

**Usage Examples**:

```jsx
import { Button } from '@/components/ui/button';

// Primary button
<Button variant="default">Save</Button>

// Secondary button
<Button variant="secondary">Cancel</Button>

// Icon button
<Button variant="ghost" size="icon">
  <PencilIcon className="w-4 h-4" />
</Button>

// Dangerous action
<Button className="bg-error hover:bg-error/90">
  Delete
</Button>
```

#### Card

**File Location**: `frontend/src/components/ui/card.tsx`

**Variants**:
- `default`: Default border card
- `elevated`: Card with shadow
- `ghost`: Borderless card

**Padding**:
- `none`: No padding
- `sm`: p-3 (12px)
- `default`: p-4 (16px)
- `lg`: p-6 (24px)

**Usage Examples**:

```jsx
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

// Basic card
<Card className="p-4 hover:shadow-md transition-shadow">
  <div className="flex items-center justify-between">
    <h3>Card Title</h3>
    <Button variant="ghost" size="icon">
      <PencilIcon className="w-4 h-4" />
    </Button>
  </div>
</Card>

// Structured card
<Card>
  <CardHeader>
    <CardTitle>Settings</CardTitle>
  </CardHeader>
  <CardContent>
    ...
  </CardContent>
</Card>
```

#### Input

**File Location**: `frontend/src/components/ui/input.tsx`

Basic text input component supporting various HTML input types.

```jsx
import { Input } from '@/components/ui/input';

<Input type="text" placeholder="Enter text..." />
<Input type="email" placeholder="Email address" />
```

### Additional Components

For brevity, here are the key components available in the design system:

- **Tag** (`tag.tsx`): Status labels and filters
- **Badge** (`badge.tsx`): Small status indicators, notification counts
- **Alert** (`alert.tsx`): Page-level alerts
- **Spinner** (`spinner.tsx`): Loading indicators
- **Switch** (`switch.tsx`): Toggle switches
- **Checkbox** (`checkbox.tsx`): Checkboxes
- **Radio Group** (`radio-group.tsx`): Radio button groups
- **Select** (`select.tsx`): Dropdown selectors
- **Dialog** (`dialog.tsx`): Modal dialogs
- **Drawer** (`drawer.tsx`): Side panels
- **Toast** (`toast.tsx`, `toaster.tsx`): Temporary notifications
- **Tooltip** (`tooltip.tsx`): Hover tooltips
- **Dropdown Menu** (`dropdown-menu.tsx`): Context menus
- **Form** (`form.tsx`): Form components with react-hook-form
- **Label** (`label.tsx`): Form labels
- **Transfer** (`transfer.tsx`): Transfer lists
- **Scroll Area** (`scroll-area.tsx`): Custom scrollable areas

Refer to the component files in `frontend/src/components/ui/` for detailed usage.

---

## Layout Patterns

### Card List Layout

Used for BotList, TeamList components on settings pages.

**Design Points**:
1. **Card spacing**: Use `space-y-3` (12px vertical spacing)
2. **Card padding**: Use `p-4` (16px)
3. **Card radius**: Use `rounded-lg` (12px)
4. **Hover effect**: `hover:shadow-md transition-shadow`
5. **Remove dividers**: No border-t separation, card spacing is sufficient

**Code Example**:

```jsx
{/* List container */}
<div className="flex-1 overflow-y-auto custom-scrollbar space-y-3 p-1">
  {items.map(item => (
    <Card key={item.id} className="p-4 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between min-w-0">
        {/* Left content */}
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

        {/* Right action buttons */}
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

### Task Page Layout (Three Columns)

**Reference**: `/app/(tasks)/code/page.tsx`

- **Left column**: Task sidebar (TaskSidebar)
- **Middle column**: Chat/code area (ChatArea / Workbench)
- **Right column**: (Optional) Details panel

**Features**:
- Responsive: Single column on mobile, three columns on desktop
- Resizable: Uses ResizableSidebar
- Fixed layout: Prevents content overflow

### Settings Page Layout

**Structure**: Sidebar navigation + Content area

```
┌─────────────┬──────────────────────────┐
│             │                          │
│  Settings   │   Content Area           │
│  Nav        │   (BotList/TeamList)     │
│             │                          │
└─────────────┴──────────────────────────┘
```

### Login Page Layout

**Feature**: Centered card layout

```jsx
<div className="flex items-center justify-center min-h-screen">
  <Card className="w-full max-w-md p-8 rounded-2xl">
    <h1 className="text-2xl font-bold mb-6">Login</h1>
    {/* Form content */}
  </Card>
</div>
```

---

## Responsive Breakpoints

Follows Tailwind default breakpoints:

| Breakpoint | Min Width | Usage |
|------------|-----------|-------|
| `sm` | 640px | Small screens |
| `md` | 768px | Tablets |
| `lg` | 1024px | Desktops |
| `xl` | 1280px | Large screens |

### Usage Examples

```jsx
<div className="px-4 sm:px-6">  {/* Responsive padding */}
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">  {/* Responsive grid */}
<p className="hidden sm:block">  {/* Hide on small screens */}
```

---

## Dark Mode

### Implementation

Switch themes automatically via `data-theme="dark"` attribute on CSS variables.

### Notes

1. Use CSS variables for colors, auto-adapt to themes
2. Avoid hard-coded color values
3. Test readability in both themes

---

## Best Practices

### 1. Use Semantic Class Names

```jsx
// ✅ Good
<div className="flex items-center gap-3">

// ❌ Bad
<div className="flex items-center space-x-3 ml-2 mr-2">
```

### 2. Maintain Consistent Spacing

```jsx
// ✅ Good - Unified use of gap
<div className="flex gap-3">
  <Button>Action 1</Button>
  <Button>Action 2</Button>
</div>

// ❌ Bad - Mixed spacing methods
<div className="flex">
  <Button className="mr-2">Action 1</Button>
  <Button className="ml-1">Action 2</Button>
</div>
```

### 3. Mobile-First Responsive

```jsx
// ✅ Good - Mobile-first
<div className="px-4 sm:px-6 lg:px-8">

// ❌ Bad - Desktop-first
<div className="px-8 sm:px-6 xs:px-4">
```

### 4. Use Composition Over Inheritance

```jsx
// ✅ Good - Compose Card and Button
<Card className="p-4">
  <Button variant="ghost">Edit</Button>
</Card>

// ❌ Bad - Create special EditableCard
<EditableCard onEdit={...} />
```

---

## Development Tools

### VS Code Plugins Recommended

- **Tailwind CSS IntelliSense**: Autocomplete Tailwind class names
- **Headwind**: Auto-sort Tailwind class names
- **PostCSS Language Support**: CSS variable support

### Debugging Tips

```jsx
// Use Tailwind debug classes
<div className="debug-screens">  {/* Display current breakpoint */}
```

---

## Related Resources

### Official Documentation
- [Tailwind CSS](https://tailwindcss.com/docs) - CSS framework
- [Radix UI](https://www.radix-ui.com/) - Headless UI components
- [shadcn/ui](https://ui.shadcn.com/) - Component library reference
- [React Hook Form](https://react-hook-form.com/) - Form management
- [Zod](https://zod.dev/) - Schema validation
- [lucide-react](https://lucide.dev/) - Icon library

### Project Reference
- [ChatArea Component](../../frontend/src/features/tasks/components/ChatArea.tsx) - Design standard reference
- [Component Directory](../../frontend/src/components/ui/) - All UI components

---

**Maintainer**: Wegent Team
**Last Updated**: 2025-01-22
**Version**: 2.2.0 - Mint blue theme color scheme
