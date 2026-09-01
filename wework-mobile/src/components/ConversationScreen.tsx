import Ionicons from '@expo/vector-icons/Ionicons'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native'
import { Text, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { reduceModelControlLayer } from '@/domain/modelControlPresentation'
import {
  modelLabel,
  reasoningEfforts,
  reasoningLabel,
  resolvedReasoningEffort,
} from '@/domain/modelSelection'
import { composerBottomSpacing } from '@/domain/conversationLayout'
import {
  conversationSelectorVisible,
  type ConversationSelector,
} from '@/domain/conversationSelector'
import type { NewConversationOptions } from '@/hooks/useMobileRuntime'
import type { RuntimePermissionMode } from '@/services/runtimePermissionPreference'
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
} from '@/types/runtime'
import { ChatComposer, type ComposerSendOptions } from './ChatComposer'
import { ConversationEdgeMask } from './ConversationEdgeMask'
import { ConversationHeader, CONVERSATION_HEADER_HEIGHT } from './ConversationHeader'
import { KeyboardSafeView, useKeyboardVisible } from './KeyboardSafeInput'
import { MessageList } from './MessageList'
import { QuickModelDismissLayer, QuickModelSelector } from './QuickModelSelector'

export interface ConversationWorkspaceChoice {
  projectName: string
  workspace: RuntimeDeviceWorkspace
}

interface ConversationScreenProps {
  currentAddress: RuntimeTaskAddress | null
  currentTitle: string
  devices: DeviceInfo[]
  entryRevision: number
  gitRef: string | null
  isNew: boolean
  loading: boolean
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
  onMore: () => void
  onNewConversation: () => void
  onOpenAdvancedModel: () => void
  onSelectDevice: (deviceId: string) => void
  onSelectModel: (model: UnifiedModel, options?: ModelOptions) => void
  onSelectPermissionMode: (mode: RuntimePermissionMode) => void
  onSelectWorkspace: (workspace: RuntimeDeviceWorkspace | null) => void
  onSend: (message: string, options?: NewConversationOptions) => Promise<boolean>
  onStop: () => Promise<boolean>
  onUploadAttachment: (asset: RuntimeUploadAsset) => Promise<RuntimeAttachment>
}

