// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceApi, WorkspaceGitRepository } from '../ports/SharedWorkspaceApi'
import type { CollaborationProject } from '../types'
import { ProjectExecutionEnvironments } from './ProjectExecutionEnvironments'

const prefix = 'collaboration-project-execution-environment'
const translate = createCollaborationTranslator('zh-CN')
let root: Root, container: HTMLDivElement
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function source() {
  const list = vi.fn().mockResolvedValue([])
  const api = {
    projects: { listExecutionEnvironments: vi.fn().mockResolvedValue([]) },
    gitRepositories: { list, listBranches: vi.fn().mockResolvedValue([]) },
  } as unknown as SharedWorkspaceApi
  return { list, api }
}
function project(id: string): CollaborationProject {
  return {
    id,
    version: 1,
    access_role: 'Maintainer',
    project_store: 'local',
    execution_environment: {
      workspace_policy: 'project',
      fingerprint: '',
      devices: {},
      setup_steps: [],
      repositories: [{ name: id, url: `https://example/${id}`, ref: '', path: id, primary: true }],
    },
  } as CollaborationProject
}
async function render(api: SharedWorkspaceApi, id: string) {
  await act(async () =>
    root.render(
      <ProjectExecutionEnvironments api={api} project={project(id)} translate={translate} />
    )
  )
}
const preparationToggle = () =>
  container.querySelector<HTMLButtonElement>(`[data-testid="${prefix}-preparation-toggle"]`)!
async function togglePreparation() {
  await act(async () => preparationToggle().click())
}
const field = (suffix: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="${prefix}-${suffix}-0"]`)!

test('project changes reset configuration drafts even when their version numbers match', async () => {
  const f = source()
  await render(f.api, 'first')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      field('repository-name'),
      'Unsent edit'
    )
    field('repository-name').dispatchEvent(new Event('input', { bubbles: true }))
  })
  await render(f.api, 'second')
  expect(field('repository-name').value).toBe('second')
  expect(field('repository-url').value).toBe('https://example/second')
})

test('a late catalog from the previous API owner cannot replace the active editor catalog', async () => {
  const old = source(),
    current = source()
  let resolve!: (value: WorkspaceGitRepository[]) => void
  old.list.mockReturnValueOnce(
    new Promise(accept => {
      resolve = accept
    })
  )
  await render(old.api, 'same-project')
  await togglePreparation()
  expect(old.list).toHaveBeenCalledTimes(1)
  await render(current.api, 'same-project')
  expect(preparationToggle().getAttribute('aria-expanded')).toBe('true')
  await togglePreparation()
  await togglePreparation()
  await act(async () =>
    resolve([
      {
        id: 1,
        name: 'old',
        fullName: 'org/old',
        cloneUrl: 'https://old',
        provider: 'gitlab',
        gitDomain: 'old',
      },
    ])
  )
  expect(field('repository-url').tagName).toBe('INPUT')
  expect(field('repository-url').value).toBe('https://example/same-project')
})
