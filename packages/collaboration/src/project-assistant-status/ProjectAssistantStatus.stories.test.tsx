import { sdkSelectValue } from '../test/selectControl'
// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import registry from '../../design-system/project-assistant-status.json'
import { ProjectAssistantStatusPanel } from './ProjectAssistantStatusPanel'
import { projectAssistantStatusChinese, projectAssistantStatusEnglish as copy } from './copy'
import { projectAssistantStatusFixtures } from './fixtures'
import meta, * as stories from './ProjectAssistantStatus.stories'

type StoryName = Exclude<keyof typeof stories, 'default'>
type PreviewArgs = Parameters<typeof meta.render>[0]
const fixtures = projectAssistantStatusFixtures.scenarios
const projectScope = {
  projectStore: 'cloud',
  projectId: 'project-example',
} as const

describe('loading and recovery regressions', () => {
  it('distinguishes a manager read failure from initial loading', () => {
    const failed = renderToStaticMarkup(
      <ProjectAssistantStatusPanel projectScope={projectScope} audience="manager" error />
    )
    const loading = renderToStaticMarkup(
      <ProjectAssistantStatusPanel projectScope={projectScope} audience="manager" loading />
    )
    expect(failed).toContain(copy.error)
    expect(loading).toContain(copy.loading)
    expect(failed).not.toBe(loading)
  })

  it('offers a supplied retry action after a self read failure', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel projectScope={projectScope} error onRetry={() => undefined} />
    )
    expect(html).toContain('data-testid="project-assistant-retry"')
  })

  it('retains the verified snapshot and receipt while refreshing the same project', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel projectScope={projectScope} status={fixtures.hosting} loading />
    )
    expect(html).toContain(copy.assignmentStates.running)
    expect(html).toContain(copy.currentTags)
    expect(html).toContain('2026-11-16T08:00:00Z')
    expect(html).toContain(copy.refreshing)
    expect(html).toContain(copy.refreshingDetail)
  })

  it.each(['self', 'manager'] as const)(
    'labels retained %s details as old confirmed data after refresh failure',
    audience => {
      const html = renderToStaticMarkup(
        <ProjectAssistantStatusPanel
          projectScope={projectScope}
          statusScope={projectScope}
          audience={audience}
          status={
            audience === 'manager'
              ? { dispatchable: true, availability: 'online' }
              : fixtures.hosting
          }
          error
        />
      )
      expect(html).toContain(copy.error)
      expect(html).toContain(copy.staleDetail)
      expect(html).toContain(copy.availabilityValues.online)
      if (audience === 'self') expect(html).toContain(copy.assignmentStates.running)
    }
  )

  it.each(['self', 'manager'] as const)(
    'prioritizes an active %s retry over the previous error',
    audience => {
      const html = renderToStaticMarkup(
        <ProjectAssistantStatusPanel
          projectScope={projectScope}
          statusScope={projectScope}
          audience={audience}
          status={
            audience === 'manager'
              ? { dispatchable: true, availability: 'online' }
              : fixtures.hosting
          }
          loading
          error
          onRetry={() => undefined}
        />
      )
      expect(html).toContain(copy.refreshing)
      expect(html).not.toContain(copy.error)
      expect(html).not.toContain('project-assistant-retry')
    }
  )

  it.each(['self', 'manager'] as const)(
    'keeps initial %s loading pending without a matching snapshot',
    audience => {
      const html = renderToStaticMarkup(
        <ProjectAssistantStatusPanel
          projectScope={projectScope}
          statusScope={projectScope}
          audience={audience}
          status={null}
          loading
          error
          onRetry={() => undefined}
        />
      )
      expect(html).toContain(copy.loading)
      expect(html).not.toContain(copy.availabilityValues.online)
      expect(html).not.toContain(copy.assignmentStates.running)
      expect(html).not.toContain('project-assistant-retry')
      expect(html).not.toContain(copy.error)
    }
  )

  it.each(['self', 'manager'] as const)(
    'omits a dead retry control for %s failures without a callback',
    audience => {
      const html = renderToStaticMarkup(
        <ProjectAssistantStatusPanel projectScope={projectScope} audience={audience} error />
      )
      expect(html).toContain(copy.error)
      expect(html).not.toContain('<button')
    }
  )

  it.each([
    { projectStore: 'local' as const, projectId: projectScope.projectId },
    { projectStore: 'cloud' as const, projectId: 'another-project' },
  ])(
    'hides old self facts, history and destinations for a different $projectStore/$projectId context',
    selected => {
      const html = renderToStaticMarkup(
        <ProjectAssistantStatusPanel
          projectScope={selected}
          status={fixtures.hosting}
          loading
          onOpenSettings={() => undefined}
          onOpenReceipt={() => undefined}
        />
      )
      expect(html).toContain(copy.loading)
      expect(html).not.toContain(copy.currentTags)
      expect(html).not.toContain(copy.assignmentStates.running)
      expect(html).not.toContain('2026-11-16T08:00:00Z')
      expect(html).not.toContain('<button')
    }
  )

  it.each([undefined, { projectStore: 'local' as const, projectId: projectScope.projectId }])(
    'requires a matching response scope for a minimal manager snapshot (%s)',
    statusScope => {
      const html = renderToStaticMarkup(
        <ProjectAssistantStatusPanel
          projectScope={projectScope}
          statusScope={statusScope}
          audience="manager"
          status={{ dispatchable: true, availability: 'online' }}
          loading
        />
      )
      expect(html).toContain(copy.loading)
      expect(html).toContain(`<dd>${copy.pending}</dd>`)
      expect(html).not.toContain(copy.availabilityValues.online)
      expect(html).not.toContain('<dd>Yes</dd>')
    }
  )

  it('does not retain a malformed snapshot during an initial read', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel
        projectScope={projectScope}
        status={{ ...fixtures.hosting, source: 'notification' }}
        loading
      />
    )
    expect(html).toContain(copy.loading)
    expect(html).not.toContain(copy.currentTags)
    expect(html).not.toContain(copy.assignmentStates.running)
  })
})

