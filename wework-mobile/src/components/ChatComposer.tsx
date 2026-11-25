import { showErrorAlert } from '@/services/errorAlerts'
import Ionicons from '@expo/vector-icons/Ionicons'
import * as DocumentPicker from 'expo-document-picker'
import type { GlassColorScheme } from 'expo-glass-effect'
import * as ImagePicker from 'expo-image-picker'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'

import { composerLogoUrl, composerMessage } from '@/domain/composerApps'
import { chatComposerPresentation } from '@/domain/chatComposerPresentation'
import { useComposerVoiceInput } from '@/hooks/useComposerVoiceInput'
import type {
  Attachment,
  RuntimeAttachment,
  RuntimeComposerApp,
  RuntimeUploadAsset,
} from '@/types/runtime'
import { ComposerContextMenu, type ComposerMenuAnchor } from './ComposerContextMenu'
import { LiquidGlassGroup, LiquidGlassSurface } from './LiquidGlass'
import { ModelDialIcon } from './ModelDialIcon'
import { VoiceGlyph, VoiceInputBar } from './VoiceInputBar'
import { useMobileFilePreview } from './files/FilePreviewContext'

export interface ComposerSendOptions {
  attachmentIds: number[]
  attachments: Attachment[]
  pursueGoal: boolean
}

interface ChatComposerProps {
  active: boolean
  focusRequest?: number
  onFocusRequestHandled: (request: number) => void
  disabled: boolean
  emptyContextPlaceholder?: string
  modelLabel: string
  reasoningEffort?: string
  reasoningEfforts?: string[]
  onLoadApps: () => Promise<RuntimeComposerApp[]>
  onClearPlanMode: () => void
  onSelectModel: () => void
  onSend: (message: string, options: ComposerSendOptions) => Promise<boolean>
  onStop: () => Promise<boolean>
  onSetPlanMode: () => void
  onUploadAttachment: (asset: RuntimeUploadAsset) => Promise<RuntimeAttachment>
  planModeActive: boolean
  running: boolean
  secondaryLeadingAction?: ReactNode
  sendDisabled?: boolean
  stopping: boolean
  testIDs?: Partial<ChatComposerTestIDs>
}

interface ChatComposerTestIDs {
  attachment: string
  input: string
  model: string
  send: string
  stop: string
}

interface ComposerAttachment extends Attachment {
  previewUri?: string
}

const defaultTestIDs: ChatComposerTestIDs = {
  attachment: 'composer-attachment',
  input: 'chat-input',
  model: 'composer-model',
  send: 'chat-send',
  stop: 'chat-stop',
}

const emptyMenuAnchor: ComposerMenuAnchor = { x: 12, y: 120, width: 320, height: 56 }

const COMPACT_COMPOSER_HEIGHT = 48
const EXPANDED_COMPOSER_MIN_HEIGHT = 100
const composerLineHeight = 24
const compactInputVerticalInset = (COMPACT_COMPOSER_HEIGHT - composerLineHeight) / 2
const compactTextOpticalOffset = Platform.OS === 'ios' ? 2 : 0

