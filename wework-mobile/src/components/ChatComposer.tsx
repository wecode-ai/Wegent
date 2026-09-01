import Ionicons from '@expo/vector-icons/Ionicons'
import * as DocumentPicker from 'expo-document-picker'
import type { GlassColorScheme } from 'expo-glass-effect'
import * as ImagePicker from 'expo-image-picker'
import { useRef, useState, type ReactNode } from 'react'
import { Alert, Image, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { ActivityIndicator, Text, useTheme } from 'react-native-paper'

import { composerLogoUrl, composerMessage } from '@/domain/composerApps'
import { chatComposerPresentation } from '@/domain/chatComposerPresentation'
import type { RuntimeAttachment, RuntimeComposerApp, RuntimeUploadAsset } from '@/types/runtime'
import { ComposerContextMenu, type ComposerMenuAnchor } from './ComposerContextMenu'
import { KeyboardSafeTextInput, type KeyboardSafeTextInputHandle } from './KeyboardSafeInput'
import { LiquidGlassButton, LiquidGlassGroup, LiquidGlassSurface } from './LiquidGlass'

export interface ComposerSendOptions {
  attachmentIds: number[]
  pursueGoal: boolean
}

interface ChatComposerProps {
  contextLabel?: string | null
  disabled: boolean
  emptyContextPlaceholder?: string
  modelLabel: string
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

interface ComposerAttachment extends RuntimeAttachment {
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

const COMPACT_COMPOSER_HEIGHT = 56
const EXPANDED_COMPOSER_MIN_HEIGHT = 88
const composerLineHeight = 24
const compactInputVerticalInset = (COMPACT_COMPOSER_HEIGHT - composerLineHeight) / 2
const compactTextOpticalOffset = Platform.OS === 'ios' ? 2 : 0
const stopGlassTint = 'rgba(255, 59, 48, 0.58)'
const stopGlassBorder = 'rgba(255, 105, 97, 0.76)'

export function ChatComposer({
  contextLabel,
  disabled,
  emptyContextPlaceholder = '跟进',
  modelLabel,
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
  const inputRef = useRef<KeyboardSafeTextInputHandle>(null)
  const theme = useTheme()
  const outgoingMessage = composerMessage(message, selectedApps)
  const canSend = Boolean(outgoingMessage) && !disabled && !running && !sendDisabled && !uploading
  const hasStructuredSelection =
    planModeActive || goalDraftActive || attachments.length > 0 || selectedApps.length > 0
  const hasExpandedContext = hasStructuredSelection || uploading
  const expanded = chatComposerPresentation(focused, hasExpandedContext) === 'expanded'
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
    ? 'Wegent 应该往哪个方向努力？'
    : hasStructuredSelection && !message
      ? ''
      : contextLabel
        ? expanded
          ? `在 ${contextLabel} 上工作`
          : '跟进'
        : emptyContextPlaceholder

  const submit = async () => {
    const value = composerMessage(message, selectedApps)
    if (!value || !canSend) return
    const sent = await onSend(value, {
      attachmentIds: attachments.map(attachment => attachment.id),
      pursueGoal: goalDraftActive,
    })
    if (!sent) return
    setMessage('')
    setAttachments([])
    setSelectedApps([])
    setGoalDraftActive(false)
  }

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
        ...attachment,
        filename: assets[index]?.name || attachment.filename,
        ...(assets[index]?.mimeType.startsWith('image/') ? { previewUri: assets[index]?.uri } : {}),
      }))
      setAttachments(current => [
        ...current,
        ...composerAttachments.filter(item => !current.some(existing => existing.id === item.id)),
      ])
    } catch (cause) {
      Alert.alert('无法添加附件', cause instanceof Error ? cause.message : String(cause))
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
      Alert.alert('无法打开相机', '请在系统设置中允许 Wegent 使用相机。')
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
      style={({ pressed }) => [
        styles.actionButton,
        { width: expanded ? 40 : 44 },
        pressed && styles.pressed,
      ]}
      testID={resolvedTestIDs.attachment}
    >
      {uploading ? (
        <ActivityIndicator color={theme.colors.onSurface} size={20} />
      ) : (
        <Ionicons color={theme.colors.onSurface} name="add" size={23} />
      )}
    </Pressable>
  )
  const stopButton = running ? (
    <LiquidGlassButton
      accessibilityLabel="停止当前回复"
      colorScheme={glassColorScheme}
      contentStyle={[styles.stopButtonContent, stopping && styles.stopping]}
      disabled={disabled || stopping}
      fallbackStyle={{ backgroundColor: stopGlassTint, borderColor: stopGlassBorder }}
      onPress={() => void onStop()}
      style={[
        styles.sendButton,
        styles.stopButtonOverlay,
        expanded ? styles.expandedStopButton : styles.compactStopButton,
      ]}
      testID={resolvedTestIDs.stop}
      tintColor={stopGlassTint}
    >
      <View style={styles.stopGlyph} />
    </LiquidGlassButton>
  ) : null
  const sendButton = running ? (
    <View style={styles.sendButton} />
  ) : (
    <Pressable
      accessibilityLabel="发送"
      accessibilityRole="button"
      disabled={!canSend}
      onPress={() => void submit()}
      style={({ pressed }) => [
        styles.sendButton,
        { backgroundColor: canSend ? '#f5f5f7' : theme.colors.surfaceVariant },
        pressed && styles.pressed,
      ]}
      testID={resolvedTestIDs.send}
    >
      <Ionicons
        color={canSend ? '#111111' : theme.colors.onSurfaceVariant}
        name="arrow-up"
        size={24}
      />
    </Pressable>
  )

  return (
    <View collapsable={false} ref={wrapperRef}>
      <LiquidGlassGroup spacing={8} style={styles.composerGlassGroup}>
        <LiquidGlassSurface
          colorScheme={glassColorScheme}
          fallbackStyle={{
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.outlineVariant,
          }}
          style={[styles.surface, expanded ? styles.expandedSurface : styles.compactSurface]}
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
              showsHorizontalScrollIndicator={false}
            >
              {attachments.map(attachment => (
                <View key={attachment.id} style={styles.attachmentChip}>
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
            <View style={expanded ? styles.hidden : undefined}>{attachmentButton}</View>
            <KeyboardSafeTextInput
              accessibilityLabel="消息"
              editable={!disabled}
              multiline
              numberOfLines={expanded ? 3 : 1}
              onBlur={() => setFocused(false)}
              onChangeText={setMessage}
              onFocus={() => setFocused(true)}
              placeholder={placeholder}
              placeholderTextColor={theme.colors.onSurfaceVariant}
              ref={inputRef}
              scrollEnabled={expanded}
              style={[
                styles.input,
                expanded ? styles.expandedInput : styles.compactInput,
                { color: theme.colors.onSurface },
              ]}
              testID={resolvedTestIDs.input}
              value={message}
            />
            <View style={expanded ? styles.hidden : undefined}>{sendButton}</View>
          </View>
          {expanded ? (
            <View style={styles.actions}>
              {attachmentButton}
              {secondaryLeadingAction}
              <Pressable
                accessibilityRole="button"
                onPress={onSelectModel}
                style={styles.modelButton}
                testID={resolvedTestIDs.model}
              >
                <Text
                  numberOfLines={1}
                  style={{ color: theme.colors.onSurface }}
                  variant="labelLarge"
                >
                  {modelLabel}
                </Text>
              </Pressable>
              {sendButton}
            </View>
          ) : null}
        </LiquidGlassSurface>
        {stopButton}
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
          setFocused(true)
          requestAnimationFrame(() => inputRef.current?.focus())
        }}
        onSetPlanMode={() => {
          setGoalDraftActive(false)
          onSetPlanMode()
        }}
        onTakePhoto={() => void takePhoto()}
        planModeActive={planModeActive}
        visible={menuVisible}
      />
    </View>
  )
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
  surface: { marginHorizontal: 8 },
  compactSurface: {
    height: COMPACT_COMPOSER_HEIGHT,
    borderRadius: COMPACT_COMPOSER_HEIGHT / 2,
    paddingHorizontal: 4,
  },
  expandedSurface: {
    minHeight: EXPANDED_COMPOSER_MIN_HEIGHT,
    borderRadius: 30,
    paddingHorizontal: 6,
    paddingTop: 4,
    paddingBottom: 4,
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
  expandedInputRow: { minHeight: 36 },
  input: { flex: 1, fontSize: 17, lineHeight: composerLineHeight },
  compactInput: {
    height: COMPACT_COMPOSER_HEIGHT,
    paddingHorizontal: 4,
    paddingTop: compactInputVerticalInset - compactTextOpticalOffset,
    paddingBottom: compactInputVerticalInset + compactTextOpticalOffset,
  },
  expandedInput: { minHeight: 36, maxHeight: 108, paddingHorizontal: 9, paddingVertical: 6 },
  hidden: { display: 'none' },
  actionButton: { height: 44, alignItems: 'center', justifyContent: 'center' },
  actions: { height: 44, flexDirection: 'row', alignItems: 'center' },
  modelButton: {
    maxWidth: 180,
    marginLeft: 'auto',
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButtonContent: {
    width: '100%',
    height: '100%',
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButtonOverlay: { position: 'absolute' },
  compactStopButton: { right: 12, top: 6 },
  expandedStopButton: { right: 14, bottom: 4 },
  stopGlyph: { width: 14, height: 14, borderRadius: 3, backgroundColor: '#ffffff' },
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
