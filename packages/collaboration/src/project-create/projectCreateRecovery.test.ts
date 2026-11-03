// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useProjectCreateController } from './useProjectCreateController'
import { projectCreateLabels } from './labels'
import type { ProjectCreateDialogProps } from './types'

it('keeps creation retryable without persisting a project when resource preflight fails', async () => {
  const project = { id: 'created-project', name: 'Product' }
  const create = vi.fn(async () => project)
  const configure = vi.fn(async () => project)
  const validate = vi
    .fn()
    .mockRejectedValueOnce(new Error('Configure a default model first'))
    .mockResolvedValueOnce(undefined)
  const onCreated = vi.fn()
  const props = {
    targets: [{ location: 'local', create }],
    defaultLocation: 'local',
    allowDingTalkAITable: false,
    labels: projectCreateLabels['zh-CN'],
    onCreated,
    resourceSetup: { validate, configure },
    onClose: vi.fn(),
  } as unknown as ProjectCreateDialogProps
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const result = {
    current: null as unknown as ReturnType<typeof useProjectCreateController>,
  }
  function Harness() {
    result.current = useProjectCreateController(props)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Harness)))
  act(() => result.current.commands.setName('Product'))
  await act(async () => result.current.commands.submit())
  expect(create).not.toHaveBeenCalled()
  expect(configure).not.toHaveBeenCalled()
  expect(onCreated).not.toHaveBeenCalled()
  expect(result.current.state.createdProject).toBeNull()
  expect(result.current.state.error).toBe('Configure a default model first')
  expect(result.current.state.canSubmit).toBe(true)
  await act(async () => result.current.commands.submit())
  expect(validate).toHaveBeenCalledTimes(2)
  expect(validate.mock.calls[1][0]).toEqual(configure.mock.calls[0][1])
  expect(create).toHaveBeenCalledTimes(1)
  expect(configure).toHaveBeenCalledTimes(1)
  expect(onCreated).toHaveBeenCalledWith(project, 'local')
  act(() => root.unmount())
})

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
  const result = {
    current: null as unknown as ReturnType<typeof useProjectCreateController>,
  }
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

it('opens the configured project so template board defaults are visible immediately', async () => {
  const project = { id: 'created-project', name: 'Product' }
  const configured = {
    ...project,
    version: 2,
    board_views: {
      default_view_id: 'stages',
      views: [{ id: 'stages', name: '项目阶段' }],
    },
  }
  const onCreated = vi.fn()
  const props = {
    targets: [{ location: 'local', create: async () => project }],
    defaultLocation: 'local',
    allowDingTalkAITable: false,
    labels: projectCreateLabels['zh-CN'],
    onCreated,
    resourceSetup: { configure: async () => configured },
    onClose: vi.fn(),
  } as unknown as ProjectCreateDialogProps
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const result = {
    current: null as unknown as ReturnType<typeof useProjectCreateController>,
  }
  function Harness() {
    result.current = useProjectCreateController(props)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Harness)))
  act(() => result.current.commands.setName('Product'))
  await act(async () => result.current.commands.submit())
  expect(onCreated).toHaveBeenCalledWith(configured, 'local')
  act(() => root.unmount())
})
