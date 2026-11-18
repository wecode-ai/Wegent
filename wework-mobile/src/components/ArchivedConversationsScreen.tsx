import { useIsFocused } from '@react-navigation/native'
import Ionicons from '@expo/vector-icons/Ionicons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, RefreshControl, View } from 'react-native'
import { ActivityIndicator, Button, Text, TextInput, useTheme } from 'react-native-paper'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { ArchivedConversationItem } from '../../../packages/chat-core/src/runtime-management-types'
import type { RuntimeApi } from '@/services/runtimeApi'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/runtime'
import { confirmNativeAction, showErrorAlert } from '@/services/errorAlerts'
import { ErrorNotice } from './errors/ErrorNotice'

interface Props {
  api: RuntimeApi
  devices: DeviceInfo[]
  selectedDeviceId: string | null
  refreshWork: (deviceId: string) => Promise<unknown>
  onBack: () => void
}

function archiveKey(item: ArchivedConversationItem) {
  return JSON.stringify([item.deviceId, item.taskId])
}

function archiveTimestamp(value: string | number | null | undefined): number {
  return typeof value === 'number' ? value : Date.parse(value ?? '') || 0
}

export function ArchivedConversationsScreen({
  api,
  devices,
  selectedDeviceId,
  refreshWork,
  onBack,
}: Props) {
  const theme = useTheme()
  const focused = useIsFocused()
  const targets = useMemo(
    () =>
      devices.filter(
        device =>
          device.status !== 'offline' &&
          (!selectedDeviceId || device.device_id === selectedDeviceId)
      ),
    [devices, selectedDeviceId]
  )
  const targetsRef = useRef(targets)
  targetsRef.current = targets
  const [items, setItems] = useState<ArchivedConversationItem[]>([])
  const [failures, setFailures] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const pending = useRef(new Set<string>())
  const revision = useRef(0)
  const readRevisions = useRef(new Map<string, number>())
  const reads = useRef(new Map<symbol, number>())
  const load = useCallback(
    async (deviceIds: string[]) => {
      const current = revision.current
      const token = Symbol()
      reads.current.set(token, current)
      setLoading(true)
      await Promise.all(
        deviceIds.map(async deviceId => {
          const read = (readRevisions.current.get(deviceId) ?? 0) + 1
          readRevisions.current.set(deviceId, read)
          try {
            const result = await api.listArchivedConversations({ deviceId, sort: 'updated' })
            if (revision.current !== current || readRevisions.current.get(deviceId) !== read) return
            setItems(previous => [
              ...previous.filter(item => item.deviceId !== deviceId),
              ...result.items,
            ])
            setFailures(previous => {
              const next = { ...previous }
              delete next[deviceId]
              return next
            })
          } catch (cause) {
            if (revision.current === current && readRevisions.current.get(deviceId) === read)
              setFailures(previous => ({ ...previous, [deviceId]: cause }))
          }
        })
      )
      reads.current.delete(token)
      if (revision.current === current)
        setLoading([...reads.current.values()].some(epoch => epoch === current))
    },
    [api]
  )
  useEffect(() => {
    if (!focused) return
    revision.current += 1
    setItems([])
    setFailures({})
    void load(targetsRef.current.map(device => device.device_id))
    return () => {
      revision.current += 1
    }
  }, [load, selectedDeviceId, focused])
  const mutate = async (item: ArchivedConversationItem, action: 'restore' | 'delete') => {
    const key = archiveKey(item)
    if (pending.current.has(key)) return
    pending.current.add(key)
    setBusy(new Set(pending.current))
    const current = revision.current
    const address: RuntimeTaskAddress = {
      deviceId: item.deviceId,
      taskId: item.taskId,
      threadId: item.threadId,
      workspacePath: item.workspacePath,
      workspaceKind: item.workspaceKind,
      runtimeHandle: item.runtimeHandle,
      runtime: item.runtime ?? undefined,
    }
    try {
      const result =
        action === 'restore'
          ? await api.unarchiveConversation(address)
          : await api.deleteArchivedConversation(address)
      if (!result.accepted) throw new Error(result.error || '无法更新已归档会话')
      if (revision.current !== current) return
      readRevisions.current.set(item.deviceId, (readRevisions.current.get(item.deviceId) ?? 0) + 1)
      setItems(previous => previous.filter(candidate => archiveKey(candidate) !== key))
      // The list reader owns refresh failures; the accepted mutation is never repeated.
      await Promise.allSettled([refreshWork(item.deviceId)])
    } catch (cause) {
      if (revision.current === current)
        showErrorAlert(cause, { title: action === 'restore' ? '无法恢复会话' : '无法永久删除会话' })
    } finally {
      pending.current.delete(key)
      if (revision.current === current) setBusy(new Set(pending.current))
    }
  }
  const filtered = items
    .filter(item =>
      `${item.title} ${item.projectName ?? ''}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase())
    )
    .sort(
      (a, b) =>
        archiveTimestamp(b.updatedAt ?? b.createdAt) - archiveTimestamp(a.updatedAt ?? a.createdAt)
    )
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 }}>
        <Pressable
          accessibilityLabel="返回"
          accessibilityRole="button"
          onPress={onBack}
          testID="archives-back"
          style={{ width: 48, height: 48, justifyContent: 'center' }}
        >
          <Ionicons name="chevron-back" size={26} color={theme.colors.onSurface} />
        </Pressable>
        <Text variant="titleLarge">已归档会话</Text>
      </View>
      <TextInput
        accessibilityLabel="搜索已归档会话"
        placeholder="搜索已归档会话"
        value={search}
        onChangeText={setSearch}
        testID="archives-search"
        style={{ marginHorizontal: 16 }}
      />
      <FlatList
        data={filtered}
        keyExtractor={archiveKey}
        testID="archives-list"
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={() => void load(targets.map(device => device.device_id))}
          />
        }
        ListHeaderComponent={
          <>
            {Object.entries(failures).map(([deviceId, error]) => (
              <ErrorNotice
                key={deviceId}
                error={error}
                title={`无法读取 ${targets.find(device => device.device_id === deviceId)?.name ?? '设备'} 的已归档会话`}
                onRetry={() => load([deviceId])}
                testID={`archives-error-${deviceId}`}
              />
            ))}
          </>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator />
          ) : (
            <Text>{targets.length ? '暂无已归档会话' : '所选设备当前不可用，请检查设备连接'}</Text>
          )
        }
        renderItem={({ item }) => (
          <View style={{ paddingVertical: 8, gap: 4 }}>
            <Text variant="titleMedium">{item.title}</Text>
            <Text variant="bodySmall">
              {item.projectName ?? '任务'} ·{' '}
              {targets.find(device => device.device_id === item.deviceId)?.name ?? item.deviceName}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button
                contentStyle={{ minHeight: 48 }}
                disabled={
                  busy.has(archiveKey(item)) ||
                  !targets.some(device => device.device_id === item.deviceId)
                }
                onPress={() => void mutate(item, 'restore')}
                testID={`archives-restore-${item.deviceId}-${item.taskId}`}
              >
                恢复
              </Button>
              <Button
                contentStyle={{ minHeight: 48 }}
                disabled={
                  busy.has(archiveKey(item)) ||
                  !targets.some(device => device.device_id === item.deviceId)
                }
                textColor={theme.colors.error}
                onPress={() => {
                  const confirmationRevision = revision.current
                  confirmNativeAction(
                    '永久删除会话？',
                    `“${item.title}”的会话记录将永久删除，无法恢复。项目文件会保留。`,
                    {
                      confirmLabel: '永久删除',
                      destructive: true,
                      onConfirm: async () => {
                        if (revision.current === confirmationRevision) await mutate(item, 'delete')
                      },
                    }
                  )
                }}
                testID={`archives-delete-${item.deviceId}-${item.taskId}`}
              >
                永久删除
              </Button>
            </View>
          </View>
        )}
      />
    </SafeAreaView>
  )
}
