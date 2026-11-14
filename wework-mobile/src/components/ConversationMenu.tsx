import Ionicons from '@expo/vector-icons/Ionicons'
import * as Clipboard from 'expo-clipboard'
import { useEffect, useState } from 'react'
import { BackHandler, Pressable, StyleSheet, View } from 'react-native'
import { Button, Dialog, Portal, Text, TextInput, useTheme } from 'react-native-paper'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { RuntimeTaskAddress } from '@/types/runtime'
import { LiquidGlassSurface } from './LiquidGlass'
import { useMobileFilePreview } from './files/FilePreviewContext'

export interface ConversationMenuActions {
  threadId: string | null
  canPin: boolean
  pinned: boolean
  onPin: () => Promise<void>
  onRename: (title: string) => Promise<void>
  onArchive: () => Promise<void>
}

interface Props extends ConversationMenuActions {
  address: RuntimeTaskAddress | null
  title: string
  visible: boolean
  onDismiss: () => void
}

export function ConversationMenu(props: Props) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const files = useMobileFilePreview()
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(props.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!props.visible) return
    setTitle(props.title)
    setRenaming(false)
    setError(null)
  }, [props.visible, props.title, props.address?.deviceId, props.address?.taskId])
  useEffect(() => {
    if (!props.visible) return
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!busy) props.onDismiss()
      return true
    })
    return () => listener.remove()
  }, [busy, props.visible, props.onDismiss])

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      props.onDismiss()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const openFiles = (changes: boolean) => {
    props.onDismiss()
    if (changes) files?.openChangesBrowser()
    else files?.openBrowser()
  }
  if (!props.visible) return null

  return (
    <Portal>
      {renaming ? (
        <Dialog
          visible
          onDismiss={busy ? undefined : props.onDismiss}
          testID="conversation-rename-dialog"
        >
          <Dialog.Title>重命名</Dialog.Title>
          <Dialog.Content>
            <TextInput
              autoFocus
              accessibilityLabel="会话名称"
              value={title}
              onChangeText={setTitle}
              disabled={busy}
              testID="conversation-rename-input"
            />
            {error ? (
              <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>
                {error}
              </Text>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button disabled={busy} onPress={props.onDismiss} testID="conversation-rename-cancel">
              取消
            </Button>
            <Button
              disabled={busy || !title.trim()}
              loading={busy}
              onPress={() => void run(() => props.onRename(title.trim()))}
              testID="conversation-rename-save"
            >
              保存
            </Button>
          </Dialog.Actions>
        </Dialog>
      ) : (
        <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
          <Pressable
            accessibilityLabel="关闭会话菜单"
            accessibilityRole="button"
            disabled={busy}
            onPress={props.onDismiss}
            style={StyleSheet.absoluteFill}
            testID="conversation-menu-dismiss"
          />
          <LiquidGlassSurface
            colorScheme={theme.dark ? 'dark' : 'light'}
            fallbackStyle={{
              backgroundColor: theme.colors.elevation.level3,
              borderColor: theme.colors.outlineVariant,
            }}
            isInteractive={false}
            style={[styles.menu, { top: Math.max(insets.top, 8) }]}
            testID="conversation-menu"
          >
            <Text
              numberOfLines={1}
              style={[styles.title, { color: theme.colors.onSurfaceVariant }]}
            >
              {props.title}
            </Text>
            <MenuItem
              label={props.pinned ? '取消置顶' : '置顶'}
              icon="pin-outline"
              disabled={busy || !props.canPin}
              onPress={() => void run(props.onPin)}
              testID="conversation-pin"
            />
            <MenuItem
              label="重命名"
              icon="pencil-outline"
              disabled={busy || !props.address}
              onPress={() => setRenaming(true)}
              testID="conversation-rename"
            />
            <MenuItem
              label="复制对话串 ID"
              icon="copy-outline"
              disabled={busy || !props.address || !props.threadId}
              onPress={() => {
                const threadId = props.threadId
                if (threadId) void run(() => Clipboard.setStringAsync(threadId))
              }}
              testID="conversation-copy-id"
            />
            <MenuItem
              label="归档"
              icon="archive-outline"
              destructive
              disabled={busy || !props.address}
              onPress={() => void run(props.onArchive)}
              testID="conversation-archive"
            />
            <View style={[styles.divider, { backgroundColor: theme.colors.outlineVariant }]} />
            <MenuItem
              label="更改"
              icon="git-branch-outline"
              disabled={busy || !files?.target}
              onPress={() => openFiles(true)}
              testID="conversation-changes"
            />
            <MenuItem
              label="文件"
              icon="folder-outline"
              disabled={busy || !files?.target}
              onPress={() => openFiles(false)}
              testID="conversation-files"
            />
            {error ? (
              <Text accessibilityRole="alert" style={[styles.error, { color: theme.colors.error }]}>
                {error}
              </Text>
            ) : null}
          </LiquidGlassSurface>
        </View>
      )}
    </Portal>
  )
}

function MenuItem({
  label,
  icon,
  disabled,
  destructive,
  onPress,
  testID,
}: {
  label: string
  icon: keyof typeof Ionicons.glyphMap
  disabled: boolean
  destructive?: boolean
  onPress: () => void
  testID: string
}) {
  const theme = useTheme()
  const color = destructive ? theme.colors.error : theme.colors.onSurface
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        disabled && { opacity: 0.35 },
        pressed && { opacity: 0.6 },
      ]}
      testID={testID}
    >
      <Ionicons name={icon} size={22} color={color} />
      <Text style={[styles.label, { color }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  menu: {
    position: 'absolute',
    right: 26,
    width: 245,
    borderRadius: 34,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 12,
    overflow: 'hidden',
  },
  title: { fontSize: 13, lineHeight: 18, marginBottom: 8 },
  row: { minHeight: 41, flexDirection: 'row', alignItems: 'center', gap: 16 },
  label: { fontSize: 17, lineHeight: 24 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 9 },
  error: { marginTop: 8, fontSize: 13 },
})