export function ChatComposer({
  active,
  focusRequest = 0,
  onFocusRequestHandled,
  disabled,
  emptyContextPlaceholder = '跟进',
  modelLabel,
  reasoningEffort,
  reasoningEfforts = [],
  onLoadApps,
  onClearPlanMode,
  onSelectModel,
  onSend,
  onStop,
  onSetPlanMode,
  onUploadAttachment,
  planModeActive,
  running,
  secondaryLeadingAction,
  sendDisabled = false,
  testIDs,
  stopping,
}: ChatComposerProps) {
  const [message, setMessage] = useState('')
  const [focused, setFocused] = useState(false)
  const [goalDraftActive, setGoalDraftActive] = useState(false)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [selectedApps, setSelectedApps] = useState<RuntimeComposerApp[]>([])
  const [uploading, setUploading] = useState(false)
  const [menuVisible, setMenuVisible] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState(emptyMenuAnchor)
  const wrapperRef = useRef<View>(null)
  const inputRef = useRef<TextInput>(null)
  const consumedFocusRequest = useRef(0)
  const keyboardWasVisibleRef = useRef(false)
  useEffect(() => {
    if (!active) {
      inputRef.current?.blur()
      setFocused(false)
      setMenuVisible(false)
    }
  }, [active])
  useEffect(() => {
    if (focusRequest <= consumedFocusRequest.current) return
    consumedFocusRequest.current = focusRequest
    // Navigation owns pending requests. Once delivered, an unavailable input must
    // expire the request instead of replaying it after a modal or send completes.
    onFocusRequestHandled(focusRequest)
    if (active && !disabled) inputRef.current?.focus()
  }, [active, disabled, focusRequest, onFocusRequestHandled])
  const theme = useTheme()
  const filePreview = useMobileFilePreview()
  const outgoingMessage = composerMessage(message, selectedApps)
  const modelDialProgress =
    reasoningEfforts.length > 1
      ? Math.max(0, reasoningEfforts.indexOf(reasoningEffort ?? '')) / (reasoningEfforts.length - 1)
      : 0
  const canSend = Boolean(outgoingMessage) && !disabled && !running && !sendDisabled && !uploading
  const hasStructuredSelection =
    planModeActive || goalDraftActive || attachments.length > 0 || selectedApps.length > 0
  const hasExpandedContext = hasStructuredSelection || uploading
  const expanded = chatComposerPresentation(active && focused, hasExpandedContext) === 'expanded'
  const glassColorScheme: GlassColorScheme = theme.dark ? 'dark' : 'light'
  const resolvedTestIDs = { ...defaultTestIDs, ...testIDs }
  const selectedMode = planModeActive
    ? {
        accessibilityLabel: '退出计划模式',
        icon: 'list-outline' as const,
        label: '计划',
        onRemove: onClearPlanMode,
        testID: 'composer-plan',
      }
    : goalDraftActive
      ? {
          accessibilityLabel: '退出追求目标模式',
          icon: 'locate-outline' as const,
          label: '追求目标',
          onRemove: () => setGoalDraftActive(false),
          testID: 'composer-goal',
        }
      : null
  const placeholder = goalDraftActive
    ? 'Wework 应该往哪个方向努力？'
    : hasStructuredSelection && !message
      ? ''
      : emptyContextPlaceholder

  const submit = async (override?: string) => {
    const value = composerMessage(override ?? message, selectedApps)
    const canSubmit = Boolean(value) && !disabled && !running && !sendDisabled && !uploading
    if (!value || !canSubmit) return
    const sent = await onSend(value, {
      attachmentIds: attachments.map(attachment => attachment.id),
      attachments: attachments.map(({ previewUri: _previewUri, ...attachment }) => attachment),
      pursueGoal: goalDraftActive,
    })
    if (!sent) return
    setMessage('')
    setAttachments([])
    setSelectedApps([])
    setGoalDraftActive(false)
  }

  const voice = useComposerVoiceInput({
    onTranscript: (text, send) => {
      const next = appendTranscript(message, text)
      setMessage(next)
      if (send) void submit(next)
    },
  })
  const voiceActive = voice.state !== 'idle'
  useEffect(() => {
    if (!keyboardWasVisibleRef.current) return
    if (active && !disabled && (voice.state === 'starting' || voice.state === 'recording')) {
      inputRef.current?.focus()
    }
  }, [active, disabled, voice.state])

  const openMenu = () => {
    wrapperRef.current?.measureInWindow((x, y, width, height) => {
      setMenuAnchor({ x, y, width, height })
      setMenuVisible(true)
    })
  }

  const uploadAssets = async (assets: RuntimeUploadAsset[]) => {
    if (!assets.length) return
    setUploading(true)
    try {
      const uploaded = await Promise.all(assets.map(onUploadAttachment))
      const composerAttachments = uploaded.map<ComposerAttachment>((attachment, index) => ({
        id: attachment.id,
        filename: assets[index]?.name || attachment.filename,
        file_size: attachment.fileSize,
        mime_type: attachment.mimeType,
        status: 'ready',
        file_extension: /\.[^.]+$/.exec(assets[index]?.name || attachment.filename)?.[0] ?? '',
        created_at: new Date().toISOString(),
        ...(attachment.localPath ? { local_path: attachment.localPath } : {}),
        ...(attachment.workspaceFile ? { workspace_file: attachment.workspaceFile } : {}),
        ...(assets[index]?.mimeType.startsWith('image/')
          ? { previewUri: assets[index]?.uri, local_preview_url: assets[index]?.uri }
          : {}),
      }))
      setAttachments(current => [
        ...current,
        ...composerAttachments.filter(item => !current.some(existing => existing.id === item.id)),
      ])
    } catch (cause) {
      showErrorAlert(cause, { title: '无法添加附件' })
    } finally {
      setUploading(false)
    }
  }

  const pickDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
      type: '*/*',
    })
    if (result.canceled) return
    await uploadAssets(
      result.assets.map(asset => ({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType || mimeTypeFromName(asset.name),
        size: asset.size,
      }))
    )
  }

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync()
    if (!permission.granted) {
      showErrorAlert('请在系统设置中允许 Wegent 使用相机。', { title: '无法打开相机' })
      return
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      quality: 1,
    })
    if (result.canceled) return
    await uploadAssets(result.assets.map(imageUploadAsset))
  }

  const pickPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      allowsMultipleSelection: true,
      mediaTypes: ['images'],
      orderedSelection: true,
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      quality: 1,
      selectionLimit: 0,
    })
    if (result.canceled) return
    await uploadAssets(result.assets.map(imageUploadAsset))
  }

  const selectApp = (app: RuntimeComposerApp) => {
    setSelectedApps(current =>
      current.some(item => item.reference === app.reference) ? current : [...current, app]
    )
  }

  const attachmentButton = (
    <Pressable
      accessibilityLabel="添加"
      accessibilityRole="button"
      disabled={disabled || uploading}
      onPress={openMenu}
      accessibilityState={{ disabled: disabled || uploading }}
      style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
      testID={resolvedTestIDs.attachment}
    >
      {uploading ? (
        <ActivityIndicator color={theme.colors.onSurface} size={20} />
      ) : (
        <Ionicons color={theme.colors.onSurface} name="add" size={27} />
      )}
    </Pressable>
  )
  const stopButton = (
    <Pressable
      accessibilityLabel="停止当前回复"
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || stopping }}
      disabled={disabled || stopping}
      onPress={() => void onStop()}
      style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
      testID={resolvedTestIDs.stop}
    >
      <View
        style={[
          styles.sendButton,
          { backgroundColor: theme.colors.onSurface },
          stopping && styles.stopping,
        ]}
      >
        <View style={[styles.stopGlyph, { backgroundColor: theme.colors.surface }]} />
      </View>
    </Pressable>
  )
  const sendButton = (
    <Pressable
      accessibilityLabel="发送"
      accessibilityRole="button"
      accessibilityState={{ disabled: !canSend }}
      disabled={!canSend}
      onPress={() => void submit()}
      style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
      testID={resolvedTestIDs.send}
    >
      <View
        style={[
          styles.sendButton,
          { backgroundColor: canSend ? '#0a84ff' : theme.colors.surfaceVariant },
        ]}
      >
        <Ionicons
          color={canSend ? '#ffffff' : theme.colors.onSurfaceVariant}
          name="arrow-up"
          size={22}
        />
      </View>
    </Pressable>
  )
  const startVoice = () => {
    if (disabled || running) return
    keyboardWasVisibleRef.current = Keyboard.isVisible()
    if (keyboardWasVisibleRef.current && active) {
      inputRef.current?.focus()
    } else {
      inputRef.current?.blur()
      setFocused(false)
    }
    void voice.start()
  }
  const voiceStartButton = (
    <Pressable
      accessibilityLabel="语音输入"
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || running }}
      disabled={disabled || running}
      onPress={startVoice}
      style={({ pressed }) => [styles.actionButton, pressed && styles.pressed]}
      testID="composer-voice-start"
    >
      <View style={[styles.voicePrimaryButton, { backgroundColor: '#0a84ff' }]}>
        <VoiceGlyph />
      </View>
    </Pressable>
  )
  const micButton = (
    <Pressable
      accessibilityLabel="语音输入"
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || running }}
      disabled={disabled || running}
      onPress={startVoice}
      style={({ pressed }) => [styles.voiceMicButton, pressed && styles.pressed]}
      testID="composer-voice-mic"
    >
      <Ionicons color={theme.colors.onSurface} name="mic-outline" size={24} />
    </Pressable>
  )
  const primaryAction = running ? stopButton : outgoingMessage ? sendButton : voiceStartButton

  return (
    <View collapsable={false} ref={wrapperRef}>
      <LiquidGlassGroup spacing={8} style={styles.composerGlassGroup}>
        <LiquidGlassSurface
          colorScheme={glassColorScheme}
          fallbackStyle={{
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.outlineVariant,
          }}
          style={
            voiceActive
              ? styles.voiceSurface
              : expanded
                ? styles.expandedSurface
                : styles.compactSurface
          }
        >
          <View
            pointerEvents={voiceActive ? 'none' : 'auto'}
            style={voiceActive ? styles.voiceHiddenContent : styles.composerBody}
          >
            {selectedMode ? (
              <View style={styles.modeRow}>
                <View style={styles.selectionChip} testID={`${selectedMode.testID}-selection`}>
                  <Ionicons
                    color={theme.colors.onSurfaceVariant}
                    name={selectedMode.icon}
                    size={18}
                  />
                  <Text style={{ color: theme.colors.onSurfaceVariant }} variant="labelLarge">
                    {selectedMode.label}
                  </Text>
                  <Pressable
                    accessibilityLabel={selectedMode.accessibilityLabel}
                    hitSlop={6}
                    onPress={selectedMode.onRemove}
                    testID={`${selectedMode.testID}-remove`}
                  >
                    <Ionicons color={theme.colors.onSurfaceVariant} name="close" size={17} />
                  </Pressable>
                </View>
              </View>
            ) : null}
            {attachments.length || uploading ? (
              <ScrollView
                contentContainerStyle={styles.attachmentStrip}
                horizontal
                keyboardShouldPersistTaps="handled"
                showsHorizontalScrollIndicator={false}
              >
                {attachments.map(attachment => (
                  <View key={attachment.id} style={styles.attachmentChip}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`预览 ${attachment.filename}`}
                      disabled={!filePreview}
                      onPress={() => filePreview?.openAttachment(attachment)}
                      style={styles.attachmentOpen}
                      testID={`composer-attachment-preview-${attachment.id}`}
                    >
                      {attachment.previewUri ? (
                        <Image
                          source={{ uri: attachment.previewUri }}
                          style={styles.attachmentPreview}
                        />
                      ) : (
                        <View style={styles.fileIcon}>
                          <Ionicons
                            color={theme.colors.onSurfaceVariant}
                            name="document-outline"
                            size={17}
                          />
                        </View>
                      )}
                      <Text numberOfLines={1} style={styles.attachmentName} variant="labelMedium">
                        {attachment.filename}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityLabel={`移除 ${attachment.filename}`}
                      hitSlop={6}
                      onPress={() =>
                        setAttachments(current => current.filter(item => item.id !== attachment.id))
                      }
                      testID={`composer-attachment-remove-${attachment.id}`}
                    >
                      <Ionicons color={theme.colors.onSurfaceVariant} name="close" size={16} />
                    </Pressable>
                  </View>
                ))}
                {uploading ? (
                  <View style={styles.attachmentChip}>
                    <ActivityIndicator color={theme.colors.onSurfaceVariant} size={14} />
                    <Text variant="labelMedium">正在上传</Text>
                  </View>
                ) : null}
              </ScrollView>
            ) : null}
            {selectedApps.length ? (
              <View style={styles.selectedApps}>
                {selectedApps.map(app => {
                  const logoUrl = composerLogoUrl(app.logoUrl)
                  return (
                    <Pressable
                      accessibilityHint="轻点移除"
                      accessibilityLabel={`已选择技能 ${app.name}`}
                      accessibilityRole="button"
                      key={app.reference}
                      onPress={() =>
                        setSelectedApps(current =>
                          current.filter(item => item.reference !== app.reference)
                        )
                      }
                      style={({ pressed }) => [styles.selectedAppRow, pressed && styles.pressed]}
                      testID={`composer-selected-app-${app.id}`}
                    >
                      {logoUrl ? (
                        <Image source={{ uri: logoUrl }} style={styles.selectedAppLogo} />
                      ) : (
                        <Ionicons color="#81c7b4" name="extension-puzzle-outline" size={21} />
                      )}
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.selectedAppName,
                          { color: theme.dark ? '#81c7b4' : '#267a69' },
                        ]}
                        variant="titleMedium"
                      >
                        {app.name}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            ) : null}
            <View
              style={[styles.inputRow, expanded ? styles.expandedInputRow : styles.compactInputRow]}
            >
              {expanded ? null : attachmentButton}
              <TextInput
                nativeID="chat-input"
                accessibilityLabel="消息"
                editable={!disabled}
                multiline
                onBlur={() => setFocused(false)}
                onChangeText={setMessage}
                onFocus={() => setFocused(true)}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.onSurfaceVariant}
                ref={inputRef}
                scrollEnabled={expanded}
                textAlignVertical={expanded ? 'top' : 'center'}
                style={[
                  styles.input,
                  expanded ? styles.expandedInput : styles.compactInput,
                  { color: theme.colors.onSurface },
                ]}
                testID={resolvedTestIDs.input}
                value={message}
              />
              {expanded ? null : micButton}
              {expanded ? null : primaryAction}
            </View>
            {expanded ? (
              <View style={styles.actions}>
                {attachmentButton}
                {secondaryLeadingAction}
                <View style={styles.actionSpacer} />
                <Pressable
                  accessibilityLabel={`选择模型，当前 ${modelLabel}`}
                  accessibilityRole="button"
                  onPress={onSelectModel}
                  style={({ pressed }) => [styles.modelButton, pressed && styles.modelPressed]}
                  testID={resolvedTestIDs.model}
                >
                  <ModelDialIcon progress={modelDialProgress} />
                </Pressable>
                {micButton}
                {primaryAction}
              </View>
            ) : null}
          </View>
          {voiceActive ? (
            <VoiceInputBar
              errorMessage={voice.errorMessage}
              levels={voice.levels}
              onCancel={voice.cancel}
              onRetry={() => {
                keyboardWasVisibleRef.current = Keyboard.isVisible()
                void voice.retry()
              }}
              onSend={voice.requestSend}
              onStop={() => voice.stop(false)}
              state={voice.state === 'idle' ? 'starting' : voice.state}
            />
          ) : null}
        </LiquidGlassSurface>
      </LiquidGlassGroup>

      <ComposerContextMenu
        anchor={menuAnchor}
        goalDraftActive={goalDraftActive}
        onDismiss={() => setMenuVisible(false)}
        onLoadApps={onLoadApps}
        onPickDocument={() => void pickDocument()}
        onPickPhoto={() => void pickPhoto()}
        onSelectApp={selectApp}
        onSetGoal={() => {
          if (planModeActive) onClearPlanMode()
          setGoalDraftActive(true)
          if (active && !disabled) inputRef.current?.focus()
        }}
        onSetPlanMode={() => {
          setGoalDraftActive(false)
          onSetPlanMode()
        }}
        onTakePhoto={() => void takePhoto()}
        planModeActive={planModeActive}
        visible={active && menuVisible}
      />
    </View>
  )
}

