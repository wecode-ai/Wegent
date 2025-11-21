# Design System

Quick reference for Wegent's design system.

---

## Design Principles

- **Calm UI**: Low saturation, low contrast, minimal shadows
- **Consistency**: Unified style across all pages
- **Reference**: `/code` page ChatArea component as design standard

---

## Color System

### CSS Variables

**Background:**
```css
--color-bg-base      /* Primary: white / #0E0F0F */
--color-bg-surface   /* Card: #F7F7F8 / #1A1C1C */
--color-bg-muted     /* Muted: #F2F2F2 / #212424 */
--color-bg-hover     /* Hover: #E0E0E0 / #2A2D2D */
```

**Text:**
```css
--color-text-primary    /* Primary: #1A1A1A / #ECECEC */
--color-text-secondary  /* Secondary: #666666 / #D4D4D4 */
--color-text-muted      /* Muted: #A0A0A0 / #A0A0A0 */
--color-text-inverted   /* Inverted: white / #0E0F0F */
```

**Border:**
```css
--color-border         /* Default: #E0E0E0 / #2A2D2D */
--color-border-strong  /* Strong: #C0C0C0 / #343535 */
```

**Theme:**
```css
--color-primary           /* #14B8A6 Mint blue */
--color-primary-contrast  /* #FFFFFF White */
--color-success           /* #14B8A6 Same as primary */
--color-error             /* #EF4444 / #F85149 Red */
--color-link              /* #55B9F7 Link blue */
--color-code-bg           /* #F6F8FA / #0D1117 Code bg */
```

### Tailwind Usage

```jsx
className="bg-base bg-surface bg-muted bg-hover"
className="text-text-primary text-text-secondary text-text-muted"
className="border-border border-border-strong"
className="bg-primary text-primary-contrast"
className="text-link bg-code-bg"
```

---

## Spacing

| Class | Size | Usage |
|-------|------|-------|
| p-2 | 8px | Small padding |
| p-3 | 12px | Medium padding |
| p-4 | 16px | Default card |
| p-6 | 24px | Large card |
| gap-2 | 8px | Small gap |
| gap-3 | 12px | Default gap |
| gap-4 | 16px | Large gap |
| space-y-3 | 12px | Vertical spacing |

---

## Border Radius

| Level | Class | Size | Usage |
|-------|-------|------|-------|
| Large | rounded-2xl | 16px | Input cards, modals |
| Medium | rounded-lg | 12px | List cards, dropdowns |
| Small | rounded-md | 6px | Buttons, inputs |
| Tiny | rounded-sm | 4px | Tags |
| Circle | rounded-full | ∞ | Badges, avatars |

---

## Typography

| Level | Class | Size | Weight | Usage |
|-------|-------|------|--------|-------|
| H1 | text-xl font-semibold | 20px | 600 | Page title |
| H2 | text-lg font-semibold | 18px | 600 | Section title |
| H3 | text-base font-medium | 16px | 500 | Card title |
| Body | text-sm | 14px | 400 | Body text |
| Helper | text-xs text-text-muted | 12px | 400 | Helper text |

---

## Components

### Button Variants

| Variant | Style | Usage |
|---------|-------|-------|
| default | Theme bg | Primary action |
| secondary | Border + transparent | Secondary action |
| ghost | No border | Icon/text buttons |
| outline | Border only | Outline buttons |
| link | Underlined | Links |

**Sizes:** sm (36px), default (40px), lg (44px), icon (40x40px)

### Card Variants

| Variant | Style | Usage |
|---------|-------|-------|
| default | Border | Standard card |
| elevated | Shadow | Elevated card |
| ghost | No border | Borderless |

**Padding:** none, sm (12px), default (16px), lg (24px)

### Key Components

Located in `/workspace/12738/Wegent/frontend/src/components/ui/`:
- Button, Card, Input, Textarea
- Badge, Tag, Alert, Spinner
- Switch, Checkbox, Radio Group, Select
- Dialog, Drawer, Toast, Tooltip, Dropdown Menu
- Form, Label, Scroll Area

---

## Layout Patterns

### Card List

```jsx
<div className="space-y-3 p-1">
  <Card className="p-4 hover:shadow-md transition-shadow">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Icon className="w-5 h-5 text-primary" />
        <div>
          <h3 className="text-base font-medium">{name}</h3>
          <div className="flex gap-1.5 mt-2">
            <Tag>{type}</Tag>
          </div>
        </div>
      </div>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon"><PencilIcon /></Button>
        <Button variant="ghost" size="icon"><TrashIcon /></Button>
      </div>
    </div>
  </Card>
</div>
```

**Key Points:**
- space-y-3 for card spacing (12px)
- p-4 for card padding (16px)
- rounded-lg for cards (12px)
- hover:shadow-md for interaction

---

## Responsive

| Breakpoint | Min Width | Usage |
|------------|-----------|-------|
| sm | 640px | Small screens |
| md | 768px | Tablets |
| lg | 1024px | Desktops |
| xl | 1280px | Large screens |

```jsx
<div className="px-4 sm:px-6">  /* Responsive padding */
<div className="grid grid-cols-1 sm:grid-cols-2">  /* Responsive grid */
```

---

## Dark Mode

Automatically switches via `data-theme="dark"` on CSS variables.

**Best Practices:**
- Always use CSS variables for colors
- Avoid hard-coded color values
- Test in both light/dark themes

---

## Related
- [Frontend Examples](./frontend-examples.md)
- [Tech Stack](./tech-stack.md)
