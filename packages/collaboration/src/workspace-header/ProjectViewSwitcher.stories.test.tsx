// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import registry from '../../design-system/project-view-switcher.json'
import meta, * as stories from './ProjectViewSwitcher.stories'

it('registers and renders every handoff state in both themes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    expect(registry.id).toBe('project-view-switcher')
    expect(registry.storybook).toHaveLength(9)
    for (const name of registry.storybook) {
      const story = stories[name as Exclude<keyof typeof stories, 'default'>]
      expect(story).toBeDefined()
      for (const theme of ['light', 'dark'] as const) {
        await act(async () =>
          root.render(
            meta.render({ ...story.args, theme } as Parameters<
              typeof meta.render
            >[0]),
          ),
        )
        expect(
          container.querySelectorAll(`[data-theme="${theme}"] nav`),
        ).toHaveLength(1)
        if ('play' in story) {
          await act(async () => story.play({ canvasElement: container }))
          expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
          expect(
            document.querySelector('[role="menu"]')?.getAttribute('data-theme'),
          ).toBe(theme)
        }
      }
    }
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
