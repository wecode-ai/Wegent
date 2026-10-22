// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectCreationAction } from './ProjectCreationAction'

const messages = {
  addProject: '新建项目',
  blankProject: '空白项目',
  addFolder: '从本地文件夹创建',
  importExistingProject: '导入已有项目',
}

describe('ProjectCreationAction', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  async function renderAction(supportsLocalImport: boolean, testId: string) {
    const onSelect = vi.fn()
    await act(async () => {
      root.render(
        <ProjectCreationAction
          className="collaboration-primary-button"
          messages={messages}
          supportsLocalImport={supportsLocalImport}
          testId={testId}
          onSelect={onSelect}
        />
      )
    })
    return { trigger: container.querySelector<HTMLButtonElement>('button')!, onSelect }
  }

  it.each([
    'collaboration-workspace-project-create',
    'collaboration-workspace-starter-create-project',
    'collaboration-first-project-create',
  ])('directly selects the only available action at %s', async testId => {
    const { trigger, onSelect } = await renderAction(false, testId)
    expect(trigger.getAttribute('aria-haspopup')).toBeNull()
    expect(trigger.querySelector('.lucide-chevron-down')).toBeNull()
    await act(async () => trigger.click())
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('blank')
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })

  it.each([
    [
      'collaboration-workspace-project-create',
      'collaboration-workspace-project-create-blank',
      'blank',
    ],
    [
      'collaboration-workspace-project-create',
      'collaboration-workspace-project-import-folder',
      'folder',
    ],
    [
      'collaboration-workspace-project-create',
      'collaboration-workspace-project-open-existing',
      'existing',
    ],
    [
      'collaboration-workspace-starter-create-project',
      'collaboration-workspace-starter-create-project-blank',
      'blank',
    ],
    [
      'collaboration-workspace-starter-create-project',
      'collaboration-workspace-starter-create-project-folder',
      'folder',
    ],
    [
      'collaboration-workspace-starter-create-project',
      'collaboration-workspace-starter-create-project-existing',
      'existing',
    ],
  ])('opens multiple choices at %s and selects %s', async (testId, optionId, mode) => {
    const { trigger, onSelect } = await renderAction(true, testId)
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.querySelector('.lucide-chevron-down')).not.toBeNull()
    await act(async () => trigger.click())
    expect(onSelect).not.toHaveBeenCalled()
    const menu = document.body.querySelector(`[data-testid="${testId}-menu"]`)!
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(3)
    const option = menu.querySelector<HTMLButtonElement>(`[data-testid="${optionId}"]`)!
    await act(async () => option.click())
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(mode)
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
  })
})
