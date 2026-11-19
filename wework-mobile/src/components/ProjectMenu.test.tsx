import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectMenu } from './ProjectMenu'
import type { RuntimeProjectWork } from '@/types/runtime'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const native = vi.hoisted(() => ({ confirm: vi.fn(), error: vi.fn() }))
vi.mock('@/services/errorAlerts', () => ({
  confirmNativeAction: native.confirm,
  showErrorAlert: native.error,
}))
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({ View: 'View' }))
vi.mock('react-native-paper', () => ({
  Button: 'Button',
  Dialog: Object.assign('Dialog', { Title: 'Title', Content: 'Content', Actions: 'Actions' }),
  Portal: 'Portal',
  TextInput: 'TextInput',
  useTheme: () => ({ colors: {} }),
}))
vi.mock('./ConversationMenuNative', () => ({ ConversationMenuNative: 'NativeMenu' }))
vi.mock('./errors/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }))
const project: RuntimeProjectWork = {
  project: { key: 'key', name: 'Project', stateDeviceId: 'computer' },
  deviceWorkspaces: [],
}
const actions = { onPin: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(), onArchive: vi.fn() }
let renderer: ReactTestRenderer
const menu = () => renderer.root.findByType('NativeMenu' as never)
beforeEach(async () => {
  vi.resetAllMocks()
  await act(() => {
    renderer = create(<ProjectMenu project={project} actions={actions} />)
  })
})
afterEach(async () => {
  await act(() => renderer.unmount())
})
describe('project menu', () => {
  it('pins the exact project and reflects persisted unpin state', async () => {
    await act(() => menu().props.onSelect('project-pin'))
    expect(actions.onPin).toHaveBeenCalledExactlyOnceWith(project, true)
    await act(() =>
      renderer.update(
        <ProjectMenu
          project={{ ...project, project: { ...project.project, pinned: true } }}
          actions={actions}
        />
      )
    )
    expect(menu().props.actions[0].title).toBe('取消置顶')
  })
  it('confirms that removal preserves files and conversations', async () => {
    await act(() => menu().props.onSelect('project-remove'))
    expect(actions.onRemove).not.toHaveBeenCalled()
    expect(native.confirm.mock.calls[0]![1]).toContain('磁盘文件和会话会保留')
    await act(() => native.confirm.mock.calls[0]![2].onConfirm())
    expect(actions.onRemove).toHaveBeenCalledExactlyOnceWith(project)
  })
})
