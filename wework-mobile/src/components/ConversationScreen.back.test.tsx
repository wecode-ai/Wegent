import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConversationScreen } from './ConversationScreen'
import {
  worktreeCapability,
  worktreeDevice,
  worktreePreflight,
  worktreeWorkspace,
} from '@/testing/worktreeFixtures'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const environment = vi.hoisted(() => ({
  focused: true,
  platform: 'android',
  backHandlers: new Set<() => boolean>(),
  composerInset: { value: 0 },
  gestureEnabled: true,
}))

vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Icon' }))
vi.mock('@react-navigation/native', async () => {
  const { useEffect } = await import('react')
  return {
    useIsFocused: () => environment.focused,
    useNavigation: () => ({
      setOptions: (options: { gestureEnabled?: boolean }) => {
        environment.gestureEnabled = options.gestureEnabled ?? true
      },
    }),
    useFocusEffect: (effect: () => void | (() => void)) =>
      useEffect(() => (environment.focused ? effect() : undefined), [effect, environment.focused]),
  }
})
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    addEventListener: () => ({ remove: vi.fn() }),
    isReduceMotionEnabled: async () => false,
  },
  Animated: {
    Value: class {
      stopAnimation() {}
      setValue() {}
      interpolate() {
        return 0
      }
    },
    timing: () => ({
      start: (complete?: (result: { finished: boolean }) => void) => complete?.({ finished: true }),
      stop: () => {},
    }),
    View: 'AnimatedView',
  },
  Easing: { in: (value: unknown) => value, out: (value: unknown) => value, cubic: 'cubic' },
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      environment.backHandlers.add(handler)
      return { remove: () => environment.backHandlers.delete(handler) }
    },
  },
  Keyboard: { dismiss: vi.fn() },
  Modal: 'Modal',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  TextInput: 'TextInput',
  Platform: {
    get OS() {
      return environment.platform
    },
  },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles },
  View: 'View',
}))
vi.mock('react-native-paper', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Text: 'Text',
  useTheme: () => ({ dark: false, colors: {} }),
}))
vi.mock('./errors/ErrorNotice', () => ({ ErrorNotice: 'ErrorNotice' }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 16 }),
}))
vi.mock('./ChatComposer', async () => {
  const { createElement, useState } = await import('react')
  return {
    ChatComposer: (props: { onSelectModel: () => void }) => {
      const [draft, setDraft] = useState('')
      return createElement('Composer', { ...props, draft, onChangeText: setDraft })
    },
  }
})
vi.mock('./ConversationEdgeMask', () => ({ ConversationEdgeMask: 'EdgeMask' }))
vi.mock('./ConversationChangesPill', () => ({ ConversationChangesPill: 'ChangesPill' }))
vi.mock('./ConversationAgentsPill', () => ({ ConversationAgentsPill: 'AgentsPill' }))
vi.mock('./ConversationHeader', () => ({
  ConversationHeader: 'Header',
  CONVERSATION_HEADER_HEIGHT: 44,
}))
vi.mock('./ConversationMenu', () => ({ ConversationMenu: 'ConversationMenu' }))
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardGestureArea: 'KeyboardGestureArea',
  KeyboardStickyView: 'KeyboardStickyView',
}))
vi.mock('@legendapp/list/keyboard', () => ({
  useKeyboardChatComposerInset: () => ({
    contentInsetEndAdjustment: environment.composerInset,
    onComposerLayout: (event: { nativeEvent: { layout: { height: number } } }) => {
      environment.composerInset.value = event.nativeEvent.layout.height
    },
  }),
}))
vi.mock('./MessageList', async () => {
  const { createElement } = await import('react')
  return {
    MessageList: (props: { configuration?: React.ReactElement }) =>
      createElement('MessageList', props, props.configuration),
  }
})
vi.mock('./QuickModelSelector', () => ({
  QuickModelDismissLayer: 'QuickDismiss',
  QuickModelSelector: 'QuickSelector',
}))

