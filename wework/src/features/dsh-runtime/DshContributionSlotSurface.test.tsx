import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { clearDshUiModuleCache } from './dshUiModules'
import { WEWORK_DSH_SLOTS } from './dshUiSlots'
import { DshContributionSlotSurface } from './DshContributionSlotSurface'

vi.mock('./DshSlotSurface', () => ({
  DshSlotSurface: ({ entryId, props }: { entryId: string; props: { label: string } }) => (
    <div data-testid={`attached-contribution-${entryId}`}>
      {entryId}:{props.label}
    </div>
  ),
}))

describe('DshContributionSlotSurface', () => {
  const modulePath = 'plugins/test-task-status.js'
  const entries = [{ id: 'module-status', module: modulePath }, { id: 'attached-status' }]

  beforeEach(() => {
    clearDshUiModuleCache()
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === WEWORK_DSH_SLOTS.taskStatus ? entries : []),
      subscribe: () => () => {},
      attach: () => ({ update: () => {}, dispose: () => {} }),
    }
    window.__WEWORK_DSH_UI_MODULES__ = {
      [modulePath]: {
        default: ({ label }: { label: string }) => (
          <span data-testid="module-contribution">{label}</span>
        ),
      },
    }
  })

  afterEach(() => {
    delete window.__WEWORK_DSH_UI_MODULES__
  })

  test('renders first-party modules and standard DSH components through the same slot', async () => {
    await act(async () => {
      render(
        <DshContributionSlotSurface
          props={{ label: 'generic status' }}
          slot={WEWORK_DSH_SLOTS.taskStatus}
        />
      )
    })

    expect(screen.getByTestId('module-contribution')).toHaveTextContent('generic status')
    expect(screen.getByTestId('attached-contribution-attached-status')).toHaveTextContent(
      'attached-status:generic status'
    )
    expect(
      screen
        .getByTestId('module-contribution')
        .compareDocumentPosition(screen.getByTestId('attached-contribution-attached-status'))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  test('filters contributions with the surface-local context', async () => {
    const gitModule = 'plugins/test-git-summary.js'
    const outputsModule = 'plugins/test-outputs-summary.js'
    const summaryEntries = [
      {
        id: 'git',
        module: gitModule,
        when: { key: 'workspace.isGitRepository', equals: true },
      },
      {
        id: 'outputs',
        module: outputsModule,
        when: { key: 'workspace.isGitRepository', equals: false },
      },
    ]
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === WEWORK_DSH_SLOTS.conversationSummary ? summaryEntries : []),
      subscribe: () => () => {},
      attach: () => ({ update: () => {}, dispose: () => {} }),
    }
    window.__WEWORK_DSH_UI_MODULES__ = {
      [gitModule]: { default: () => <span data-testid="git-summary">Git</span> },
      [outputsModule]: { default: () => <span data-testid="outputs-summary">Outputs</span> },
    }

    await act(async () => {
      render(
        <DshContributionSlotSurface
          props={{ context: { 'workspace.isGitRepository': false } }}
          slot={WEWORK_DSH_SLOTS.conversationSummary}
        />
      )
    })

    expect(screen.queryByTestId('git-summary')).not.toBeInTheDocument()
    expect(screen.getByTestId('outputs-summary')).toBeInTheDocument()
  })

  test('does not reinterpret when metadata for unrelated contribution slots', async () => {
    const module = 'plugins/test-project-work.js'
    const entry = {
      id: 'project-work',
      module,
      when: { key: 'workspace.isGitRepository', equals: true },
    }
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === WEWORK_DSH_SLOTS.projectWorkSection ? [entry] : []),
      subscribe: () => () => {},
      attach: () => ({ update: () => {}, dispose: () => {} }),
    }
    window.__WEWORK_DSH_UI_MODULES__ = {
      [module]: { default: () => <span data-testid="project-work">Project work</span> },
    }

    await act(async () => {
      render(
        <DshContributionSlotSurface
          props={{ context: { 'workspace.isGitRepository': false } }}
          slot={WEWORK_DSH_SLOTS.projectWorkSection}
        />
      )
    })

    expect(screen.getByTestId('project-work')).toBeInTheDocument()
  })
})
