import Ionicons from '@expo/vector-icons/Ionicons'
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { Button, Dialog, Portal, TextInput, useTheme } from 'react-native-paper'
import type { RuntimeProjectWork } from '@/types/runtime'
import { confirmNativeAction, showErrorAlert } from '@/services/errorAlerts'
import { ConversationMenuNative } from './ConversationMenuNative'
import { ErrorNotice } from './errors/ErrorNotice'

export interface ProjectMenuActions {
  onPin: (project: RuntimeProjectWork, pinned: boolean) => Promise<void>
  onRename: (project: RuntimeProjectWork, name: string) => Promise<void>
  onRemove: (project: RuntimeProjectWork) => Promise<void>
  onArchive: (project: RuntimeProjectWork) => Promise<void>
}

export function ProjectMenu({
  project,
  actions,
}: {
  project: RuntimeProjectWork
  actions: ProjectMenuActions
}) {
  const theme = useTheme()
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(project.project.name)
  const [error, setError] = useState<unknown>(null)
  const run = async (action: () => Promise<void>, inline = false) => {
    if (pending.current || !mounted.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      setRenaming(false)
    } catch (cause) {
      if (inline) setError(cause)
      else showErrorAlert(cause)
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const key = `${project.project.stateDeviceId || project.deviceWorkspaces[0]?.deviceId}-${project.project.key}`
  return (
    <>
      <ConversationMenuNative
        accessibilityLabel={`${project.project.name} 的项目操作`}
        actions={[
          {
            id: 'project-pin',
            title: project.project.pinned ? '取消置顶' : '置顶',
            icon: 'pin',
            disabled: busy,
            section: 'conversation',
          },
          {
            id: 'project-rename',
            title: '重命名',
            icon: 'pencil',
            disabled: busy,
            section: 'conversation',
          },
          {
            id: 'project-archive',
            title: '归档项目全部聊天',
            icon: 'archivebox',
            disabled:
              busy || !project.deviceWorkspaces.some(workspace => workspace.tasks.length > 0),
            section: 'conversation',
          },
          {
            id: 'project-remove',
            title: '移除项目',
            icon: 'trash',
            destructive: true,
            disabled: busy,
            section: 'conversation',
          },
        ]}
        colorScheme={theme.dark ? 'dark' : 'light'}
        disabled={busy || renaming}
        onSelect={id => {
          if (pending.current || renaming) return
          if (id === 'project-pin') void run(() => actions.onPin(project, !project.project.pinned))
          if (id === 'project-rename') {
            setName(project.project.name)
            setRenaming(true)
          }
          if (id === 'project-archive')
            confirmNativeAction(
              '归档项目全部聊天？',
              `将归档“${project.project.name}”中的全部聊天，可在已归档会话中恢复。`,
              {
                confirmLabel: '归档',
                onConfirm: () => run(() => actions.onArchive(project)),
              }
            )
          if (id === 'project-remove')
            confirmNativeAction(
              '移除项目？',
              `从 Wework 中移除“${project.project.name}”。磁盘文件和会话会保留。`,
              {
                confirmLabel: '移除',
                destructive: true,
                onConfirm: () => run(() => actions.onRemove(project)),
              }
            )
        }}
        title={project.project.name}
        testID={`project-menu-${key}`}
        triggerTestID={`project-menu-${key}-trigger`}
        width={44}
      >
        <View style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name="ellipsis-horizontal" size={22} color={theme.colors.onSurfaceVariant} />
        </View>
      </ConversationMenuNative>
      {renaming ? (
        <Portal>
          <Dialog
            visible
            dismissable={!busy}
            onDismiss={() => {
              if (!pending.current) setRenaming(false)
            }}
            testID="project-rename-dialog"
          >
            <Dialog.Title>重命名项目</Dialog.Title>
            <Dialog.Content>
              <TextInput
                autoFocus
                accessibilityLabel="项目名称"
                value={name}
                onChangeText={setName}
                disabled={busy}
                testID="project-rename-input"
              />
              {error ? (
                <ErrorNotice error={error} title="无法重命名项目" testID="project-rename-error" />
              ) : null}
            </Dialog.Content>
            <Dialog.Actions>
              <Button
                disabled={busy}
                onPress={() => setRenaming(false)}
                testID="project-rename-cancel"
              >
                取消
              </Button>
              <Button
                loading={busy}
                disabled={busy || !name.trim()}
                onPress={() => void run(() => actions.onRename(project, name.trim()), true)}
                testID="project-rename-save"
              >
                保存
              </Button>
            </Dialog.Actions>
          </Dialog>
        </Portal>
      ) : null}
    </>
  )
}
