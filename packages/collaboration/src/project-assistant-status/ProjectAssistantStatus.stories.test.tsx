// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import registry from '../../design-system/project-assistant-status.json'
import { ProjectAssistantStatusPanel } from './ProjectAssistantStatusPanel'
import { projectAssistantStatusEnglish as copy } from './copy'
import { projectAssistantStatusFixtures } from './fixtures'
import meta, * as stories from './ProjectAssistantStatus.stories'

type StoryName = Exclude<keyof typeof stories, 'default'>
type PreviewArgs = Parameters<typeof meta.render>[0]
const fixtures = projectAssistantStatusFixtures.scenarios

it('registers and statically renders all 24 handoff states in both shared themes', () => {
  expect(registry.productionIntegration).toBe(false)
  expect(registry.storybook).toHaveLength(24)
  for (const name of registry.storybook) {
    const story = stories[name as StoryName]
    expect(story).toBeDefined()
    for (const theme of ['light', 'dark'] as const) {
      const html = renderToStaticMarkup(
        meta.render({ ...story.args, theme } as PreviewArgs),
      )
      expect(html).toContain(`data-theme="${theme}"`)
      expect(html).toContain(
        'locale' in story.args && story.args.locale === 'zh-CN'
          ? '合成设计参考'
          : 'Synthetic design reference',
      )
      expect(html).toContain('hosting-review-canvas')
      if (name === 'FeatureOff')
        expect(html).not.toContain('data-testid="project-assistant-status"')
      else if (name === 'Manager') {
        expect(html).toContain('project-assistant-status-manager')
        expect(html).toContain('<dd>Yes</dd>')
        expect(html).toContain('<dd>Device online</dd>')
      } else expect(html).toContain('data-testid="project-assistant-status"')
    }
  }
})

describe('hosting design component contracts', () => {
  it('renders both entry layouts using the same snapshot', () => {
    const html = renderToStaticMarkup(
      meta.render(stories.Matrix.args as PreviewArgs),
    )
    expect(html).toContain('hosting-preview-project')
    expect(html).toContain('hosting-preview-assistant')
    expect(html.match(/Waiting for the execution device/g)).toHaveLength(2)
  })

  it('keeps current hosting and historical assignment state separate', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel status={fixtures.pausedRunning} />,
    )
    expect(html).toContain(copy.paused)
    expect(html).toContain(copy.assignmentStates.running)
    expect(html).toContain(copy.pausedPolicy)
  })

  it('does not claim completion without a delivery reference', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel status={fixtures.incompleteEvidence} />,
    )
    expect(html).toContain(copy.incompleteEvidence)
    expect(html).not.toContain(
      `<strong>${copy.assignmentStates.completed}</strong>`,
    )
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel status={fixtures.completed} />,
      ),
    ).toContain(`<strong>${copy.assignmentStates.completed}</strong>`)
  })

  it('renders an actual minimal manager DTO without owner identifiers or private fields', () => {
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel
        audience="manager"
        status={{
          dispatchable: true,
          availability: 'online',
          prompt: 'private-example',
        }}
      />,
    )
    expect(html).toContain('<dd>Yes</dd>')
    expect(html).toContain('<dd>Device online</dd>')
    expect(html).not.toMatch(
      /private-example|ownerUserId|endpoint|humanAssignmentId|task-example/,
    )
  })

  it('shows unknown and unavailable state without inventing success', () => {
    expect(
      renderToStaticMarkup(<ProjectAssistantStatusPanel status={null} />),
    ).toContain(copy.unknown)
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel status={fixtures.hosting} loading />,
      ),
    ).toContain(copy.loading)
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel status={fixtures.hosting} error />,
      ),
    ).toContain(copy.error)
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel
          status={fixtures.hosting}
          featureEnabled={false}
        />,
      ),
    ).toBe('')
  })

  it('only renders recovery controls with supplied handlers and accepts caller copy', () => {
    expect(
      renderToStaticMarkup(
        <ProjectAssistantStatusPanel status={fixtures.waitingDevice} />,
      ),
    ).not.toContain('<button')
    const custom = { ...copy, settingsAction: 'Open custom settings' }
    const html = renderToStaticMarkup(
      <ProjectAssistantStatusPanel
        status={fixtures.waitingDevice}
        copy={custom}
        onOpenSettings={() => undefined}
      />,
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
          .querySelector<HTMLButtonElement>(
            '[data-testid="project-assistant-recovery"]',
          )!
          .click(),
      )
      expect(
        container.querySelector(`[data-testid="hosting-demo-${destination}"]`),
      ).not.toBeNull()
      if (destination === 'receipt')
        expect(container.textContent).toContain('assignment-example')
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="hosting-demo-close"]',
          )!
          .click(),
      )
      expect(
        container.querySelector(`[data-testid="hosting-demo-${destination}"]`),
      ).toBeNull()
    },
  )

  it('switches scenario, content width, theme and entry without touching execution state', async () => {
    await act(async () =>
      root.render(meta.render({ scenario: 'waitingDevice' })),
    )
    for (const [testId, value] of [
      ['hosting-review-scenario', 'pausedRunning'],
      ['hosting-review-width', '390'],
      ['hosting-review-theme', 'dark'],
      ['hosting-review-surface', 'assistant'],
    ]) {
      const select = container.querySelector<HTMLSelectElement>(
        `[data-testid="${testId}"]`,
      )!
      await act(async () => {
        select.value = value
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    }
    expect(container.querySelector('[data-width="390"]')).not.toBeNull()
    expect(container.querySelector('[data-theme="dark"]')).not.toBeNull()
    expect(
      container.querySelector('[data-testid="hosting-preview-assistant"]'),
    ).not.toBeNull()
    expect(container.textContent).toContain(copy.paused)
    expect(container.textContent).toContain(copy.assignmentStates.running)
  })
})
