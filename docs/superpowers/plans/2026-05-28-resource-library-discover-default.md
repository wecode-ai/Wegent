# Resource Library Discover Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/resource-library` default to the public Discover view while preserving the existing Mine resource management entry points.

**Architecture:** Reuse the existing resource-library components and keep orchestration in `ResourceLibraryPage`. `DiscoverResources` remains responsible for loading, search, details, and install behavior, with one small toolbar slot so the page can place type filters beside search without duplicating list logic.

**Tech Stack:** Next.js 15, React 19, TypeScript, Jest, React Testing Library, existing Wegent UI components and i18n hooks.

---

## File Structure

- Modify `frontend/src/features/resource-library/ResourceLibraryPage.tsx`
  - Owns top-level `discover | mine` tab state.
  - Reads the initial `tab` query parameter.
  - Updates `window.history` when users switch tabs.
  - Renders `ResourceLibraryTabs`, `ResourceTypeFilter`, `DiscoverResources`, and `MyResources`.
- Modify `frontend/src/features/resource-library/components/DiscoverResources.tsx`
  - Adds an optional `toolbarStart` slot.
  - Keeps search, listing fetch, detail drawer, install, loading, empty, and error behavior in one component.
- Modify `frontend/src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx`
  - Replaces the old "only MyResources" expectation with default Discover behavior.
  - Covers tab switching, `?tab=mine`, and type filtering.
- Modify `frontend/src/__tests__/features/resource-library/DiscoverResources.test.tsx`
  - Covers the new toolbar slot without weakening existing listing/detail/install tests.
- Modify `frontend/src/__tests__/features/resource-library/ResourceLibraryRoute.test.tsx`
  - Updates the route-level smoke test to expect Discover as the default content.

## Scope Check

This plan implements one frontend feature slice only. It does not touch backend endpoints, resource-library database models, publishing, install semantics, or non-Agent/Skill public discovery.

### Task 1: Default Discover Shell

**Files:**
- Modify: `frontend/src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx`
- Modify: `frontend/src/features/resource-library/ResourceLibraryPage.tsx`

- [ ] **Step 1: Write failing page tests**

Replace `frontend/src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx` with:

```tsx
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { resourceLibraryApi } from '@/apis/resourceLibrary'
import ResourceLibraryPage from '@/features/resource-library/ResourceLibraryPage'

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listListings: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listMyInstalls: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listMyPublished: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    getListing: jest.fn(),
    installListing: jest.fn(),
    createListing: jest.fn(),
  },
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}))

jest.mock('@/features/resource-library/components/MyResources', () => ({
  MyResources: () => <div data-testid="my-resource-management">资源管理</div>,
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        title: '资源库',
        'tabs.discover': '发现',
        'tabs.mine': '我的',
        'tabs.installed': '已安装',
        'tabs.published': '我发布的',
        'filters.all': '全部',
        'filters.agent': '智能体',
        'filters.skill': '技能',
        'search.placeholder': '搜索资源',
        'actions.search': '搜索',
        'actions.publish': '发布资源',
        'actions.retry': '重试',
        'states.loading': '正在加载资源',
        'states.empty': '暂无资源',
        'states.error': '加载失败',
      }

      return translations[key] ?? key
    },
  }),
}))

const mockResourceLibraryApi = resourceLibraryApi as jest.Mocked<typeof resourceLibraryApi>

function setResourceLibraryUrl(search = '') {
  window.history.pushState({}, '', `/resource-library${search}`)
}

describe('ResourceLibraryPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setResourceLibraryUrl()
    mockResourceLibraryApi.listListings.mockResolvedValue({ items: [], total: 0 })
  })

  it('renders discover as the default resource library view', async () => {
    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('resource-library-content')).toBeInTheDocument()
    expect(screen.getByTestId('resource-library-discover-tab')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('resource-library-mine-tab')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.getByTestId('resource-type-all-filter')).toBeInTheDocument()
    expect(screen.getByTestId('resource-type-agent-filter')).toBeInTheDocument()
    expect(screen.getByTestId('resource-type-skill-filter')).toBeInTheDocument()
    expect(screen.getByTestId('discover-resources')).toBeInTheDocument()
    expect(screen.queryByTestId('my-resource-management')).not.toBeInTheDocument()

    await waitFor(() => {
      expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
        resourceType: 'all',
        page: 1,
        limit: 50,
      })
    })
  })

  it('switches to my resources and updates the tab query parameter', async () => {
    render(<ResourceLibraryPage />)

    fireEvent.click(screen.getByTestId('resource-library-mine-tab'))

    expect(screen.getByTestId('resource-library-mine-tab')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('my-resource-management')).toBeInTheDocument()
    expect(screen.queryByTestId('discover-resources')).not.toBeInTheDocument()
    expect(window.location.search).toContain('tab=mine')
  })

  it('opens my resources when the initial tab query parameter is mine', () => {
    setResourceLibraryUrl('?tab=mine&type=agent&scope=personal')

    render(<ResourceLibraryPage />)

    expect(screen.getByTestId('resource-library-mine-tab')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('my-resource-management')).toBeInTheDocument()
    expect(screen.queryByTestId('discover-resources')).not.toBeInTheDocument()
    expect(mockResourceLibraryApi.listListings).not.toHaveBeenCalled()
  })

  it('reloads discover listings when the resource type filter changes', async () => {
    render(<ResourceLibraryPage />)

    await waitFor(() => {
      expect(mockResourceLibraryApi.listListings).toHaveBeenCalledWith({
        resourceType: 'all',
        page: 1,
        limit: 50,
      })
    })

    fireEvent.click(screen.getByTestId('resource-type-skill-filter'))

    await waitFor(() => {
      expect(mockResourceLibraryApi.listListings).toHaveBeenLastCalledWith({
        resourceType: 'skill',
        page: 1,
        limit: 50,
      })
    })
  })
})
```