it('registers and statically renders all 30 handoff states in both shared themes', () => {
  expect(registry.productionIntegration).toBe(false)
  expect(registry.storybook).toHaveLength(30)
  for (const name of registry.storybook) {
    const story = stories[name as StoryName]
    expect(story).toBeDefined()
    for (const theme of ['light', 'dark'] as const) {
      const html = renderToStaticMarkup(meta.render({ ...story.args, theme } as PreviewArgs))
      expect(html).toContain(`data-theme="${theme}"`)
      expect(html).toContain(
        'locale' in story.args && story.args.locale === 'zh-CN'
          ? '合成设计参考'
          : 'Synthetic design reference'
      )
      expect(html).toContain('hosting-review-canvas')
      if (name === 'FeatureOff')
        expect(html).not.toContain('data-testid="project-assistant-status"')
      else if (name.startsWith('Manager')) {
        expect(html).toContain('project-assistant-status-manager')
        if (name !== 'ManagerLoading' && name !== 'ManagerError') {
          expect(html).toContain('<dd>Yes</dd>')
          expect(html).toContain('<dd>Device online</dd>')
        }
      } else expect(html).toContain('data-testid="project-assistant-status"')
    }
  }
})

describe('hosting design component contracts', () => {
  it('renders both entry layouts using the same snapshot', () => {
    const html = renderToStaticMarkup(meta.render(stories.Matrix.args as PreviewArgs))
    expect(html).toContain('hosting-preview-project')
    expect(html).toContain('hosting-preview-assistant')
    expect(html.match(/Waiting for the execution device/g)).toHaveLength(2)
  })

  it('keeps current hosting and historical assignment state separate', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel projectScope={projectScope} status={fixtures.pausedRunning} />
    )
    expect(html).toContain(copy.paused)
    expect(html).toContain(copy.assignmentStates.running)
    expect(html).toContain(copy.pausedPolicy)
  })

  it('does not claim completion without a delivery reference', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel
        projectScope={projectScope}
        status={fixtures.incompleteEvidence}
      />
    )
    expect(html).toContain(copy.incompleteEvidence)
    expect(html).not.toContain(`<strong>${copy.assignmentStates.completed}</strong>`)
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel projectScope={projectScope} status={fixtures.completed} />
      )
    ).toContain(`<strong>${copy.assignmentStates.completed}</strong>`)
  })

  it('renders an actual minimal manager DTO without owner identifiers or private fields', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel
        projectScope={projectScope}
        audience="manager"
        statusScope={projectScope}
        status={{
          dispatchable: true,
          availability: 'online',
          prompt: 'private-example',
        }}
      />
    )
    expect(html).toContain('<dd>Yes</dd>')
    expect(html).toContain('<dd>Device online</dd>')
    expect(html).not.toMatch(/private-example|ownerUserId|endpoint|humanAssignmentId|task-example/)
  })

  it('shows known manager availability independently of a missing dispatchability decision', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel
        projectScope={projectScope}
        statusScope={projectScope}
        audience="manager"
        status={{ availability: 'offline' }}
      />
    )
    expect(html).toContain(`<dd>${copy.pending}</dd>`)
    expect(html).toContain(`<dd>${copy.availabilityValues.offline}</dd>`)
    expect(html).not.toContain('<dd>Yes</dd>')
  })

  it('shows unknown and unavailable state without inventing success', () => {
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel projectScope={projectScope} status={null} />
      )
    ).toContain(copy.unknown)
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel projectScope={projectScope} status={null} loading />
      )
    ).toContain(copy.loading)
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel projectScope={projectScope} status={fixtures.hosting} error />
      )
    ).toContain(copy.error)
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel
          projectScope={projectScope}
          status={fixtures.hosting}
          featureEnabled={false}
        />
      )
    ).toBe('')
  })

  it('only renders recovery controls with supplied handlers and accepts caller copy', () => {
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel projectScope={projectScope} status={fixtures.waitingDevice} />
      )
    ).not.toContain('<button')
    const custom = { ...copy, settingsAction: 'Open custom settings' }
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel
        projectScope={projectScope}
        status={fixtures.waitingDevice}
        copy={custom}
        onOpenSettings={() => undefined}
      />
    )
    expect(html).toContain('Open custom settings')
    expect(html).toContain('project-assistant-recovery')
  })
})

