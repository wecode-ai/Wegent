import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { DshMenuActions } from './DshMenuActions'

const execute = vi.fn()
const listeners = new Set<() => void>()
const context = new Map<string, unknown>()
let revision = 0

describe('DshMenuActions', () => {
  beforeEach(() => {
    execute.mockReset().mockResolvedValue(undefined)
    listeners.clear()
    context.clear()
    revision = 1
    window.__WEWORK_DSH_EXTENSIONS__ = {
      getRevision: () => revision,
      subscribe: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      commands: {
        execute,
        get: id =>
          id === 'quality.refresh'
            ? {
                enablement: { key: 'workspace.ready', equals: true },
                icon: 'refresh-cw',
                id,
                title: 'Refresh quality',
              }
            : null,
        list: () => [],
        register: vi.fn(),
        subscribe: listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      composer: {
        references: {
          list: () => [],
          register: vi.fn(),
          subscribe: () => () => {},
        },
      },
      context: {
        entries: () => ({}),
        get: key => context.get(key) as string | undefined,
        matches: expression => {
          if (!expression || typeof expression === 'string') return true
          if ('key' in expression && 'equals' in expression) {
            return context.get(expression.key) === expression.equals
          }
          return true
        },
        set: vi.fn(),
        subscribe: listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      configuration: {
        get: () => null,
        getDefinition: () => null,
        register: vi.fn(),
        subscribe: () => () => {},
        update: vi.fn(),
      },
      keybindings: {
        list: () => [],
        register: vi.fn(),
        subscribe: listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      menus: {
        list: () => [
          {
            command: 'quality.refresh',
            enabled: true,
            id: 'quality.refresh.menu',
          },
        ],
        register: vi.fn(),
        subscribe: listener => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      secrets: {
        scope: vi.fn(),
      },
      storage: {
        scope: vi.fn(),
      },
    }
  })

  test('renders command-backed menu actions and follows context enablement', async () => {
    render(<DshMenuActions location="workspace.toolbar" />)

    const button = screen.getByTestId('wework-menu-action-quality.refresh.menu')
    expect(button).toBeDisabled()

    act(() => {
      context.set('workspace.ready', true)
      revision += 1
      for (const listener of [...listeners]) listener()
    })
    expect(button).toBeEnabled()

    await userEvent.click(button)
    expect(execute).toHaveBeenCalledWith('quality.refresh', undefined, {
      menuId: 'quality.refresh.menu',
      menuLocation: 'workspace.toolbar',
      source: 'menu',
    })
  })

  test('honors a disabled host surface', () => {
    context.set('workspace.ready', true)

    render(<DshMenuActions disabled location="composer.toolbar" />)

    expect(screen.getByTestId('wework-menu-action-quality.refresh.menu')).toBeDisabled()
  })
})
