import Ionicons from '@expo/vector-icons/Ionicons'
import { useKeyboardChatComposerInset } from '@legendapp/list/keyboard'
import type { LegendListRef } from '@legendapp/list/react-native'
import { useFocusEffect, useIsFocused, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { KeyboardGestureArea, KeyboardStickyView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { reduceModelControlLayer } from '@/domain/modelControlPresentation'
import { mobileCreatableDevices, selectedOnlineDeviceId } from '@/domain/deviceOrdering'
import {
  modelLabel,
  modelSupportsSpeed,
  reasoningEfforts,
  reasoningLabel,
  resolvedReasoningEffort,
} from '@/domain/modelSelection'
import {
  conversationSelectorVisible,
  type ConversationSelector,
} from '@/domain/conversationSelector'
import type { NewConversationOptions } from '@/hooks/useMobileRuntime'
import type { RuntimePermissionMode } from '@/services/runtimePermissionPreference'
import type { RuntimeApi } from '@/services/runtimeApi'
import type {
  ChatMessage,
  DeviceInfo,
  ModelOptions,
  RuntimeAttachment,
  RuntimeComposerApp,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeUploadAsset,
  UnifiedModel,
  RequestUserInputPayload,
  RequestUserInputResponse,
} from '@/types/runtime'
import { ChatComposer, type ComposerSendOptions } from './ChatComposer'
import { ChoiceSheet, type Choice } from './ChoiceSheet'
import { WorktreeBranchSheet } from './WorktreeBranchSheet'
import { ErrorNotice } from './errors/ErrorNotice'
import { useWorkspaceWorktree } from '@/hooks/useWorkspaceWorktree'
import { worktreeWorkspaceDeviceId } from '../../../packages/chat-core/src/worktree-availability'
import pcMessages from '../../../wework/src/i18n/locales/zh-CN/common.json'
import { ConversationEdgeMask } from './ConversationEdgeMask'
import { ConversationChangesPill } from './ConversationChangesPill'
import { ConversationAgentsPill } from './ConversationAgentsPill'
import { ConversationHeader, CONVERSATION_HEADER_HEIGHT } from './ConversationHeader'
import { ConversationMenu, type ConversationMenuActions } from './ConversationMenu'
import { MessageList } from './MessageList'
import { QuickModelDismissLayer, QuickModelSelector } from './QuickModelSelector'
import { groupModelsByFamily } from '../../../packages/collaboration/src/controls/model-ui'

export interface ConversationWorkspaceChoice {
  projectName: string
  workspace: RuntimeDeviceWorkspace
}

interface ConversationScreenProps {
  api: Pick<
    RuntimeApi,
    | 'getSubagentTranscript'
    | 'getWorktreeCapabilities'
    | 'preflightWorkspace'
    | 'listWorkspaceGitBranches'
  >
  composerFocusRequest?: number
  onComposerFocusHandled: (request: number) => void
  currentAddress: RuntimeTaskAddress | null
  currentTitle: string
  devices: DeviceInfo[]
  entryRevision: number
  hasMoreMessagesBefore: boolean
  historyLoaded: boolean
  isNew: boolean
  loading: boolean
  loadingMoreMessagesBefore: boolean
  messages: ChatMessage[]
  model: UnifiedModel | null
  modelOptions: ModelOptions
  permissionMode: RuntimePermissionMode
  selectedDeviceId: string | null
  selectedProjectName: string | null
  selectedWorkspace: RuntimeDeviceWorkspace | null
  running: boolean
  sending: boolean
  stopping: boolean
  workspaces: ConversationWorkspaceChoice[]
  onBack: () => void
  onLoadApps: () => Promise<RuntimeComposerApp[]>
  onLoadMoreMessagesBefore: () => Promise<void>
  conversationActions: ConversationMenuActions
  onNewConversation: () => void
  onOpenAdvancedModel: () => void
  onSelectDevice: (deviceId: string) => void
  onSelectModel: (model: UnifiedModel, options?: ModelOptions) => void
  onSelectPermissionMode: (mode: RuntimePermissionMode) => void
  onSelectWorkspace: (workspace: RuntimeDeviceWorkspace | null) => void
  onSend: (message: string, options?: NewConversationOptions) => Promise<boolean>
  onStop: () => Promise<boolean>
  onRequestUserInputSubmit?: (response: RequestUserInputResponse) => Promise<boolean>
  onRequestUserInputSkip?: (payload: RequestUserInputPayload) => Promise<boolean>
  onUploadAttachment: (asset: RuntimeUploadAsset) => Promise<RuntimeAttachment>
}

export function ConversationScreen(props: ConversationScreenProps) {
  const isFocused = useIsFocused()
  const navigation = useNavigation<NativeStackNavigationProp<{ conversation: undefined }>>()
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const listRef = useRef<LegendListRef>(null)
  const composerRef = useRef<View>(null)
  const { contentInsetEndAdjustment, onComposerLayout } = useKeyboardChatComposerInset(
    listRef,
    composerRef
  )
  const [modelControlLayer, dispatchModelControl] = useReducer(reduceModelControlLayer, 'composer')
  const [selector, setSelector] = useState<ConversationSelector>(null)
  const [worktreeDraft, setWorktreeDraft] = useState<{
    key: string
    enabled: boolean
    branch: string | null
  } | null>(null)
  const draftKey = JSON.stringify([
    props.entryRevision,
    props.selectedDeviceId,
    props.selectedWorkspace?.projectId,
    props.selectedWorkspace?.deviceId,
    props.selectedWorkspace?.workspacePath,
    props.selectedWorkspace?.remoteHostId,
  ])
  const useWorktree = worktreeDraft?.key === draftKey && worktreeDraft.enabled
  const selectedBranch = worktreeDraft?.key === draftKey ? worktreeDraft.branch : null
  const setUseWorktree = (enabled: boolean) =>
    setWorktreeDraft({ key: draftKey, enabled, branch: selectedBranch })
  const worktree = useWorkspaceWorktree(
    props.api,
    props.isNew && isFocused,
    props.selectedWorkspace,
    props.devices,
    useWorktree ? selectedBranch : null
  )
  const worktreeReason = worktree.availability.reason
  const worktreeDetail =
    worktreeReason === 'available'
      ? undefined
      : pcMessages.workbench[`worktree_unavailable_${worktreeReason}`]
  const branchDeviceId = worktreeWorkspaceDeviceId(props.selectedWorkspace)
  const branchPath = props.selectedWorkspace?.workspacePath
  const loadBranches = useCallback(() => {
    if (!branchDeviceId || !branchPath) throw new Error('请先选择代码工作区')
    return props.api.listWorkspaceGitBranches(branchDeviceId, branchPath)
  }, [props.api, branchDeviceId, branchPath])
  const [bottomControlHeight, setBottomControlHeight] = useState(0)
  const [headerHeight, setHeaderHeight] = useState(CONVERSATION_HEADER_HEIGHT)

  const onlineDevices = mobileCreatableDevices(props.devices)
  const configurationDevice =
    onlineDevices.find(
      device =>
        device.device_id ===
        (worktreeWorkspaceDeviceId(props.selectedWorkspace) ??
          selectedOnlineDeviceId(onlineDevices, props.selectedDeviceId))
    ) ?? null
  const availableWorkspaces = props.workspaces.filter(
    item =>
      item.workspace.available &&
      worktreeWorkspaceDeviceId(item.workspace) === configurationDevice?.device_id
  )
  const selectedDeviceName =
    props.devices.find(
      device =>
        device.device_id === (props.currentAddress?.deviceId ?? configurationDevice?.device_id)
    )?.name ?? null
  const conversationProjectName =
    props.selectedProjectName ?? props.selectedWorkspace?.label ?? null
  const branch = cleanBranch(worktree.currentBranch)
  const selectedEffort = resolvedReasoningEffort(props.model, props.modelOptions.reasoning)
  const efforts = props.model ? reasoningEfforts(props.model) : []
  const selectedModelLabel = props.model
    ? [modelLabel(props.model), reasoningLabel(selectedEffort)].filter(Boolean).join(' ')
    : '选择模型'
  const quickModelVisible = modelControlLayer === 'quick'
  const composerBottom = 8
  const headerTop = Math.max(insets.top, 8)
  const messageTopInset = headerTop + headerHeight + 16
  const topMaskHeight = messageTopInset + 24
  const bottomMaskHeight = bottomControlHeight + 24
  const conversationKey = props.currentAddress
    ? `${props.currentAddress.deviceId}:${props.currentAddress.taskId}`
    : `new:${props.selectedWorkspace?.deviceId ?? props.selectedDeviceId ?? ''}:${props.selectedWorkspace?.workspacePath ?? ''}`

  const choices: Choice[] =
    selector === 'device'
      ? onlineDevices.map(device => ({
          id: device.device_id,
          label: device.name,
          selected: device.device_id === configurationDevice?.device_id,
          onPress: () => {
            props.onSelectDevice(device.device_id)
            props.onSelectWorkspace(null)
          },
        }))
      : selector === 'project'
        ? [
            {
              id: 'standalone-chat',
              label: '聊天',
              icon: 'chatbubbles-outline' as const,
              separatorAfter: true,
              selected: !props.selectedWorkspace,
              onPress: () => props.onSelectWorkspace(null),
            },
            ...availableWorkspaces.map(item => ({
              id: `${item.workspace.deviceId}:${item.workspace.workspacePath}`,
              label: item.projectName,
              detail: item.workspace.workspacePath,
              icon: 'folder-outline' as const,
              selected:
                item.workspace.workspacePath === props.selectedWorkspace?.workspacePath &&
                item.workspace.deviceId === props.selectedWorkspace.deviceId,
              onPress: () => props.onSelectWorkspace(item.workspace),
            })),
          ]
        : selector === 'workMode'
          ? [
              {
                id: 'local',
                label: '在本地工作',
                selected: !useWorktree,
                onPress: () => setUseWorktree(false),
              },
              {
                id: 'worktree',
                label: '新建工作树',
                icon: 'git-branch-outline' as const,
                detail: worktreeDetail,
                disabled: !worktree.availability.available,
                selected: useWorktree,
                onPress: () => setUseWorktree(true),
              },
              ...(worktreeReason === 'preflight_failed'
                ? [
                    {
                      id: 'retry-worktree',
                      label: '重新检查工作树',
                      selected: false,
                      onPress: worktree.retry,
                    },
                  ]
                : []),
            ]
          : selector === 'permission'
            ? permissionChoices(
                props.permissionMode,
                props.onSelectPermissionMode,
                configurationDevice?.device_type === 'local'
              )
            : []

  const closeModelControls = useCallback(() => {
    dispatchModelControl('close')
  }, [])
  const openQuickModel = useCallback(() => {
    dispatchModelControl('openQuick')
  }, [])
  const openAdvancedModel = useCallback(() => {
    closeModelControls()
    props.onOpenAdvancedModel()
  }, [closeModelControls, props.onOpenAdvancedModel])
  const openSelector = (next: ConversationSelector) => {
    Keyboard.dismiss()
    setSelector(next)
  }
  const handleBottomControlLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onComposerLayout(event)
      const height = event.nativeEvent.layout.height
      setBottomControlHeight(current => (current === height ? current : height))
    },
    [onComposerLayout]
  )
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height
    setHeaderHeight(current => (current === height ? current : height))
  }, [])

  useEffect(() => {
    closeModelControls()
  }, [closeModelControls, conversationKey])

  useFocusEffect(
    useCallback(() => {
      navigation.setOptions({ gestureEnabled: !quickModelVisible })
    }, [navigation, quickModelVisible])
  )

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android' || !quickModelVisible) return
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        closeModelControls()
        return true
      })
      return () => subscription.remove()
    }, [closeModelControls, quickModelVisible])
  )

  useEffect(() => {
    if (!props.isNew) setSelector(null)
  }, [props.isNew])

  const selectModelOptions = (options: ModelOptions) => {
    if (props.model) props.onSelectModel(props.model, options)
  }
  const sendMessage = (message: string, composerOptions: ComposerSendOptions) => {
    if (props.isNew && useWorktree && !worktree.availability.available)
      return Promise.resolve(false)
    return props.onSend(
      message,
      props.isNew
        ? {
            ...composerOptions,
            executionMode: useWorktree ? 'git_worktree' : 'current_workspace',
            ...(useWorktree && selectedBranch ? { worktreeBranch: selectedBranch } : {}),
          }
        : composerOptions
    )
  }

  return (
    <View
      style={[
        styles.screen,
        { backgroundColor: theme.colors.background, paddingBottom: insets.bottom },
      ]}
    >
      <KeyboardGestureArea
        interpolator="ios"
        offset={bottomControlHeight}
        style={styles.screen}
        textInputNativeID="chat-input"
      >
        <MessageList
          dataKey={`${conversationKey}:${props.entryRevision}`}
          contentInsetEndAdjustment={contentInsetEndAdjustment}
          keyboardOffset={insets.bottom}
          listRef={listRef}
          hasMoreBefore={props.hasMoreMessagesBefore}
          loading={props.loading}
          historyLoaded={props.historyLoaded}
          loadingMoreBefore={props.loadingMoreMessagesBefore}
          messages={props.messages}
          onRequestUserInputSubmit={props.onRequestUserInputSubmit}
          onRequestUserInputSkip={props.onRequestUserInputSkip}
          running={props.sending || props.running}
          configuration={
            props.isNew ? (
              <View style={styles.configuration} testID="new-chat-configuration">
                <ConfigurationRow
                  icon="laptop-outline"
                  label={configurationDevice?.name ?? '暂无在线 Executor'}
                  onPress={() => openSelector('device')}
                  testID="new-chat-device"
                />
                <ConfigurationRow
                  disabled={!configurationDevice}
                  icon={props.selectedWorkspace ? 'folder-outline' : 'chatbubbles-outline'}
                  label={props.selectedProjectName ?? '选择项目'}
                  onPress={() => openSelector('project')}
                  testID="new-chat-project"
                />
                {props.selectedWorkspace ? (
                  <>
                    <ConfigurationRow
                      icon={useWorktree ? 'git-branch-outline' : 'laptop-outline'}
                      label={useWorktree ? '新建工作树' : '在本地工作'}
                      onPress={() => openSelector('workMode')}
                      testID="new-chat-work-mode"
                    />
                    {branch || useWorktree ? (
                      <ConfigurationRow
                        disabled={!useWorktree || !configurationDevice}
                        icon="git-branch-outline"
                        label={selectedBranch ?? branch ?? '选择分支'}
                        onPress={() => openSelector('branch')}
                        testID="new-chat-branch"
                      />
                    ) : null}
                    {useWorktree && worktree.error ? (
                      <ErrorNotice
                        error={worktree.error}
                        title="无法检查工作树"
                        onRetry={worktree.retry}
                        testID="new-chat-worktree-error"
                      />
                    ) : null}
                  </>
                ) : null}
              </View>
            ) : undefined
          }
          onLoadMoreBefore={props.onLoadMoreMessagesBefore}
          topInset={messageTopInset}
        />
      </KeyboardGestureArea>

      {props.isNew ? null : (
        <>
          <ConversationEdgeMask edge="top" height={topMaskHeight} />
          <KeyboardStickyView
            pointerEvents="none"
            offset={{ opened: insets.bottom }}
            style={[styles.bottomControlDock, { bottom: insets.bottom }]}
          >
            <ConversationEdgeMask edge="bottom" height={bottomMaskHeight} />
          </KeyboardStickyView>
        </>
      )}
      {quickModelVisible ? <QuickModelDismissLayer onDismiss={closeModelControls} /> : null}

      <ConversationHeader
        backAccessibilityLabel={quickModelVisible ? '关闭模型设置' : '返回会话列表'}
        deviceName={selectedDeviceName}
        minimal={props.isNew}
        onBack={() => {
          if (quickModelVisible) closeModelControls()
          else props.onBack()
        }}
        onLayout={handleHeaderLayout}
        menu={
          <ConversationMenu
            {...props.conversationActions}
            key={conversationKey}
            address={props.currentAddress}
            title={props.currentTitle}
            compact={props.isNew}
          />
        }
        onNewConversation={props.onNewConversation}
        canCreateConversation={onlineDevices.length > 0}
        projectName={conversationProjectName}
        style={[styles.headerOverlay, { top: headerTop }]}
        title={props.currentTitle}
      />

      <KeyboardStickyView
        collapsable={false}
        onLayout={handleBottomControlLayout}
        pointerEvents="box-none"
        ref={composerRef}
        offset={{ opened: insets.bottom }}
        style={[styles.bottomControlDock, { bottom: insets.bottom }]}
        testID="conversation-composer-dock"
      >
        <View
          accessibilityElementsHidden={quickModelVisible}
          importantForAccessibility={quickModelVisible ? 'no-hide-descendants' : 'auto'}
          pointerEvents={quickModelVisible ? 'none' : 'auto'}
          style={[
            styles.composerLayer,
            { paddingBottom: composerBottom },
            quickModelVisible && styles.collapsedComposer,
          ]}
        >
          {!props.isNew ? (
            <View style={styles.contextPills} testID="conversation-context-pills">
              <ConversationChangesPill
                revision={`${conversationKey}:${props.entryRevision}:${props.running}:${props.messages.at(-1)?.completedAt ?? ''}`}
              />
              <ConversationAgentsPill
                messages={props.messages}
                address={props.currentAddress}
                api={props.api}
              />
            </View>
          ) : null}
          <ChatComposer
            active={isFocused && !quickModelVisible && selector === null}
            focusRequest={props.composerFocusRequest}
            onFocusRequestHandled={props.onComposerFocusHandled}
            disabled={props.sending}
            emptyContextPlaceholder={props.isNew ? '向 Wework 提问' : '跟进'}
            modelLabel={selectedModelLabel}
            reasoningEffort={selectedEffort}
            reasoningEfforts={efforts}
            onClearPlanMode={() =>
              selectModelOptions({ ...props.modelOptions, collaborationMode: 'default' })
            }
            onLoadApps={props.onLoadApps}
            onSelectModel={openQuickModel}
            onSend={sendMessage}
            onStop={props.onStop}
            onSetPlanMode={() =>
              selectModelOptions({ ...props.modelOptions, collaborationMode: 'plan' })
            }
            onUploadAttachment={props.onUploadAttachment}
            planModeActive={props.modelOptions.collaborationMode === 'plan'}
            running={props.running}
            secondaryLeadingAction={
              <Pressable
                accessibilityLabel={`权限模式：${permissionModeLabel(props.permissionMode)}`}
                accessibilityRole="button"
                hitSlop={{ left: 6, right: 6 }}
                onPress={() => openSelector('permission')}
                style={({ pressed }) => [styles.permissionAction, pressed && styles.pressed]}
                testID={props.isNew ? 'new-chat-permission' : 'conversation-permission'}
              >
                <Ionicons
                  color="#ff8a5b"
                  name={permissionModeIcon(props.permissionMode)}
                  size={21}
                />
              </Pressable>
            }
            sendDisabled={
              props.isNew &&
              (!configurationDevice ||
                !props.model ||
                (useWorktree && !worktree.availability.available))
            }
            testIDs={
              props.isNew
                ? {
                    attachment: 'new-chat-attachment',
                    input: 'new-chat-input',
                    model: 'new-chat-model',
                    send: 'new-chat-send',
                    stop: 'new-chat-stop',
                  }
                : undefined
            }
            stopping={props.stopping}
          />
        </View>

        {quickModelVisible ? (
          <QuickModelSelector
            effort={selectedEffort}
            efforts={efforts}
            label={props.model ? modelLabel(props.model) : '选择模型'}
            sourceLabel={
              props.model?.provider === 'local'
                ? (groupModelsByFamily([props.model])[0]?.config.label ?? '设备模型')
                : '云端模型'
            }
            onOpenAdvanced={openAdvancedModel}
            onSelectEffort={reasoning => selectModelOptions({ ...props.modelOptions, reasoning })}
          />
        ) : null}
      </KeyboardStickyView>

      <WorktreeBranchSheet
        key={draftKey}
        currentBranch={branch}
        selectedBranch={selectedBranch}
        onListBranches={loadBranches}
        onDismiss={() => setSelector(null)}
        onSelectBranch={value => setWorktreeDraft({ key: draftKey, enabled: true, branch: value })}
        visible={props.isNew && useWorktree && selector === 'branch'}
      />
      <ChoiceSheet
        choices={choices}
        onDismiss={() => setSelector(null)}
        testIDPrefix={props.isNew ? 'new-chat-choice' : 'conversation-choice'}
        title={selectorTitle(selector)}
        visible={conversationSelectorVisible(selector, props.isNew)}
      >
        {selector === 'workMode' && worktree.error ? (
          <ErrorNotice
            error={worktree.error}
            title="无法检查工作树"
            onRetry={worktree.retry}
            testID="work-mode-worktree-error"
          />
        ) : null}
      </ChoiceSheet>
    </View>
  )
}

