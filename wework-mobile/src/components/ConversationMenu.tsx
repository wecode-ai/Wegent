import Ionicons from '@expo/vector-icons/Ionicons'
import * as Clipboard from 'expo-clipboard'
import { useEffect, useRef, useState } from 'react'
import { BackHandler, Keyboard, View } from 'react-native'
import { Button, Dialog, Portal, Text, TextInput, useTheme } from 'react-native-paper'
import type { RuntimeTaskAddress } from '@/types/runtime'
import { ConversationMenuNative } from './ConversationMenuNative'
import type { ConversationMenuAction } from './ConversationMenuNative.types'
import { useMobileFilePreview } from './files/FilePreviewContext'

export interface ConversationMenuActions {
  threadId: string | null
  canPin: boolean
  pinned: boolean
  onPin: () => Promise<void>
  onRename: (title: string) => Promise<void>
  onArchive: () => Promise<void>
  onSettings: () => void
}

interface Props extends ConversationMenuActions {
  address: RuntimeTaskAddress | null
  title: string
  compact?: boolean
}

export function ConversationMenu(props: Props) {
  const theme = useTheme()
  const files = useMobileFilePreview()
  const pending = useRef(false)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(props.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!renaming && !error) return
    const listener = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!pending.current) {
        setRenaming(false)
        setError(null)
      }
      return true
    })
    return () => listener.remove()
  }, [error, renaming])

  const run = async (action: () => unknown, afterSuccess?: () => void) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      afterSuccess?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const actions: ConversationMenuAction[] = [
    {
      id: 'conversation-pin',
      title: props.pinned ? '取消置顶' : '置顶',
      icon: props.pinned ? 'pin.slash' : 'pin',
      disabled: busy || !props.canPin,
      section: 'conversation',
    },
    {
      id: 'conversation-rename',
      title: '重命名',
      icon: 'pencil',
      disabled: busy || !props.address,
      section: 'conversation',
    },
    {
      id: 'conversation-copy-id',
      title: '复制对话串 ID',
      icon: 'doc.on.doc',
      disabled: busy || !props.address || !props.threadId,
      section: 'conversation',
    },
    {
      id: 'conversation-archive',
      title: '归档',
      icon: 'archivebox',
      disabled: busy || !props.address,
      destructive: true,
      section: 'conversation',
    },
    {
      id: 'conversation-changes',
      title: '更改',
      icon: 'arrow.triangle.branch',
      disabled: busy || !files?.target,
      section: 'workspace',
    },
    {
      id: 'conversation-files',
      title: '文件',
      icon: 'folder',
      disabled: busy || !files?.target,
      section: 'workspace',
    },
    {
      id: 'conversation-settings',
      title: '连接设置',
      icon: 'gearshape',
      disabled: busy,
      section: 'settings',
    },
  ]
  const select = (id: string) => {
    const action = actions.find(item => item.id === id)
    if (!action || action.disabled || pending.current || renaming || error) return
    Keyboard.dismiss()
    // Native menus dismiss themselves when an item is selected. Dialogs and
    // navigation do not depend on an iOS open/close callback or animation timer.
    switch (id) {
      case 'conversation-pin':
        void run(props.onPin)
        break
      case 'conversation-rename':
        setTitle(props.title)
        setError(null)
        setRenaming(true)
        break
      case 'conversation-copy-id':
        void run(() => Clipboard.setStringAsync(props.threadId!))
        break
      case 'conversation-archive':
        void run(props.onArchive)
        break
      case 'conversation-changes':
        void run(() => files?.openChangesBrowser())
        break
      case 'conversation-files':
        void run(() => files?.openBrowser())
        break
      case 'conversation-settings':
        void run(props.onSettings)
        break
    }
  }
  const dismiss = () => {
    if (pending.current) return
    setRenaming(false)
    setError(null)
  }
  const width = props.compact ? 44 : 54

  return (
    <>
      <ConversationMenuNative
        actions={actions}
        colorScheme={theme.dark ? 'dark' : 'light'}
        disabled={busy || renaming || Boolean(error)}
        onSelect={select}
        title={props.title}
        width={width}
      >
        <View
          accessible={false}
          style={{ width, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ionicons color={theme.colors.onSurface} name="ellipsis-horizontal" size={25} />
        </View>
      </ConversationMenuNative>
      <Portal>
        {renaming ? (
          <Dialog
            visible
            onDismiss={dismiss}
            dismissable={!busy}
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
              <Button disabled={busy} onPress={dismiss} testID="conversation-rename-cancel">
                取消
              </Button>
              <Button
                disabled={busy || !title.trim()}
                loading={busy}
                onPress={() => {
                  if (title.trim())
                    void run(
                      () => props.onRename(title.trim()),
                      () => setRenaming(false)
                    )
                }}
                testID="conversation-rename-save"
              >
                保存
              </Button>
            </Dialog.Actions>
          </Dialog>
        ) : error ? (
          <Dialog visible onDismiss={dismiss} testID="conversation-menu-error-dialog">
            <Dialog.Title>操作失败</Dialog.Title>
            <Dialog.Content>
              <Text accessibilityRole="alert">{error}</Text>
            </Dialog.Content>
            <Dialog.Actions>
              <Button onPress={dismiss} testID="conversation-menu-error-dismiss">
                确定
              </Button>
            </Dialog.Actions>
          </Dialog>
        ) : null}
      </Portal>
    </>
  )
}