describe('design preview destinations', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it.each(['self', 'manager'] as const)(
    'invokes the optional %s retry and suppresses it while the read is in progress',
    async audience => {
      const onRetry = vi.fn()
      await act(async () =>
        root.render(
          <ProjectAssistantStatusPanel
            projectScope={projectScope}
            audience={audience}
            error
            onRetry={onRetry}
          />
        )
      )
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="project-assistant-retry"]')!
          .click()
      )
      expect(onRetry).toHaveBeenCalledTimes(1)
      await act(async () =>
        root.render(
          <ProjectAssistantStatusPanel
            projectScope={projectScope}
            statusScope={projectScope}
            audience={audience}
            status={
              audience === 'manager'
                ? { dispatchable: true, availability: 'online' }
                : fixtures.hosting
            }
            loading
            error
            onRetry={onRetry}
          />
        )
      )
      expect(container.textContent).toContain(copy.refreshing)
      expect(container.textContent).toContain(copy.availabilityValues.online)
      expect(container.querySelector('[data-testid="project-assistant-retry"]')).toBeNull()
    }
  )

  it.each(['self', 'manager'] as const)(
    'immediately hides old %s facts when the same project ID switches from cloud to local',
    async audience => {
      const localScope = { ...projectScope, projectStore: 'local' as const }
      const render = (
        selected: typeof projectScope | typeof localScope,
        responseScope: typeof projectScope | typeof localScope,
        local: boolean,
        loading: boolean
      ) =>
        root.render(
          <ProjectAssistantStatusPanel
            projectScope={selected}
            statusScope={responseScope}
            audience={audience}
            status={
              audience === 'manager'
                ? {
                    dispatchable: !local,
                    availability: local ? 'offline' : 'online',
                  }
                : projectAssistantStatusFixtures.projects[local ? 1 : 0]
            }
            loading={loading}
            onOpenSettings={() => undefined}
            onOpenReceipt={() => undefined}
          />
        )
      await act(async () => render(projectScope, projectScope, false, false))
      expect(container.textContent).toContain(copy.availabilityValues.online)
      await act(async () => render(localScope, projectScope, false, true))
      expect(container.textContent).toContain(copy.loading)
      expect(container.textContent).not.toContain(copy.availabilityValues.online)
      expect(container.querySelector('button')).toBeNull()
      expect(container.querySelector('time')).toBeNull()
      await act(async () => render(localScope, localScope, true, false))
      expect(container.textContent).toContain(copy.availabilityValues.offline)
      // A late cloud response cannot be rendered as the selected local project's data.
      await act(async () => render(localScope, projectScope, false, false))
      expect(container.textContent).toContain(copy.unknown)
      expect(container.textContent).not.toContain(copy.availabilityValues.online)
      expect(container.querySelector('button')).toBeNull()
    }
  )

  it.each([
    ['error', 'en'],
    ['refreshError', 'en'],
    ['managerError', 'en'],
    ['managerRefreshError', 'en'],
    ['error', 'zh-CN'],
    ['refreshError', 'zh-CN'],
    ['managerError', 'zh-CN'],
    ['managerRefreshError', 'zh-CN'],
  ] as const)(
    'performs a visible synthetic retry for %s in %s without dispatching execution',
    async (scenario, locale) => {
      const labels = locale === 'zh-CN' ? projectAssistantStatusChinese : copy
      await act(async () => root.render(meta.render({ scenario, locale })))
      expect(container.textContent).toContain(labels.error)
      const retry = container.querySelector<HTMLButtonElement>(
        '[data-testid="project-assistant-retry"]'
      )!
      expect(retry.textContent).toBe(labels.retryAction)
      await act(async () => retry.click())
      expect(container.querySelector('[data-testid="project-assistant-retry"]')).toBeNull()
      expect(container.querySelector('[data-testid="project-assistant-sync-state"]')).toBeNull()
      expect(container.textContent).toContain(labels.availabilityValues.online)
      expect(container.querySelector('[data-testid="hosting-review-feedback"]')?.textContent).toBe(
        locale === 'zh-CN'
          ? '合成同步已完成，未启动任何执行。'
          : 'Synthetic sync completed. No execution was started.'
      )
    }
  )

  it.each([
    ['waitingDevice', 'settings'],
    ['tagMismatch', 'rules'],
    ['failed', 'receipt'],
  ] as const)(
    'opens a visible %s recovery destination and can return',
    async (scenario, destination) => {
      await act(async () => root.render(meta.render({ scenario })))
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[data-testid="project-assistant-recovery"]')!
          .click()
      )
      expect(container.querySelector(`[data-testid="hosting-demo-${destination}"]`)).not.toBeNull()
      if (destination === 'receipt') expect(container.textContent).toContain('assignment-example')
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[data-testid="hosting-demo-close"]')!.click()
      )
      expect(container.querySelector(`[data-testid="hosting-demo-${destination}"]`)).toBeNull()
    }
  )

  it('switches scenario, content width, theme and entry without touching execution state', async () => {
    await act(async () => root.render(meta.render({ scenario: 'waitingDevice' })))
    for (const [testId, value] of [
      ['hosting-review-scenario', 'pausedRunning'],
      ['hosting-review-width', '390'],
      ['hosting-review-theme', 'dark'],
      ['hosting-review-surface', 'assistant'],
    ]) {
      const select = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!
      await sdkSelectValue(select, value)
    }
    expect(container.querySelector('[data-width="390"]')).not.toBeNull()
    expect(container.querySelector('[data-theme="dark"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="hosting-preview-assistant"]')).not.toBeNull()
    expect(container.textContent).toContain(copy.paused)
    expect(container.textContent).toContain(copy.assignmentStates.running)
  })
})