function ConfigurationRow({
  disabled,
  icon,
  label,
  onPress,
  testID,
}: {
  disabled?: boolean
  icon: keyof typeof Ionicons.glyphMap
  label: string
  onPress: () => void
  testID: string
}) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.configRow,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Ionicons color={theme.colors.onSurfaceVariant} name={icon} size={23} />
      <Text
        numberOfLines={1}
        style={[styles.configLabel, { color: theme.colors.onSurfaceVariant }]}
        variant="titleMedium"
      >
        {label}
      </Text>
      <View style={styles.chevrons}>
        <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-up" size={15} />
        <Ionicons color={theme.colors.onSurfaceVariant} name="chevron-down" size={15} />
      </View>
    </Pressable>
  )
}

function permissionChoices(
  selected: RuntimePermissionMode,
  onSelect: (value: RuntimePermissionMode) => void,
  phoneLocal = false
): Choice[] {
  return [
    {
      id: 'read-only',
      label: '只读',
      disabled: phoneLocal,
      detail: phoneLocal ? '本机执行环境不支持' : undefined,
      selected: selected === 'read-only',
      onPress: () => onSelect('read-only'),
    },
    {
      id: 'workspace-write',
      label: '工作区',
      disabled: phoneLocal,
      detail: phoneLocal ? '本机执行环境不支持' : undefined,
      selected: selected === 'workspace-write',
      onPress: () => onSelect('workspace-write'),
    },
    {
      id: 'full-access',
      label: '完整访问',
      detail: phoneLocal ? '限 App 沙盒内的文件和运行环境' : undefined,
      selected: selected === 'full-access',
      onPress: () => onSelect('full-access'),
    },
  ]
}