function appendTranscript(base: string, addition: string): string {
  const existing = base.trimEnd()
  return existing ? `${existing} ${addition}` : addition
}

function imageUploadAsset(asset: ImagePicker.ImagePickerAsset): RuntimeUploadAsset {
  const mimeType = asset.mimeType || mimeTypeFromName(asset.fileName || '')
  const name = compatibleImageName(asset.fileName || `photo-${Date.now()}.jpg`, mimeType)
  return {
    uri: asset.uri,
    name,
    mimeType,
    size: asset.fileSize,
  }
}

function compatibleImageName(name: string, mimeType: string): string {
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png' }[mimeType.toLowerCase()]
  if (!extension) return name
  const currentExtension = name.split('.').pop()?.toLowerCase()
  if (currentExtension === extension || (extension === 'jpg' && currentExtension === 'jpeg')) {
    return name
  }
  const base = name.replace(/\.[^./\\]+$/, '') || 'photo'
  return `${base}.${extension}`
}

function mimeTypeFromName(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase()
  const types: Record<string, string> = {
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    md: 'text/markdown',
    pdf: 'application/pdf',
    png: 'image/png',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    webp: 'image/webp',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return (extension && types[extension]) || 'application/octet-stream'
}

const styles = StyleSheet.create({
  composerGlassGroup: { position: 'relative' },
  compactSurface: {
    marginHorizontal: 36,
    height: COMPACT_COMPOSER_HEIGHT,
    borderRadius: COMPACT_COMPOSER_HEIGHT / 2,
    paddingHorizontal: 2,
  },
  expandedSurface: {
    marginHorizontal: 12,
    minHeight: EXPANDED_COMPOSER_MIN_HEIGHT,
    borderRadius: 28,
    paddingHorizontal: 6,
    paddingTop: 8,
    paddingBottom: 4,
  },
  voiceSurface: {
    marginHorizontal: 12,
    height: 48,
    borderRadius: 24,
    paddingHorizontal: 0,
  },
  composerBody: { width: '100%' },
  voiceHiddenContent: {
    position: 'absolute',
    zIndex: -1,
    width: '100%',
    height: '100%',
    opacity: 0,
    overflow: 'hidden',
  },
  modeRow: { paddingHorizontal: 8, paddingTop: 6 },
  selectionChip: {
    alignSelf: 'flex-start',
    height: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderRadius: 17,
    paddingLeft: 10,
    paddingRight: 8,
    backgroundColor: 'rgba(128,128,128,0.18)',
  },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  compactInputRow: { height: COMPACT_COMPOSER_HEIGHT },
  expandedInputRow: { minHeight: 44 },
  input: { flex: 1, fontSize: 17, lineHeight: composerLineHeight },
  compactInput: {
    height: COMPACT_COMPOSER_HEIGHT,
    paddingHorizontal: 4,
    paddingTop: compactInputVerticalInset - compactTextOpticalOffset,
    paddingBottom: compactInputVerticalInset + compactTextOpticalOffset,
  },
  expandedInput: { minHeight: 44, maxHeight: 132, paddingHorizontal: 9, paddingVertical: 6 },
  actionButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  actions: { height: 44, flexDirection: 'row', alignItems: 'center' },
  actionSpacer: { flex: 1 },
  modelButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelPressed: {
    backgroundColor: 'rgba(10,132,255,0.12)',
    transform: [{ scale: 0.92 }],
  },
  voiceMicButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  voicePrimaryButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopGlyph: { width: 11, height: 11, borderRadius: 2 },
  stopping: { opacity: 0.55 },
  attachmentStrip: { gap: 8, paddingHorizontal: 8, paddingTop: 8 },
  attachmentChip: {
    maxWidth: 220,
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 19,
    paddingLeft: 4,
    paddingRight: 9,
    backgroundColor: 'rgba(128,128,128,0.16)',
  },
  attachmentPreview: { width: 30, height: 30, borderRadius: 9 },
  attachmentOpen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    flexShrink: 1,
  },
  fileIcon: { width: 30, alignItems: 'center', justifyContent: 'center' },
  attachmentName: { minWidth: 0, flexShrink: 1 },
  selectedApps: { paddingHorizontal: 12, paddingTop: 8 },
  selectedAppRow: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 8,
    paddingHorizontal: 2,
  },
  selectedAppLogo: { width: 22, height: 22, borderRadius: 5 },
  selectedAppName: { flexShrink: 1 },
  pressed: { transform: [{ scale: 0.96 }] },
})
