// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useProjectCreateController } from './useProjectCreateController'
import { projectCreateLabels } from './labels'
import type { ProjectCreateDialogProps } from './types'

it('opens the persisted project after setup fails instead of creating another project', async () => {
  const project = { id: 'created-project', name: 'Product' }
  const create = vi.fn(async () => project)
  const configure = vi.fn(async () => {
    throw new Error('Board version conflict')
  })
  const onCreated = vi.fn()
  const props = {
    targets: [{ location: 'local', create }],
    defaultLocation: 'local',
    allowDingTalkAITable: false,
    labels: projectCreateLabels['zh-CN'],
    onCreated,
    resourceSetup: { configure },
    onClose: vi.fn(),
  } as unknown as ProjectCreateDialogProps
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const result = { current: null as unknown as ReturnType<typeof useProjectCreateController> }
  function Harness() {
    result.current = useProjectCreateController(props)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Harness)))
  act(() => result.current.commands.setName('Product'))
  await act(async () => result.current.commands.submit())
  expect(result.current.state.createdProject?.id).toBe(project.id)
  expect(result.current.state.error).toContain('项目已创建')
  expect(result.current.state.error).toContain('Board version conflict')
  expect(onCreated).not.toHaveBeenCalled()
  act(() => result.current.commands.setLocation('cloud'))
  await act(async () => result.current.commands.submit())
  expect(create).toHaveBeenCalledTimes(1)
  expect(configure).toHaveBeenCalledTimes(1)
  expect(onCreated).toHaveBeenCalledWith(project, 'local')
  act(() => root.unmount())
})