export function ConversationScreen(props: ConversationScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const keyboardVisible = useKeyboardVisible()
  const [modelControlLayer, dispatchModelControl] = useReducer(reduceModelControlLayer, 'composer')
  const [selector, setSelector] = useState<ConversationSelector>(null)
  const [useWorktree, setUseWorktree] = useState(false)
  const [bottomControlHeight, setBottomControlHeight] = useState(0)
  const [headerHeight, setHeaderHeight] = useState(CONVERSATION_HEADER_HEIGHT)

  const onlineDevices = props.devices.filter(device => device.status !== 'offline')
  const configurationDevice =
    onlineDevices.find(device => device.device_id === props.selectedDeviceId) ??
    onlineDevices[0] ??
    null
  const availableWorkspaces = props.workspaces.filter(
    item => item.workspace.available && item.workspace.deviceId === configurationDevice?.device_id
  )
  const selectedDeviceName =
    props.devices.find(
      device => device.device_id === (props.currentAddress?.deviceId ?? props.selectedDeviceId)
    )?.name ?? null
  const conversationProjectName =
    props.selectedProjectName ?? props.selectedWorkspace?.label ?? null
  const branch = cleanBranch(props.gitRef)
  const selectedEffort = resolvedReasoningEffort(props.model, props.modelOptions.reasoning)
  const efforts = props.model ? reasoningEfforts(props.model) : []
  const selectedModelLabel = props.model
    ? [modelLabel(props.model), reasoningLabel(selectedEffort)].filter(Boolean).join(' ')
    : '选择模型'
  const quickModelVisible = modelControlLayer === 'quick'
  const composerBottom = composerBottomSpacing(insets.bottom, keyboardVisible)
  const headerTop = insets.top + 8
  const messageBottomInset = bottomControlHeight + 20
  const messageTopInset = headerTop + headerHeight + 16
  const topMaskHeight = messageTopInset + 24
  const bottomMaskHeight = bottomControlHeight + 24
  const conversationKey = props.currentAddress
    ? `${props.currentAddress.deviceId}:${props.currentAddress.taskId}`
    : `new:${props.selectedWorkspace?.deviceId ?? props.selectedDeviceId ?? ''}:${props.selectedWorkspace?.workspacePath ?? ''}`

  const choices = useMemo(
    () =>
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
                ...(branch
                  ? [
                      {
                        id: 'worktree',
                        label: '创建 Git 工作树',
                        selected: useWorktree,
                        onPress: () => setUseWorktree(true),
                      },
                    ]
                  : []),
              ]
            : selector === 'permission'
              ? permissionChoices(props.permissionMode, props.onSelectPermissionMode)
              : [],
    [
      availableWorkspaces,
      branch,
      configurationDevice?.device_id,
      onlineDevices,
      props,
      selector,
      useWorktree,
    ]
  )

  const closeModelControls = useCallback(() => {
    dispatchModelControl('close')
  }, [])
  const openQuickModel = useCallback(() => {
    Keyboard.dismiss()
    dispatchModelControl('openQuick')
  }, [])
  const openAdvancedModel = useCallback(() => {
    closeModelControls()
    props.onOpenAdvancedModel()
  }, [closeModelControls, props.onOpenAdvancedModel])
  const handleBottomControlLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height
    setBottomControlHeight(current => (current === height ? current : height))
  }, [])
  const handleHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height
    setHeaderHeight(current => (current === height ? current : height))
  }, [])

  useEffect(() => {
    closeModelControls()
  }, [closeModelControls, conversationKey])

  useEffect(() => {
    if (!props.isNew) setSelector(null)
  }, [props.isNew])

  const selectModelOptions = (options: ModelOptions) => {
    if (props.model) props.onSelectModel(props.model, options)
  }
  const sendMessage = (message: string, composerOptions: ComposerSendOptions) =>
    props.onSend(
      message,
      props.isNew
        ? {
            ...composerOptions,
            ...(useWorktree && branch ? { worktreeBranch: branch } : {}),
          }
        : composerOptions
    )

  return (
    <KeyboardSafeView style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      {props.isNew ? (
        <View style={styles.emptyContent} />
      ) : (
        <MessageList
          bottomInset={messageBottomInset}
          conversationId={conversationKey}
          entryRevision={props.entryRevision}
          loading={props.loading}
          messages={props.messages}
          topInset={messageTopInset}
        />
      )}

      {props.isNew ? null : (
        <>
          <ConversationEdgeMask edge="top" height={topMaskHeight} />
          <ConversationEdgeMask edge="bottom" height={bottomMaskHeight} />
        </>
      )}
      {props.isNew ? (
        <View style={[styles.configuration, { bottom: bottomControlHeight + 10 }]}>
          <ConfigurationRow
            icon="laptop-outline"
            label={configurationDevice?.name ?? '暂无在线 Executor'}
            onPress={() => setSelector('device')}
            testID="new-chat-device"
          />
          <ConfigurationRow
            disabled={!configurationDevice}
            icon={props.selectedWorkspace ? 'folder-outline' : 'chatbubbles-outline'}
            label={props.selectedProjectName ?? '聊天'}
            onPress={() => setSelector('project')}
            testID="new-chat-project"
          />
          {props.selectedWorkspace ? (
            <>
              <ConfigurationRow
                icon="laptop-outline"
                label={useWorktree ? '创建 Git 工作树' : '在本地工作'}
                onPress={() => setSelector('workMode')}
                testID="new-chat-work-mode"
              />
              {branch ? (
                <ConfigurationRow
                  disabled={!useWorktree}
                  icon="git-branch-outline"
                  label={branch}
                  onPress={() => setSelector('workMode')}
                  testID="new-chat-branch"
                />
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}

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
        onMore={props.onMore}
        onNewConversation={props.onNewConversation}
        projectName={conversationProjectName}
        style={[styles.headerOverlay, { top: headerTop }]}
        title={props.currentTitle}
      />

      <View
        collapsable={false}
        onLayout={handleBottomControlLayout}
        pointerEvents="box-none"
        style={styles.bottomControlDock}
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
          <ChatComposer
            contextLabel={props.isNew ? configurationDevice?.name : selectedDeviceName}
            disabled={props.sending}
            emptyContextPlaceholder={props.isNew ? '选择在线 Executor' : undefined}
            modelLabel={selectedModelLabel}
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
                onPress={() => setSelector('permission')}
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
            sendDisabled={props.isNew && (!configurationDevice || !props.model)}
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
            bottomInset={composerBottom}
            effort={selectedEffort}
            efforts={efforts}
            label={selectedModelLabel}
            onOpenAdvanced={openAdvancedModel}
            onSelectEffort={reasoning => selectModelOptions({ ...props.modelOptions, reasoning })}
          />
        ) : null}
      </View>

      <ChoiceSheet
        choices={choices}
        onDismiss={() => setSelector(null)}
        testIDPrefix={props.isNew ? 'new-chat-choice' : 'conversation-choice'}
        title={selectorTitle(selector)}
        visible={conversationSelectorVisible(selector, props.isNew)}
      />
    </KeyboardSafeView>
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

interface Choice {
  id: string
  label: string
  detail?: string
  icon?: keyof typeof Ionicons.glyphMap
  separatorAfter?: boolean
  selected: boolean
  onPress: () => void
}

function ChoiceSheet({
  choices,
  onDismiss,
  testIDPrefix,
  title,
  visible,
}: {
  choices: Choice[]
  onDismiss: () => void
  testIDPrefix: string
  title: string
  visible: boolean
}) {
  const theme = useTheme()
  const [presented, setPresented] = useState(visible)
  const [reduceMotion, setReduceMotion] = useState(false)
  const progress = useRef(new Animated.Value(visible ? 1 : 0)).current
  const closing = useRef(false)

  useEffect(() => {
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion)
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    if (!visible) {
      setPresented(false)
      closing.current = false
      return
    }

    setPresented(true)
    progress.stopAnimation()
    progress.setValue(reduceMotion ? 1 : 0)
    if (reduceMotion) return

    Animated.timing(progress, {
      duration: 240,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: true,
    }).start()
  }, [progress, reduceMotion, visible])

  const dismiss = useCallback(() => {
    if (closing.current) return
    closing.current = true
    progress.stopAnimation()

    if (reduceMotion) {
      onDismiss()
      return
    }

    Animated.timing(progress, {
      duration: 180,
      easing: Easing.in(Easing.cubic),
      toValue: 0,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onDismiss()
      else closing.current = false
    })
  }, [onDismiss, progress, reduceMotion])

  const backdropOpacity = progress
  const sheetTranslateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [52, 0],
  })

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={dismiss}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={presented}
    >
      <View style={styles.sheetLayer}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.sheetBackdrop,
            {
              backgroundColor: theme.dark ? 'rgba(0,0,0,0.38)' : 'rgba(0,0,0,0.18)',
              opacity: backdropOpacity,
            },
          ]}
        />
        <Pressable
          accessibilityLabel={`关闭${title}选择`}
          accessibilityRole="button"
          onPress={dismiss}
          style={styles.sheetDismissLayer}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.surface,
              transform: [{ translateY: reduceMotion ? 0 : sheetTranslateY }],
            },
          ]}
        >
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle} variant="titleLarge">
            {title}
          </Text>
          <ScrollView
            contentContainerStyle={styles.sheetContent}
            showsVerticalScrollIndicator={false}
          >
            {choices.map(choice => (
              <View key={choice.id}>
                <Pressable
                  onPress={() => {
                    choice.onPress()
                    dismiss()
                  }}
                  style={({ pressed }) => [
                    styles.choice,
                    choice.selected && { backgroundColor: theme.colors.surfaceVariant },
                    pressed && styles.pressed,
                  ]}
                  testID={`${testIDPrefix}-${choice.id}`}
                >
                  {choice.icon ? (
                    <Ionicons
                      color={theme.colors.onSurfaceVariant}
                      name={choice.icon}
                      size={23}
                      style={styles.choiceIcon}
                    />
                  ) : null}
                  <View style={styles.choiceText}>
                    <Text variant="bodyLarge">{choice.label}</Text>
                    {choice.detail ? (
                      <Text numberOfLines={1} style={styles.choiceDetail} variant="bodySmall">
                        {choice.detail}
                      </Text>
                    ) : null}
                  </View>
                  {choice.selected ? (
                    <Ionicons color={theme.colors.onSurface} name="checkmark" size={22} />
                  ) : null}
                </Pressable>
                {choice.separatorAfter ? (
                  <View
                    style={[
                      styles.choiceSeparator,
                      { backgroundColor: theme.colors.outlineVariant },
                    ]}
                  />
                ) : null}
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  )
}

function permissionChoices(
  selected: RuntimePermissionMode,
  onSelect: (value: RuntimePermissionMode) => void
): Choice[] {
  return [
    {
      id: 'read-only',
      label: '只读',
      selected: selected === 'read-only',
      onPress: () => onSelect('read-only'),
    },
    {
      id: 'workspace-write',
      label: '工作区',
      selected: selected === 'workspace-write',
      onPress: () => onSelect('workspace-write'),
    },
    {
      id: 'full-access',
      label: '完整访问',
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
  emptyContent: { flex: 1 },
  headerOverlay: { position: 'absolute', left: 0, right: 0 },
  bottomControlDock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  composerLayer: { width: '100%' },
  collapsedComposer: { display: 'none' },
  configuration: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    gap: 2,
  },
  configRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4 },
  configLabel: { marginLeft: 16, maxWidth: '77%', fontWeight: '400' },
  chevrons: { marginLeft: 6, width: 18, height: 26, justifyContent: 'center' },
  permissionAction: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.55 },
  disabled: { opacity: 0.34 },
  sheetLayer: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { position: 'absolute', inset: 0 },
  sheetDismissLayer: { position: 'absolute', inset: 0 },
  sheet: {
    maxHeight: '66%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: Platform.OS === 'ios' ? 32 : 16,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 3,
    marginTop: 8,
    backgroundColor: '#858585',
  },
  sheetTitle: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 12 },
  sheetContent: { paddingHorizontal: 12, paddingBottom: 12 },
  choice: {
    minHeight: 60,
    borderRadius: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
  },
  choiceText: { flex: 1, gap: 3 },
  choiceIcon: { marginRight: 14 },
  choiceDetail: { opacity: 0.48 },
  choiceSeparator: { height: StyleSheet.hairlineWidth, marginHorizontal: 14, marginVertical: 8 },
})