function permissionModeLabel(mode: RuntimePermissionMode): string {
  if (mode === 'read-only') return '只读'
  if (mode === 'workspace-write') return '工作区'
  return '完整访问'
}

function permissionModeIcon(mode: RuntimePermissionMode) {
  if (mode === 'read-only') return 'eye-outline' as const
  if (mode === 'workspace-write') return 'folder-outline' as const
  return 'warning-outline' as const
}

function cleanBranch(value: string | null): string | null {
  if (!value) return null
  return value.replace(/^refs\/heads\//, '')
}

function selectorTitle(selector: ConversationSelector): string {
  if (selector === 'device') return 'Executor'
  if (selector === 'project') return '项目'
  if (selector === 'workMode') return '工作方式'
  if (selector === 'permission') return '权限模式'
  return ''
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  headerOverlay: { position: 'absolute', left: 0, right: 0 },
  bottomControlDock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  composerLayer: { width: '100%' },
  contextPills: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingBottom: 8 },
  collapsedComposer: { position: 'absolute', left: 0, right: 0, opacity: 0 },
  configuration: {
    paddingHorizontal: 24,
    gap: 2,
  },
  configRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  configLabel: { marginLeft: 16, maxWidth: '77%', fontWeight: '400' },
  chevrons: { marginLeft: 6, width: 18, height: 26, justifyContent: 'center' },
  permissionAction: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.55 },
  disabled: { opacity: 0.34 },
})
