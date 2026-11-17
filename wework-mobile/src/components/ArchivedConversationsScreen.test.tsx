vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }))
import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchivedConversationsScreen } from './ArchivedConversationsScreen'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { DeviceInfo } from '@/types/runtime'
import type { ArchivedConversationItem } from '../../../packages/chat-core/src/runtime-management-types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const native = vi.hoisted(() => ({ confirm: vi.fn(), error: vi.fn() }))
vi.mock('@/services/errorAlerts', () => ({
  confirmNativeAction: native.confirm,
  showErrorAlert: native.error,
}))
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  FlatList: ({
    data,
    renderItem,
    ListHeaderComponent,
    ListEmptyComponent,
    ...props
  }: {
    data: unknown[]
    renderItem: (input: { item: unknown }) => React.ReactNode
    ListHeaderComponent: React.ReactNode
    ListEmptyComponent: React.ReactNode
  }) => (
    <section {...props}>
      {ListHeaderComponent}
      {data.length
        ? data.map((item, index) => (
            <React.Fragment key={index}>{renderItem({ item })}</React.Fragment>
          ))
        : ListEmptyComponent}
    </section>
  ),
}))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'Spinner',
  Button: 'Button',
  Text: 'Text',
  TextInput: 'TextInput',
  useTheme: () => ({ colors: {} }),
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('./errors/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }))
const item: ArchivedConversationItem = {
  id: 'task',
  taskId: 'task',
  title: 'Archived',
  workspacePath: '/repo',
  deviceId: 'computer',
  source: 'local',
  updatedAt: 12,
}
const devices: DeviceInfo[] = ['computer', 'peer'].map((id, index) => ({
  id: index,
  device_id: id,
  name: id,
  status: 'online',
  device_type: 'cloud',
  bind_shell: 'claudecode',
}))
let renderer: ReactTestRenderer
const api = {
  listArchivedConversations: vi.fn(),
  unarchiveConversation: vi.fn(),
  deleteArchivedConversation: vi.fn(),
}
const props = {
  api: api as unknown as RuntimeApi,
  devices,
  selectedDeviceId: 'computer',
  refreshWork: vi.fn(),
  onBack: vi.fn(),
}
const element = (id: string) =>
  renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0]!
beforeEach(async () => {
  vi.resetAllMocks()
  api.listArchivedConversations.mockImplementation(async ({ deviceId }) => ({
    items: deviceId === 'computer' ? [item] : [],
    total: 1,
    projectGroups: [],
  }))
  api.unarchiveConversation.mockResolvedValue({ accepted: true })
  api.deleteArchivedConversation.mockResolvedValue({ accepted: true })
  await act(() => {
    renderer = create(<ArchivedConversationsScreen {...props} />)
  })
})
afterEach(async () => {
  await act(() => renderer.unmount())
})
describe('archived conversation management', () => {
  it('loads only the selected device and restores the exact task address', async () => {
    expect(api.listArchivedConversations).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'computer',
      sort: 'updated',
    })
    props.refreshWork.mockRejectedValue(new Error('Read failed'))
    await act(() => element('archives-restore-computer-task').props.onPress())
    expect(api.unarchiveConversation.mock.calls[0]![0]).toMatchObject({
      deviceId: 'computer',
      taskId: 'task',
      workspacePath: '/repo',
    })
    expect(renderer.root.findAllByProps({ testID: 'archives-restore-computer-task' })).toHaveLength(
      0
    )
    expect(native.error).not.toHaveBeenCalled()
  })
  it('does not resurrect an accepted restore from an older in-flight list read', async () => {
    let resolve!: (value: unknown) => void
    api.listArchivedConversations.mockReturnValueOnce(
      new Promise(done => {
        resolve = done
      })
    )
    const list = renderer.root.findByType('section' as never)
    await act(() => list.props.refreshControl.props.onRefresh())
    await act(() => element('archives-restore-computer-task').props.onPress())
    await act(() => resolve({ items: [item] }))
    expect(renderer.root.findAllByProps({ testID: 'archives-restore-computer-task' })).toHaveLength(
      0
    )
  })
  it('requires native confirmation before permanent deletion', async () => {
    await act(() => element('archives-delete-computer-task').props.onPress())
    expect(api.deleteArchivedConversation).not.toHaveBeenCalled()
    expect(native.confirm.mock.calls[0]![2]).toMatchObject({
      destructive: true,
      confirmLabel: '永久删除',
    })
    await act(() => native.confirm.mock.calls[0]![2].onConfirm())
    expect(api.deleteArchivedConversation).toHaveBeenCalledTimes(1)
  })
  it('expires deletion confirmation on device changes', async () => {
    await act(() => element('archives-delete-computer-task').props.onPress())
    const confirmation = native.confirm.mock.calls[0]![2]
    await act(() =>
      renderer.update(<ArchivedConversationsScreen {...props} selectedDeviceId="peer" />)
    )
    await act(() => confirmation.onConfirm())
    expect(api.deleteArchivedConversation).not.toHaveBeenCalled()
  })
  it('keeps content and exposes the original error when restoration fails', async () => {
    const error = new Error('Restore failed')
    api.unarchiveConversation.mockRejectedValue(error)
    await act(() => element('archives-restore-computer-task').props.onPress())
    expect(native.error).toHaveBeenCalledWith(error, { title: '无法恢复会话' })
    expect(element('archives-restore-computer-task')).toBeDefined()
  })
  it('isolates a device read failure from other archives and retries only that source', async () => {
    api.listArchivedConversations.mockImplementation(async ({ deviceId }) => {
      if (deviceId === 'peer') throw new Error('Peer offline')
      return { items: [item] }
    })
    await act(() =>
      renderer.update(<ArchivedConversationsScreen {...props} selectedDeviceId={null} />)
    )
    expect(element('archives-restore-computer-task')).toBeDefined()
    expect(element('archives-error-peer')).toBeDefined()
    api.listArchivedConversations.mockClear()
    await act(() => element('archives-error-peer').props.onRetry())
    expect(api.listArchivedConversations).toHaveBeenCalledExactlyOnceWith({
      deviceId: 'peer',
      sort: 'updated',
    })
  })
})
