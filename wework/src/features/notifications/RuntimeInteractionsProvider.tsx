import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  isAsyncRequestUserInputPayload,
  requestUserInputResponseText,
} from '@wegent/chat-core/runtime-user-input'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/desktop/windowFocus'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { useNotificationTaskSource } from './NotificationTaskSourceContext'
import {
  interactionResponse,
  interactionId,
  interactionOriginalScheme,
  canReplyToInteraction,
  interactionAllowsNativeReply,
  readRuntimeInteractions,
  type RuntimeInteraction,
} from './runtimeInteractions'
import {
  INTERACTIONS_PATH,
  INTERACTIONS_TAB_ID,
  RuntimeInteractionsContext,
  type InteractionHistory,
  type RuntimeInteractionsValue,
} from './RuntimeInteractionsContext'
import { createStandInRecordStore } from './standInNotificationStorage'
import {
  readActiveNotificationPreferences,
  NOTIFICATION_PREFERENCES_CHANGED_EVENT,
} from './notificationPreferences'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { weworkInteractionScheme } from './scheme'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { replyToInteractionProject } from './interactionProjectReply'
import { prepareRuntimeContinuationModel } from '@/features/workbench/runtimeContinuationModel'
import { TransientNotice } from '@/components/common/TransientNotice'
import { readInteractionTaskInventory } from './interactionTaskInventory'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import {
  archiveInteraction,
  readInteractionDrafts,
  readInteractionHistory,
  saveInteractionState,
  readPendingInteractionCache,
  pendingInteractionCache,
} from './interactionStorage'

export function RuntimeInteractionsProvider({
  accountKey,
  children,
}: {
  accountKey: string
  children: ReactNode
}) {
  const [snapshot, setSnapshot] = useState<{
    accountKey: string
    value: RuntimeInteractionsValue
  } | null>(null)
  const publish = useCallback(
    (value: RuntimeInteractionsValue) => setSnapshot({ accountKey, value }),
    [accountKey]
  )
  return (
    <RuntimeInteractionsContext.Provider
      value={snapshot?.accountKey === accountKey ? snapshot.value : null}
    >
      {/* Reset only interaction state; connection dialogs and other application UI stay mounted. */}
      <RuntimeInteractionsState key={accountKey} accountKey={accountKey} publish={publish} />
      {children}
    </RuntimeInteractionsContext.Provider>
  )
}

