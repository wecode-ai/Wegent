import { afterEach, expect, test } from 'vitest'
import {
  collaborationProjectViewSelector,
  waitForProjectIdentity,
} from '../../e2e/desktop/modules/collaboration-project-navigation.mjs'

const ROOT = '[data-testid="project-surface"]'

afterEach(() => document.body.replaceChildren())

function render(compact: boolean, name = 'Project') {
  document.body.innerHTML = `<section data-testid="project-surface">
    <header data-testid="cloud-project-header-title" style="display:${compact ? 'none' : 'block'}">${name}</header>
    <aside data-testid="collaboration-platform-sidebar"><button data-testid="collaboration-workspace-project-1" aria-current="page">${name}</button></aside>
    ${
      compact
        ? '<select data-testid="collaboration-project-view-select"><option value="board">Board</option><option value="manage">Manage</option></select>'
        : '<button data-testid="collaboration-tab-board" aria-current="page">Board</button><button data-testid="collaboration-tab-manage">Manage</button>'
    }
  </section>`
}

test.each([false, true])(
  'permission revocation and selected view remain observable, compact=%s',
  compact => {
    render(compact)
    expect(document.querySelector(collaborationProjectViewSelector(ROOT, 'manage'))).not.toBeNull()
    expect(
      document.querySelector(collaborationProjectViewSelector(ROOT, 'board', true))
    ).not.toBeNull()
    expect(
      document.querySelector(collaborationProjectViewSelector(ROOT, 'manage', true))
    ).toBeNull()
    document
      .querySelector('[data-testid="collaboration-tab-manage"], option[value="manage"]')!
      .remove()
    expect(document.querySelector(collaborationProjectViewSelector(ROOT, 'manage'))).toBeNull()
    expect(
      document.querySelector(collaborationProjectViewSelector(ROOT, 'board', true))
    ).not.toBeNull()
  }
)

test.each([
  [false, false],
  [true, true],
  [false, true],
  [true, false],
])(
  'retains identity and layout-specific visibility across compact=%s -> %s',
  async (before, after) => {
    render(before)
    let observations = 0
    await waitForProjectIdentity(
      {
        async command(
          action: string,
          selector: string,
          options: { text: string; visible?: boolean; timeoutMs: number }
        ) {
          expect(action).toBe('waitFor')
          expect(options.timeoutMs).toBe(10_000)
          if (++observations === 2) render(after)
          const elements = [...document.querySelectorAll<HTMLElement>(selector)]
          expect(
            elements.some(
              element =>
                element.textContent === options.text &&
                (!options.visible || element.style.display !== 'none')
            )
          ).toBe(true)
          return ''
        },
      },
      ROOT,
      'Project'
    )
    expect(observations).toBe(2)
  }
)

test.each([false, true])(
  'a matching stale title cannot mask the wrong active project, compact=%s',
  async compact => {
    render(compact, 'Other project')
    if (compact)
      document.querySelector('[data-testid="cloud-project-header-title"]')!.textContent = 'Project'
    await expect(
      waitForProjectIdentity(
        {
          async command(
            _action: string,
            selector: string,
            options: { text: string; visible?: boolean }
          ) {
            const matches = [...document.querySelectorAll<HTMLElement>(selector)]
            if (
              !matches.some(
                element =>
                  element.textContent === options.text &&
                  (!options.visible || element.style.display !== 'none')
              )
            )
              throw new Error('Project identity mismatch')
            return ''
          },
        },
        ROOT,
        'Project'
      )
    ).rejects.toThrow('Project identity mismatch')
  }
)