describe('conversation keyboard layout and model navigation', () => {
  let renderer: ReactTestRenderer
  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount())
    environment.focused = true
    environment.platform = 'android'
    environment.backHandlers.clear()
    environment.composerInset.value = 0
    environment.gestureEnabled = true
  })

  const props = (): React.ComponentProps<typeof ConversationScreen> => ({
    api: {
      getSubagentTranscript: vi.fn(),
      getWorktreeCapabilities: vi.fn(async ({ deviceId }) => ({
        success: true,
        deviceId,
        runtimeWorktrees: worktreeCapability,
      })),
      preflightWorkspace: vi.fn(async ({ deviceId }) => worktreePreflight({ deviceId })),
      listWorkspaceGitBranches: vi.fn(async () => ['main', 'feature/mobile']),
    },
    onComposerFocusHandled: vi.fn(),
    currentAddress: null,
    currentTitle: '',
    devices: [],
    entryRevision: 0,
    hasMoreMessagesBefore: false,
    historyLoaded: false,
    isNew: true,
    loading: false,
    loadingMoreMessagesBefore: false,
    messages: [],
    model: null,
    modelOptions: {},
    permissionMode: 'workspace-write',
    selectedDeviceId: null,
    selectedProjectName: null,
    selectedWorkspace: null,
    running: false,
    sending: false,
    stopping: false,
    workspaces: [],
    onBack: vi.fn(),
    onLoadApps: vi.fn(),
    onLoadMoreMessagesBefore: vi.fn(),
    conversationActions: {
      threadId: null,
      canPin: false,
      pinned: false,
      onPin: vi.fn(),
      onRename: vi.fn(),
      onArchive: vi.fn(),
      onSettings: vi.fn(),
    },
    onNewConversation: vi.fn(),
    onOpenAdvancedModel: vi.fn(),
    onSelectDevice: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectPermissionMode: vi.fn(),
    onSelectWorkspace: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    onUploadAttachment: vi.fn(),
  })
  const composer = () => renderer.root.findByType('Composer' as never)
  const quick = () => renderer.root.findAllByType('QuickSelector' as never)

  const projectProps = () => ({
    ...props(),
    devices: [worktreeDevice],
    selectedDeviceId: 'cloud',
    selectedWorkspace: worktreeWorkspace,
    selectedProjectName: 'Repository',
  })

  it('shows the original failed worktree check in its selector and permits an explicit retry', async () => {
    const handlers = projectProps()
    const failure = new Error('Remote control is disabled for this app device')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(handlers.api.getWorktreeCapabilities).mockRejectedValueOnce(failure)
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    await press('new-chat-work-mode')
    const notice = renderer.root.findByProps({ testID: 'work-mode-worktree-error' })
    expect(notice.props.error).toBe(failure)
    await act(() => notice.props.onRetry())
    expect(handlers.api.getWorktreeCapabilities).toHaveBeenCalledTimes(2)
    expect(renderer.root.findAllByProps({ testID: 'work-mode-worktree-error' })).toHaveLength(0)
    expect(renderer.root.findByProps({ testID: 'new-chat-choice-worktree' }).props.disabled).toBe(
      false
    )
    log.mockRestore()
  })
  const press = async (testID: string) => {
    await act(() => renderer.root.findByProps({ testID }).props.onPress())
  }

  it('creates a worktree from a searched starting branch and resets configuration when the workspace changes', async () => {
    const handlers = projectProps()
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    await press('new-chat-work-mode')
    await press('new-chat-choice-worktree')
    await press('new-chat-branch')
    expect(handlers.api.listWorkspaceGitBranches).toHaveBeenCalledExactlyOnceWith(
      'cloud',
      '/workspace/repo'
    )
    await act(() =>
      renderer.root.findByProps({ testID: 'new-chat-branch-search' }).props.onChangeText('ftmb')
    )
    expect(renderer.root.findAllByProps({ testID: 'new-chat-branch-choice-main' })).toHaveLength(0)
    await press('new-chat-branch-choice-feature/mobile')
    expect(handlers.api.preflightWorkspace).toHaveBeenLastCalledWith({
      deviceId: 'cloud',
      sourcePath: '/workspace/repo',
      ref: 'feature/mobile',
    })
    const options = { attachmentIds: [], attachments: [], pursueGoal: false }
    await act(() => composer().props.onSend('Inspect changes', options))
    expect(handlers.onSend).toHaveBeenLastCalledWith('Inspect changes', {
      ...options,
      executionMode: 'git_worktree',
      worktreeBranch: 'feature/mobile',
    })
    await act(() =>
      renderer.update(
        <ConversationScreen
          {...handlers}
          selectedWorkspace={{ ...worktreeWorkspace, workspacePath: '/workspace/other' }}
        />
      )
    )
    expect(renderer.root.findByProps({ testID: 'new-chat-work-mode' }).props.label).toBe(
      '在本地工作'
    )
    await act(() => composer().props.onSend('Use other repository', options))
    expect(handlers.onSend).toHaveBeenLastCalledWith('Use other repository', {
      ...options,
      executionMode: 'current_workspace',
    })
  })

  it('keeps worktree mode separate from an optional current-branch override', async () => {
    const handlers = projectProps()
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    await press('new-chat-work-mode')
    await press('new-chat-choice-worktree')
    await press('new-chat-branch')
    await press('new-chat-branch-choice-main')
    const options = { attachmentIds: [], attachments: [], pursueGoal: false }
    await act(() => composer().props.onSend('Use HEAD', options))
    expect(handlers.onSend).toHaveBeenCalledExactlyOnceWith('Use HEAD', {
      ...options,
      executionMode: 'git_worktree',
    })
    await act(() => renderer.update(<ConversationScreen {...handlers} entryRevision={1} />))
    expect(renderer.root.findByProps({ testID: 'new-chat-work-mode' }).props.label).toBe(
      '在本地工作'
    )
  })

  it('allows selecting another branch after a previously listed starting ref becomes invalid', async () => {
    const handlers = projectProps()
    vi.mocked(handlers.api.preflightWorkspace).mockImplementation(async input =>
      worktreePreflight(
        input.ref === 'feature/mobile'
          ? {
              errorCode: 'worktree_ref_not_found',
              error: 'Git ref was not found',
              refValid: false,
              writable: false,
            }
          : {}
      )
    )
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    await press('new-chat-work-mode')
    await press('new-chat-choice-worktree')
    await press('new-chat-branch')
    await press('new-chat-branch-choice-feature/mobile')
    expect(renderer.root.findByProps({ testID: 'new-chat-branch' }).props.disabled).toBe(false)
    expect(
      renderer.root.findByProps({ testID: 'new-chat-worktree-error' }).props.error.errorCode
    ).toBe('worktree_ref_not_found')
    await act(() =>
      composer().props.onSend('Use removed ref', {
        attachmentIds: [],
        attachments: [],
        pursueGoal: false,
      })
    )
    expect(handlers.onSend).not.toHaveBeenCalled()
    await press('new-chat-branch')
    await press('new-chat-branch-choice-main')
    await act(() =>
      composer().props.onSend('Use current ref', {
        attachmentIds: [],
        attachments: [],
        pursueGoal: false,
      })
    )
    expect(handlers.onSend).toHaveBeenCalledWith(
      'Use current ref',
      expect.objectContaining({ executionMode: 'git_worktree' })
    )
  })

  it('offers worktree mode when preflight succeeds without a named current branch', async () => {
    const handlers = projectProps()
    vi.mocked(handlers.api.preflightWorkspace).mockResolvedValue(
      worktreePreflight({ currentBranch: null })
    )
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    await press('new-chat-work-mode')
    expect(renderer.root.findByProps({ testID: 'new-chat-choice-worktree' }).props.disabled).toBe(
      false
    )
    await press('new-chat-choice-worktree')
    expect(renderer.root.findByProps({ testID: 'new-chat-branch' }).props.label).toBe('选择分支')
    await act(() =>
      composer().props.onSend('Use HEAD', { attachmentIds: [], attachments: [], pursueGoal: false })
    )
    expect(handlers.onSend).toHaveBeenCalledWith(
      'Use HEAD',
      expect.objectContaining({ executionMode: 'git_worktree' })
    )
  })

  it('keeps branch failures in the selector and permits explicit retry and an empty search', async () => {
    const handlers = projectProps()
    const failure = new Error('Branch read failed')
    vi.mocked(handlers.api.listWorkspaceGitBranches).mockRejectedValueOnce(failure)
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    await press('new-chat-work-mode')
    await press('new-chat-choice-worktree')
    await press('new-chat-branch')
    const notice = renderer.root.findByProps({ testID: 'new-chat-branches-error' })
    expect(notice.props.error).toBe(failure)
    expect(handlers.onSend).not.toHaveBeenCalled()
    await act(() => notice.props.onRetry())
    expect(renderer.root.findAllByProps({ testID: 'new-chat-branches-error' })).toHaveLength(0)
    await act(() =>
      renderer.root
        .findByProps({ testID: 'new-chat-branch-search' })
        .props.onChangeText('no-matching-branch')
    )
    expect(renderer.root.findByProps({ testID: 'new-chat-branches-empty' })).toBeDefined()
  })

  it('shows the preflight reason while leaving current-workspace execution available', async () => {
    const handlers = projectProps()
    vi.mocked(handlers.api.preflightWorkspace).mockResolvedValue(
      worktreePreflight({ gitRepository: false })
    )
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    await press('new-chat-work-mode')
    const worktree = renderer.root.findByProps({ testID: 'new-chat-choice-worktree' })
    expect(worktree.props.disabled).toBe(true)
    expect(
      worktree
        .findAllByType('Text' as never)
        .some(node => node.props.children === '当前工作区不是 Git 仓库。')
    ).toBe(true)
    await act(() =>
      composer().props.onSend('Use workspace', {
        attachmentIds: [],
        attachments: [],
        pursueGoal: false,
      })
    )
    expect(handlers.onSend).toHaveBeenCalledWith(
      'Use workspace',
      expect.objectContaining({ executionMode: 'current_workspace' })
    )
  })

  it('permits composer focus only on the active page with no covering selector', async () => {
    const handlers = props()
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    expect(composer().props.active).toBe(true)
    expect(composer().props.onFocusRequestHandled).toBe(handlers.onComposerFocusHandled)
    environment.focused = false
    await act(() => renderer.update(<ConversationScreen {...handlers} />))
    expect(composer().props.active).toBe(false)
    environment.focused = true
    await act(() => renderer.update(<ConversationScreen {...handlers} />))
    await act(() => composer().props.onSelectModel())
    expect(composer().props.active).toBe(false)
    await act(() => renderer.root.findByType('QuickDismiss' as never).props.onDismiss())
    expect(composer().props.active).toBe(true)
    await act(() => renderer.root.findByProps({ testID: 'new-chat-device' }).props.onPress())
    expect(composer().props.active).toBe(false)
  })

  it('disables the native back gesture only while the quick model selector is open', async () => {
    const handlers = props()
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    expect(environment.gestureEnabled).toBe(true)

    await act(() => composer().props.onSelectModel())
    expect(environment.gestureEnabled).toBe(false)

    await act(() => renderer.root.findByType('QuickDismiss' as never).props.onDismiss())
    expect(environment.gestureEnabled).toBe(true)
  })

  it('consumes back to close only the quick layer and keeps the composer draft mounted', async () => {
    const handlers = props()
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    expect(environment.backHandlers.size).toBe(0)
    await act(() => composer().props.onChangeText('Keep this draft'))
    await act(() => composer().props.onSelectModel())
    expect(quick()).toHaveLength(1)
    let consumed = false
    await act(() => {
      consumed = [...environment.backHandlers][0]!()
    })
    expect(consumed).toBe(true)
    expect(quick()).toHaveLength(0)
    expect(composer().props.draft).toBe('Keep this draft')
    expect(handlers.onBack).not.toHaveBeenCalled()
    expect(environment.backHandlers.size).toBe(0)
  })

  it('does not intercept back for an unfocused screen or the advanced navigation modal', async () => {
    const handlers = props()
    await act(() => {
      renderer = create(<ConversationScreen {...handlers} />)
    })
    await act(() => composer().props.onSelectModel())
    expect(environment.backHandlers.size).toBe(1)
    environment.focused = false
    await act(() => renderer.update(<ConversationScreen {...handlers} />))
    expect(environment.backHandlers.size).toBe(0)
    environment.focused = true
    await act(() => renderer.update(<ConversationScreen {...handlers} />))
    expect(environment.backHandlers.size).toBe(1)
    await act(() => quick()[0]!.props.onOpenAdvanced())
    expect(handlers.onOpenAdvancedModel).toHaveBeenCalledOnce()
    expect(environment.backHandlers.size).toBe(0)
  })

  it('does not register Android handlers on iOS', async () => {
    environment.platform = 'ios'
    await act(() => {
      renderer = create(<ConversationScreen {...props()} />)
    })
    await act(() => composer().props.onSelectModel())
    expect(quick()).toHaveLength(1)
    expect(environment.backHandlers.size).toBe(0)
  })

  it.each(['ios', 'android'])('reserves the measured composer once on %s', async platform => {
    environment.platform = platform
    await act(() => {
      renderer = create(<ConversationScreen {...props()} isNew={false} />)
    })
    const dock = renderer.root.findByProps({ testID: 'conversation-composer-dock' })
    const list = renderer.root.findByType('MessageList' as never)
    expect(list.props.keyboardOffset).toBe(16)
    expect(dock.props.offset).toEqual({ opened: 16 })
    expect(list.props.contentInsetEndAdjustment).toBe(environment.composerInset)
    await act(() => dock.props.onLayout({ nativeEvent: { layout: { height: 124 } } }))
    expect(list.props.contentInsetEndAdjustment.value).toBe(124)
    await act(() => dock.props.onLayout({ nativeEvent: { layout: { height: 188 } } }))
    expect(list.props.contentInsetEndAdjustment.value).toBe(188)
    expect(list.props.bottomInset).toBeUndefined()
  })

  it('changes the list data key on re-entry without remounting the list or losing the draft', async () => {
    const screenProps = { ...props(), isNew: false }
    await act(() => {
      renderer = create(<ConversationScreen {...screenProps} />)
    })
    const previousList = renderer.root.findByType('MessageList' as never)
    const previousDataKey = previousList.props.dataKey
    await act(() => composer().props.onChangeText('Keep this draft'))
    await act(() => renderer.update(<ConversationScreen {...screenProps} entryRevision={1} />))
    const currentList = renderer.root.findByType('MessageList' as never)
    expect(currentList).toBe(previousList)
    expect(currentList.props.dataKey).not.toBe(previousDataKey)
    expect(composer().props.draft).toBe('Keep this draft')
  })

  it('keeps one list through creating a conversation and loading another conversation', async () => {
    const screenProps = props()
    await act(() => {
      renderer = create(<ConversationScreen {...screenProps} />)
    })
    const list = renderer.root.findByType('MessageList' as never)
    const newConversationDataKey = list.props.dataKey
    expect(list.props.configuration.props.testID).toBe('new-chat-configuration')
    await act(() => composer().props.onChangeText('Keep this draft'))

    const existingProps = {
      ...screenProps,
      isNew: false,
      currentAddress: { deviceId: 'remote-executor', taskId: 'created-task' },
      messages: [
        {
          id: 'user-1',
          role: 'user' as const,
          content: 'Hello',
          status: 'completed' as const,
          createdAt: 1,
        },
      ],
    }
    await act(() => renderer.update(<ConversationScreen {...existingProps} />))
    expect(renderer.root.findByType('MessageList' as never)).toBe(list)
    expect(list.props.dataKey).not.toBe(newConversationDataKey)
    expect(list.props.configuration).toBeUndefined()

    await act(() =>
      renderer.update(
        <ConversationScreen
          {...existingProps}
          currentAddress={{ deviceId: 'remote-executor', taskId: 'other-task' }}
          loading
          messages={[]}
        />
      )
    )
    expect(renderer.root.findByType('MessageList' as never)).toBe(list)
    expect(list.props.loading).toBe(true)
    expect(list.props.messages).toEqual([])
    expect(composer().props.draft).toBe('Keep this draft')
  })

  it('provides every new conversation configuration row as one measured list item', async () => {
    const screenProps = props()
    screenProps.devices = [
      {
        id: 1,
        device_id: 'remote-executor',
        name: 'Remote executor',
        status: 'online',
        device_type: 'remote',
        bind_shell: 'claudecode',
      },
    ]
    screenProps.selectedDeviceId = 'remote-executor'
    screenProps.selectedProjectName = 'Cloud project'
    screenProps.selectedWorkspace = {
      deviceId: 'remote-executor',
      deviceName: 'Remote executor',
      deviceStatus: 'online',
      available: true,
      workspacePath: '/workspace/project',
      tasks: [],
    }
    await act(() => {
      renderer = create(<ConversationScreen {...screenProps} />)
    })
    const list = renderer.root.findByType('MessageList' as never)
    const configuration = list.findByProps({ testID: 'new-chat-configuration' })
    expect(configuration.props.style.position).toBeUndefined()
    expect(configuration.findAllByType('ScrollView' as never)).toHaveLength(0)
    expect(configuration.findAllByType('KeyboardStickyView' as never)).toHaveLength(0)
    for (const testID of [
      'new-chat-device',
      'new-chat-project',
      'new-chat-work-mode',
      'new-chat-branch',
    ]) {
      expect(configuration.findByProps({ testID })).toBeDefined()
    }
    const dock = renderer.root.findByProps({ testID: 'conversation-composer-dock' })
    await act(() => dock.props.onLayout({ nativeEvent: { layout: { height: 240 } } }))
    expect(list.props.contentInsetEndAdjustment.value).toBe(240)
    expect(list.findByProps({ testID: 'new-chat-configuration' })).toBe(configuration)
  })
  it('mounts the native menu in the header and scopes its dialogs to the current conversation', async () => {
    const screenProps = props()
    await act(() => {
      renderer = create(<ConversationScreen {...screenProps} />)
    })
    const header = () => renderer.root.findByType('Header' as never)
    const initialMenu = header().props.menu
    expect(initialMenu.type).toBe('ConversationMenu')
    expect(initialMenu.props.compact).toBe(true)
    expect(initialMenu.props.onSettings).toBe(screenProps.conversationActions.onSettings)
    expect(header().props.menuExpanded).toBeUndefined()
    expect(header().props.onMore).toBeUndefined()
    const address = { deviceId: 'device', taskId: 'task' }
    await act(() =>
      renderer.update(
        <ConversationScreen {...screenProps} currentAddress={address} isNew={false} />
      )
    )
    expect(header().props.menu.props.address).toBe(address)
    expect(header().props.menu.props.compact).toBe(false)
    expect(header().props.menu.key).not.toBe(initialMenu.key)
  })
})