function RuntimeInteractionsState({
  accountKey,
  publish,
}: {
  accountKey: string
  publish: (value: RuntimeInteractionsValue) => void
}) {
  const source = useNotificationTaskSource()
  const tabs = useWorkspaceTabs()
  const { t } = useTranslation('common')
  const sourceRef = useRef(source)
  sourceRef.current = source
  const cacheKey = `wework.interactions:${accountKey}:pending`
  const cached = useMemo(() => readPendingInteractionCache(cacheKey), [cacheKey])
  const [loaded, setLoaded] = useState<Record<string, RuntimeInteraction[]>>(() => {
    const groups: Record<string, RuntimeInteraction[]> = {}
    for (const item of cached) (groups[item.task.key] ??= []).push(item)
    return groups
  })
  const [inventory, setInventory] = useState<RuntimeTaskReminderItem[]>(() =>
    cached.map(item => item.task)
  )
  const inventoryRef = useRef(inventory)
  inventoryRef.current = inventory
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const inFlight = useRef(new Set<string>())
  const clientIds = useRef(new Map<string, { answer: string; id: string }>())
  const successfulReads = useRef(new Map<string, { signature: string; readAt: number }>())
  const successfulReadApi = useRef(source?.services?.runtimeWorkApi)
  const fetching = useRef(false)
  const mounted = useRef(true)
  const [loading, setLoading] = useState(false)
  const [replyNotice, setReplyNotice] = useState<string | null>(null)
  const acceptancePrefix = `wework.interactions:${accountKey}:accepted:`
  const historyKey = `wework.interactions:${accountKey}:history`
  const draftKey = `wework.interactions:${accountKey}:drafts`
  const [history, setHistory] = useState<InteractionHistory[]>(() =>
    readInteractionHistory(historyKey)
  )
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    readInteractionDrafts(draftKey)
  )
  const [submitted, setSubmitted] = useState<Set<string>>(
    () => new Set(history.map(item => item.id))
  )
  const submittedRef = useRef(submitted)
  const handledNativeReplies = useMemo(
    () => createStandInRecordStore(`wework.interactions:${accountKey}:native-replies`),
    [accountKey]
  )
  const delivered = useMemo(
    () => createStandInRecordStore(`wework.interactions:${accountKey}:delivered`),
    [accountKey]
  )
  const [noticeIds, setNoticeIds] = useState<string[]>([])
  const [focused, setFocused] = useState(isMainWindowFocused)
  const [preferences, setPreferences] = useState(readActiveNotificationPreferences)
  const views = useRef(new Map<string, string>())
  const registerView = useCallback((owner: string, id: string | null) => {
    if (id) {
      views.current.set(owner, id)
      setNoticeIds(current =>
        current.includes(id) ? current.filter(value => value !== id) : current
      )
    } else views.current.delete(owner)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => subscribeMainWindowFocus(setFocused), [])
  useEffect(() => {
    const update = () => setPreferences(readActiveNotificationPreferences())
    window.addEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, update)
    return () => window.removeEventListener(NOTIFICATION_PREFERENCES_CHANGED_EVENT, update)
  }, [])
  useEffect(() => {
    saveInteractionState(draftKey, drafts)
  }, [draftKey, drafts])

  const archive = useCallback(
    async (item: RuntimeInteraction, answeredAt = item.createdAt) => {
      await navigator.locks.request(historyKey, () => {
        const next = archiveInteraction(readInteractionHistory(historyKey), {
          id: item.id,
          title: item.task.task.title,
          question: item.question,
          address: item.task.address,
          originalUrl: interactionOriginalScheme(item),
          answeredAt,
        })
        saveInteractionState(historyKey, next)
        if (mounted.current) setHistory(next)
      })
    },
    [historyKey]
  )
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key !== historyKey) return
      const next = readInteractionHistory(historyKey)
      setHistory(next)
      submittedRef.current = new Set([...submittedRef.current, ...next.map(item => item.id)])
      setSubmitted(submittedRef.current)
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [historyKey])

  const refresh = useCallback(
    async (force = true) => {
      const current = sourceRef.current
      const api = current?.services?.runtimeWorkApi
      if (!api || fetching.current) return
      if (successfulReadApi.current !== api) {
        successfulReads.current.clear()
        successfulReadApi.current = api
      }
      fetching.current = true
      setLoading(true)
      try {
        const discovered = await readInteractionTaskInventory(current)
        if (!mounted.current || sourceRef.current?.services?.runtimeWorkApi !== api) return
        const retained = inventoryRef.current.filter(
          item => !discovered.refreshedDevices.has(item.address.deviceId)
        )
        const nextInventory = [
          ...new Map([...retained, ...discovered.items].map(item => [item.key, item])).values(),
        ]
        setInventory(nextInventory)
        setErrors(value => {
          const next = Object.fromEntries(
            Object.entries(value).filter(([key]) => !key.startsWith('inventory:'))
          )
          for (const deviceId of discovered.failedDevices) {
            if (
              inventoryRef.current.some(item => item.address.deviceId === deviceId) ||
              current.items.some(
                item => item.address.deviceId === deviceId && item.task.interactionStatus
              ) ||
              deviceId === ''
            )
              next[`inventory:${deviceId}`] = t('interactions.load_failed')
          }
          return next
        })
        const candidates = new Map(
          [
            ...Object.values(loadedRef.current)
              .flat()
              .filter(item => !item.answered)
              .map(item => item.task),
            ...current.items,
            ...nextInventory,
          ].map(item => [item.key, item])
        )
        const items = [...candidates.values()].filter(
          item =>
            (item.lifecycle?.interactionStatus ?? item.task.interactionStatus) ||
            loadedRef.current[item.key]?.some(request => !request.answered)
        )
        // Limit concurrent history reads without blocking unrelated tasks on one failure.
        let index = 0
        await Promise.all(
          Array.from({ length: Math.min(4, items.length) }, async () => {
            while (index < items.length) {
              const item = items[index++]
              if (
                discovered.failedDevices.has(item.address.deviceId) ||
                discovered.failedDevices.has('') ||
                (loadedRef.current[item.key]?.some(request => request.cached) &&
                  !discovered.refreshedDevices.has(item.address.deviceId))
              ) {
                successfulReads.current.delete(item.key)
                continue
              }
              const readSignature = JSON.stringify([
                item.task.updatedAt,
                item.lifecycle?.interactionStatus,
                item.task.interactionStatus,
                item.lifecycle?.turn.id,
                item.lifecycle?.turn.latestId,
                item.lifecycle?.turn.phase,
              ])
              const previousRead = successfulReads.current.get(item.key)
              // Summary timestamps are not transcript revisions; bound background cache freshness.
              if (
                !force &&
                item.task.updatedAt &&
                previousRead?.signature === readSignature &&
                Date.now() - previousRead.readAt < 30_000
              )
                continue
              try {
                const requests = await readRuntimeInteractions(item, api)
                if (!mounted.current || sourceRef.current?.services?.runtimeWorkApi !== api) return
                successfulReads.current.set(item.key, {
                  signature: readSignature,
                  readAt: Date.now(),
                })
                setLoaded(value => ({ ...value, [item.key]: requests }))
                setErrors(value => {
                  const next = { ...value }
                  delete next[item.key]
                  return next
                })
                for (const answered of requests.filter(request => request.answered)) {
                  await archive(answered)
                  localStorage.removeItem(acceptancePrefix + answered.id)
                }
              } catch (error) {
                successfulReads.current.delete(item.key)
                if (!mounted.current) return
                console.error('[Wework] Could not read pending interaction', {
                  taskId: item.address.taskId,
                  error,
                })
                setErrors(value => ({ ...value, [item.key]: t('interactions.load_failed') }))
                if (item.lifecycle?.interactionStatus ?? item.task.interactionStatus) {
                  setLoaded(value =>
                    value[item.key]?.length
                      ? value
                      : {
                          ...value,
                          [item.key]: [
                            {
                              id: interactionId(item, 'unavailable'),
                              requestKey: 'unavailable',
                              task: item,
                              payload: { kind: 'request_user_input' },
                              question: t('interactions.needs_reply'),
                              context: t('interactions.load_failed'),
                              createdAt: new Date(item.task.updatedAt ?? 0).getTime() || 0,
                              answered: false,
                            },
                          ],
                        }
                  )
                }
              }
            }
          })
        )
      } finally {
        fetching.current = false
        if (mounted.current) setLoading(false)
      }
    },
    [acceptancePrefix, archive, t]
  )
  const signature = JSON.stringify(
    source?.items.map(item => [
      item.key,
      item.lifecycle?.interactionStatus,
      item.task.interactionStatus,
      item.task.updatedAt,
    ])
  )
  useEffect(() => {
    void refresh(false)
    const timer = window.setInterval(() => void refresh(false), 5000)
    return () => window.clearInterval(timer)
  }, [refresh, signature, source?.services?.runtimeWorkApi])

  const pending = useMemo(() => {
    const visible = new Map([...inventory, ...(source?.items ?? [])].map(item => [item.key, item]))
    return Object.values(loaded)
      .flat()
      .filter(
        item =>
          !item.answered &&
          !submitted.has(item.id) &&
          visible.has(item.task.key) &&
          (!item.payload.expiresAtUnixMs || item.payload.expiresAtUnixMs > Date.now())
      )
      .map(item => {
        const task = visible.get(item.task.key)!
        return {
          ...item,
          task:
            errors[`inventory:${task.address.deviceId}`] || errors['inventory:']
              ? { ...task, workspace: { ...task.workspace, available: false } }
              : task,
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [errors, inventory, loaded, source?.items, submitted])

  useEffect(() => {
    saveInteractionState(cacheKey, pendingInteractionCache(pending))
  }, [cacheKey, pending])

  const setDraft = useCallback((id: string, text: string) => {
    setDrafts(current => {
      const next = { ...current }
      if (text) next[id] = text
      else delete next[id]
      return next
    })
  }, [])
  const respond = useCallback(
    async (
      item: RuntimeInteraction,
      answer: string,
      clientMessageId?: string
    ): Promise<boolean> => {
      const api = sourceRef.current?.services?.runtimeWorkApi
      if (!api || !answer.trim() || !canReplyToInteraction(item) || inFlight.current.has(item.id))
        return false
      inFlight.current.add(item.id)
      setBusy(new Set(inFlight.current))
      try {
        return await navigator.locks.request(historyKey + ':' + item.id, async () => {
          if (!mounted.current || sourceRef.current?.services?.runtimeWorkApi !== api) return false
          // The request lock and persisted acceptance are shared by every workbench window.
          if (
            submittedRef.current.has(item.id) ||
            localStorage.getItem(acceptancePrefix + item.id) !== null ||
            readInteractionHistory(historyKey).some(row => row.id === item.id)
          ) {
            submittedRef.current = new Set(submittedRef.current).add(item.id)
            setSubmitted(submittedRef.current)
            setDraft(item.id, '')
            setErrors(current => {
              const next = { ...current }
              delete next[item.id]
              return next
            })
            return false
          }
          // Revalidate the exact request before answering; old notifications are not authority.
          const live = (await readRuntimeInteractions(item.task, api)).find(
            row => row.id === item.id && !row.answered
          )
          if (
            !live ||
            !canReplyToInteraction(live) ||
            (live.payload.expiresAtUnixMs && live.payload.expiresAtUnixMs <= Date.now())
          )
            throw new Error(t('interactions.expired'))
          if (!mounted.current || sourceRef.current?.services?.runtimeWorkApi !== api) return false
          const response = interactionResponse(live.payload, {
            [live.payload.questions![0].id!]: { answers: [answer] },
          })
          const previousClient = clientIds.current.get(item.id)
          const id =
            clientMessageId ??
            (previousClient?.answer === answer ? previousClient.id : crypto.randomUUID())
          clientIds.current.set(item.id, { answer, id })
          const message = requestUserInputResponseText(response)
          const asyncInput = isAsyncRequestUserInputPayload(live.payload)
          const result = live.project
            ? await replyToInteractionProject(
                live,
                message,
                id,
                sourceRef.current!.services!,
                t('interactions.failed')
              ).then(() => ({ accepted: true, error: undefined }))
            : asyncInput && (live.running ?? live.task.lifecycle?.turn.active ?? false)
              ? await api.guideRuntimeTask({
                  address: live.task.address,
                  message,
                  clientGuidanceId: id,
                })
              : await api.sendRuntimeMessage(
                  await prepareRuntimeContinuationModel(
                    {
                      address: live.task.address,
                      message,
                      ...(asyncInput
                        ? {
                            queueIfBusy: true,
                          }
                        : { requestUserInputResponse: response }),
                      clientUserMessageId: id,
                    },
                    {
                      projects: [],
                      chats: [{ ...live.task.workspace, tasks: [live.task.task] }],
                      totalTasks: 1,
                    },
                    () => api.listRuntimeWork()
                  )
                )
          const accepted = result.accepted ?? ('success' in result && result.success)
          if (!accepted) throw new Error(result.error || t('notifications.failed'))
          saveInteractionState(acceptancePrefix + item.id, true)
          await archive(item, Date.now())
          if (!mounted.current) return true
          submittedRef.current = new Set(submittedRef.current).add(item.id)
          setSubmitted(submittedRef.current)
          setReplyNotice(t('interactions.reply_success'))
          setDraft(item.id, '')
          setNoticeIds(current => current.filter(id => id !== item.id))
          setErrors(current => {
            const next = { ...current }
            delete next[item.id]
            return next
          })
          // Refresh failure must never turn an accepted answer into a failed send.
          void sourceRef.current?.refresh?.().catch(console.error)
          void refresh()
          return true
        })
      } catch (error) {
        console.error(
          '[Wework] Could not send interaction reply',
          JSON.stringify({
            interactionId: item.id,
            error: error instanceof Error ? error.message : String(error),
          })
        )
        if (mounted.current)
          setErrors(current => ({
            ...current,
            [item.id]:
              error instanceof Error && error.message === t('interactions.expired')
                ? t('interactions.expired')
                : t('interactions.failed'),
          }))
        return false
      } finally {
        inFlight.current.delete(item.id)
        if (mounted.current) setBusy(new Set(inFlight.current))
      }
    },
    [acceptancePrefix, archive, historyKey, refresh, setDraft, t]
  )

  const open = useCallback(
    (id?: string) => {
      const contentRoute = `${INTERACTIONS_PATH}${id ? `?${new URLSearchParams({ interaction: id })}` : ''}`
      const existing = tabs.tabs.find(tab => tab.id === INTERACTIONS_TAB_ID)
      if (existing) tabs.selectTab(existing.id, { contentRoute })
      else
        tabs.openTab('auxiliary', {
          id: INTERACTIONS_TAB_ID,
          title: t('interactions.title'),
          contentRoute,
        })
      setNoticeIds(current => (id ? current.filter(value => value !== id) : []))
    },
    [tabs, t]
  )

  useEffect(() => {
    if (isElectronRuntime() && getDesktopWindowLabel() !== 'main') return
    const records = delivered.getSnapshot()
    const next = { ...records }
    let changed = false
    for (const item of pending) {
      if (records[item.id]) continue
      const alreadyViewed = focused && [...views.current.values()].includes(item.id)
      const origin = item.task.task.runtimeHandle?.origin
      const category =
        item.project ||
        (origin &&
          typeof origin === 'object' &&
          'initiatedBy' in origin &&
          origin.initiatedBy === 'stand_in')
          ? 'collaboration'
          : 'tasks'
      // An inactive window with system notifications disabled has delivered nothing.
      // Keep the request eligible for its in-app reminder when the user returns.
      if (!alreadyViewed && !preferences[category][focused ? 'in_app' : 'system']) continue
      next[item.id] = { version: 'delivered', savedAt: Date.now() }
      changed = true
      if (alreadyViewed) continue
      if (!focused && preferences[category].system) {
        void sendSystemNotification({
          title: item.task.task.title,
          body: item.question,
          url: weworkInteractionScheme(item.task.address, item.requestKey),
          ...(canReplyToInteraction(item) && interactionAllowsNativeReply(item.payload)
            ? {
                reply: {
                  interactionId: item.id,
                  accountKey,
                  placeholder: t('interactions.reply_placeholder'),
                },
              }
            : {}),
        })
      } else if (focused && preferences[category].in_app)
        setNoticeIds(current => (current.includes(item.id) ? current : [...current, item.id]))
    }
    if (changed) delivered.write(next)
  }, [
    accountKey,
    delivered,
    focused,
    pending,
    preferences,
    source?.currentAddress,
    tabs.activeTab,
    t,
  ])

  useEffect(() => {
    if (
      !isElectronRuntime() ||
      getDesktopWindowLabel() !== 'main' ||
      !source?.services?.runtimeWorkApi
    )
      return
    let active = true
    let draining = false
    const drain = async () => {
      if (draining) return
      draining = true
      try {
        const replies = await invokeDesktopHost<
          Array<{ id: string; interactionId: string; text: string }>
        >('notification.pendingReplies', { accountKey })
        for (const reply of replies) {
          if (!active || !mounted.current) return
          if (
            handledNativeReplies.getSnapshot()[reply.id] ||
            submittedRef.current.has(reply.interactionId)
          ) {
            await invokeDesktopHost('notification.acknowledgeReply', { id: reply.id, accountKey })
            continue
          }
          const item = Object.values(loadedRef.current)
            .flat()
            .find(item => item.id === reply.interactionId)
          if (!item || inFlight.current.has(item.id)) continue
          setDraft(item.id, reply.text)
          const accepted = await respond(item, reply.text, reply.id)
          // Accepted sends must be acknowledged even if a refresh replaced this effect.
          // Failed sends remain editable drafts, unless their account has unmounted.
          if (accepted || mounted.current) {
            handledNativeReplies.write({
              ...handledNativeReplies.getSnapshot(),
              [reply.id]: { version: 'handled', savedAt: Date.now() },
            })
            await invokeDesktopHost('notification.acknowledgeReply', { id: reply.id, accountKey })
          }
          if (!active) return
        }
      } catch (error) {
        console.error('[Wework] Could not handle notification reply', error)
      } finally {
        draining = false
      }
    }
    const unsubscribe = subscribeDesktopHostEvents(event => {
      if (event.type === 'notification-reply') void drain()
    })
    void drain()
    const timer = window.setInterval(() => void drain(), 5000)
    return () => {
      window.clearInterval(timer)
      active = false
      unsubscribe()
    }
  }, [
    accountKey,
    handledNativeReplies,
    loaded,
    respond,
    setDraft,
    source?.services?.runtimeWorkApi,
  ])

  const notice = focused
    ? (noticeIds.map(id => pending.find(item => item.id === id)).find(Boolean) ?? null)
    : null
  const dismissNotice = useCallback(
    () => setNoticeIds(current => current.filter(id => id !== notice?.id)),
    [notice?.id]
  )
  const value = useMemo(
    () => ({
      pending,
      history,
      errors,
      drafts,
      busy,
      loading,
      setDraft,
      respond,
      refresh,
      open,
      notice,
      dismissNotice,
      registerView,
    }),
    [
      pending,
      history,
      errors,
      drafts,
      busy,
      loading,
      setDraft,
      respond,
      refresh,
      open,
      notice,
      dismissNotice,
      registerView,
    ]
  )
  useLayoutEffect(() => publish(value), [publish, value])
  return (
    <TransientNotice message={replyNotice} tone="success" onClear={() => setReplyNotice(null)} />
  )
}