- [ ] **Step 2: Run the page tests and verify they fail**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx
```

Expected: FAIL because `resource-library-discover-tab`, `resource-type-all-filter`, and `discover-resources` are not rendered by `ResourceLibraryPage`.

- [ ] **Step 3: Implement the default Discover shell**

Replace `frontend/src/features/resource-library/ResourceLibraryPage.tsx` with:

```tsx
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useState } from 'react'

import { DiscoverResources } from './components/DiscoverResources'
import { MyResources } from './components/MyResources'
import { ResourceLibraryTabs, type ResourceLibraryTab } from './components/ResourceLibraryTabs'
import { ResourceTypeFilter } from './components/ResourceTypeFilter'
import type { ResourceLibraryTypeFilter } from './types'

function getInitialTab(): ResourceLibraryTab {
  if (typeof window === 'undefined') {
    return 'discover'
  }

  return new URLSearchParams(window.location.search).get('tab') === 'mine' ? 'mine' : 'discover'
}

function updateTabQueryParam(tab: ResourceLibraryTab) {
  if (typeof window === 'undefined') {
    return
  }

  const url = new URL(window.location.href)
  url.searchParams.set('tab', tab)
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

export function ResourceLibraryPage() {
  const [activeTab, setActiveTab] = useState<ResourceLibraryTab>(getInitialTab)
  const [resourceType, setResourceType] = useState<ResourceLibraryTypeFilter>('all')

  const handleTabChange = useCallback((nextTab: ResourceLibraryTab) => {
    setActiveTab(nextTab)
    updateTabQueryParam(nextTab)
  }, [])

  return (
    <main className="h-full overflow-y-auto bg-base text-text-primary">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4">
          <ResourceLibraryTabs value={activeTab} onValueChange={handleTabChange} />

          <div data-testid="resource-library-content">
            {activeTab === 'discover' ? (
              <div className="flex flex-col gap-4">
                <ResourceTypeFilter value={resourceType} onValueChange={setResourceType} />
                <DiscoverResources resourceType={resourceType} />
              </div>
            ) : (
              <MyResources />
            )}
          </div>
        </section>
      </div>
    </main>
  )
}

export default ResourceLibraryPage
```

- [ ] **Step 4: Run the page tests and verify they pass**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add frontend/src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx frontend/src/features/resource-library/ResourceLibraryPage.tsx
git commit -m "feat(frontend): default resource library to discover"
```

### Task 2: Discover Toolbar Composition

**Files:**
- Modify: `frontend/src/__tests__/features/resource-library/DiscoverResources.test.tsx`
- Modify: `frontend/src/features/resource-library/components/DiscoverResources.tsx`
- Modify: `frontend/src/features/resource-library/ResourceLibraryPage.tsx`

- [ ] **Step 1: Add a failing toolbar slot test**

In `frontend/src/__tests__/features/resource-library/DiscoverResources.test.tsx`, add this test inside `describe('DiscoverResources', () => { ... })` after the default load test:

```tsx
  it('renders custom toolbar controls beside discover search', async () => {
    render(
      <DiscoverResources
        resourceType="all"
        toolbarStart={<div data-testid="resource-filter-slot">资源类型筛选</div>}
      />
    )

    const toolbar = screen.getByTestId('discover-resources-toolbar')
    expect(within(toolbar).getByTestId('resource-filter-slot')).toBeInTheDocument()
    expect(within(toolbar).getByTestId('resource-library-search-input')).toBeInTheDocument()
    expect(await screen.findByText('Doc Summary')).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the DiscoverResources tests and verify they fail**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/DiscoverResources.test.tsx
```

Expected: FAIL because `DiscoverResourcesProps` does not accept `toolbarStart` and the toolbar has no `discover-resources-toolbar` test id.

- [ ] **Step 3: Implement the toolbar slot**

In `frontend/src/features/resource-library/components/DiscoverResources.tsx`, change the imports to:

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
```

Change the props interface to:

```tsx
interface DiscoverResourcesProps {
  resourceType: ResourceLibraryTypeFilter
  toolbarStart?: ReactNode
}
```

Change the component signature to:

```tsx
export function DiscoverResources({ resourceType, toolbarStart }: DiscoverResourcesProps) {
```

Replace the search form JSX with:

```tsx
      <form
        className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between"
        onSubmit={handleSearch}
        data-testid="discover-resources-toolbar"
      >
        {toolbarStart && <div className="flex flex-wrap items-center gap-2">{toolbarStart}</div>}

        <div className="flex flex-col gap-2 sm:flex-row lg:ml-auto lg:min-w-[360px] lg:max-w-xl lg:flex-1">
          <Input
            value={searchInput}
            onChange={event => setSearchInput(event.target.value)}
            placeholder={t('search.placeholder')}
            className="h-11 flex-1 sm:h-10"
            data-testid="resource-library-search-input"
          />
          <Button
            type="submit"
            variant="outline"
            className="h-11 min-w-[44px] px-4 sm:w-auto lg:h-10"
            aria-label={t('actions.search')}
            data-testid="resource-library-search-button"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            {t('actions.search')}
          </Button>
        </div>
      </form>
```

- [ ] **Step 4: Move ResourceTypeFilter into the Discover toolbar**

In `frontend/src/features/resource-library/ResourceLibraryPage.tsx`, replace:

```tsx
              <div className="flex flex-col gap-4">
                <ResourceTypeFilter value={resourceType} onValueChange={setResourceType} />
                <DiscoverResources resourceType={resourceType} />
              </div>
```

with:

```tsx
              <DiscoverResources
                resourceType={resourceType}
                toolbarStart={
                  <ResourceTypeFilter value={resourceType} onValueChange={setResourceType} />
                }
              />
```

- [ ] **Step 5: Run focused tests and verify they pass**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/DiscoverResources.test.tsx src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add frontend/src/__tests__/features/resource-library/DiscoverResources.test.tsx frontend/src/features/resource-library/components/DiscoverResources.tsx frontend/src/features/resource-library/ResourceLibraryPage.tsx
git commit -m "feat(frontend): align discover filters with search"
```

### Task 3: Route-Level Regression

**Files:**
- Modify: `frontend/src/__tests__/features/resource-library/ResourceLibraryRoute.test.tsx`

- [ ] **Step 1: Update the route smoke test**

In `frontend/src/__tests__/features/resource-library/ResourceLibraryRoute.test.tsx`, replace the test body with:

```tsx
  it('renders with the task sidebar active and discover selected by default', async () => {
    render(<Page />)

    expect(screen.getByTestId('resource-library-task-sidebar')).toHaveAttribute(
      'data-page-type',
      'resource-library'
    )
    expect(screen.getByTestId('resource-library-top-navigation')).toHaveTextContent('资源库')
    expect(screen.queryByRole('heading', { name: '资源库' })).not.toBeInTheDocument()
    expect(screen.getByTestId('resource-library-discover-tab')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('resource-library-mine-tab')).toBeInTheDocument()
    expect(screen.getByTestId('discover-resources')).toBeInTheDocument()
    expect(screen.queryByTestId('my-resource-management')).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the route test and verify it passes**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/ResourceLibraryRoute.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run the resource-library frontend test set**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx src/__tests__/features/resource-library/ResourceLibraryRoute.test.tsx src/__tests__/features/resource-library/DiscoverResources.test.tsx src/__tests__/features/resource-library/MyResources.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Commit Task 3**

Run:

```bash
git add frontend/src/__tests__/features/resource-library/ResourceLibraryRoute.test.tsx
git commit -m "test(frontend): cover resource library discover route"
```

### Task 4: Final Verification

**Files:**
- Verify: `frontend/src/features/resource-library/ResourceLibraryPage.tsx`
- Verify: `frontend/src/features/resource-library/components/DiscoverResources.tsx`
- Verify: `frontend/src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx`
- Verify: `frontend/src/__tests__/features/resource-library/DiscoverResources.test.tsx`
- Verify: `frontend/src/__tests__/features/resource-library/ResourceLibraryRoute.test.tsx`

- [ ] **Step 1: Run all focused resource-library tests**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library
```

Expected: PASS.

- [ ] **Step 2: Run frontend lint**

Run:

```bash
cd frontend && npm run lint
```

Expected: PASS.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --stat HEAD~3..HEAD
git status --short
```

Expected: the diff contains only resource-library page/component/tests, and `git status --short` is empty after the task commits.

## Self-Review

- Spec coverage: The plan covers default Discover, public Agent/Skill filtering, search/detail/install reuse, Mine preservation, `?tab=mine` compatibility, and focused tests.
- Placeholder scan: The plan uses concrete file paths, concrete code, concrete commands, and concrete expected outcomes.
- Type consistency: `ResourceLibraryTab`, `ResourceLibraryTypeFilter`, `toolbarStart`, and existing `resourceType` names are consistent across tests and implementation.
