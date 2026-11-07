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
import { useIssueHumanInteractions } from './useIssueHumanInteractions'
import {
  isResolvedIssueQuestion,
  issueQuestionIdentity,
  matchesIssueResolution,
} from './issueHumanInteractions'
import { createIssueQuestionEnricher } from './enrichIssueQuestions'
import {
  interactionResponse,
  interactionId,
  interactionSource,
  interactionOriginalScheme,
  canReplyToInteraction,
  interactionAllowsNativeReply,
  readRuntimeInteractions,
  type RuntimeInteraction,
} from './runtimeInteractions'
import {
  INTERACTIONS_PATH,
  RuntimeInteractionsContext,
  type InteractionHistory,
  type RuntimeInteractionsValue,
} from './RuntimeInteractionsContext'
import { openRuntimeInteractionsTab } from './runtimeInteractionsNavigation'
import { createStandInRecordStore } from './standInNotificationStorage'
import {
  readActiveNotificationPreferences,
  NOTIFICATION_PREFERENCES_CHANGED_EVENT,
} from './notificationPreferences'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { isPersonalStandInTask } from '@/features/workbench/runtimeTaskNotificationContent'
import { weworkInteractionScheme } from './scheme'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { replyToInteractionProject } from './interactionProjectReply'
import { prepareRuntimeContinuationModel } from '@/features/workbench/runtimeContinuationModel'
import { TransientNotice } from '@/components/common/TransientNotice'
import { QuestionDiscussionProvider } from './QuestionDiscussionProvider'
import { readInteractionTaskInventory } from './interactionTaskInventory'
import { logInteractionLoadFailure } from './interactionDiagnostics'
import { persistInteractionArchive } from './interactionArchive'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { isRuntimeConversationArchived } from '@/features/workbench/runtimeConversationCacheStore'
import {
  readInteractionDrafts,
  readInteractionHistory,
  saveInteractionState,
  readPendingInteractionCache,
  pendingInteractionCache,
} from './interactionStorage'

type RuntimeInteractionSnapshot = Omit<RuntimeInteractionsValue, 'drafts' | 'setDraft'>

export function RuntimeInteractionsProvider({
  accountKey,
  children,
}: {
  accountKey: string
  children: ReactNode
}) {
  const [snapshot, setSnapshot] = useState<{
    accountKey: string
    value: RuntimeInteractionSnapshot
  } | null>(null)
  const draftKey = `wework.interactions:${accountKey}:drafts`
  const [draftState, setDraftState] = useState(() => ({
    key: draftKey,
    values: readInteractionDrafts(draftKey),
  }))
  if (draftState.key !== draftKey) {
    setDraftState({ key: draftKey, values: readInteractionDrafts(draftKey) })
  }
  // Controlled inputs must receive edits directly, without the snapshot's
  // effect-driven publication round trip interrupting native IME composition.
  const setDraft = useCallback(
    (id: string, text: string) => {
      setDraftState(current => {
        if (current.key !== draftKey) return current
        const values = { ...current.values }
        if (text) values[id] = text
        else delete values[id]
        return { key: draftKey, values }
      })
    },
    [draftKey]
  )
  useEffect(() => {
    saveInteractionState(draftState.key, draftState.values)
  }, [draftState])
  const publish = useCallback(
    (value: RuntimeInteractionSnapshot) => setSnapshot({ accountKey, value }),
    [accountKey]
  )
  return (
    <RuntimeInteractionsContext.Provider
      value={
        snapshot?.accountKey === accountKey
          ? { ...snapshot.value, drafts: draftState.values, setDraft }
          : null
      }
    >
      {/* Reset only interaction state; connection dialogs and other application UI stay mounted. */}
      <RuntimeInteractionsState
        key={accountKey}
        accountKey={accountKey}
        publish={publish}
        setDraft={setDraft}
      />
      <QuestionDiscussionProvider accountKey={accountKey}>{children}</QuestionDiscussionProvider>
    </RuntimeInteractionsContext.Provider>
  )
}

function RuntimeInteractionsState({
  accountKey,
  publish,
  setDraft,
}: {
  accountKey: string
  publish: (value: RuntimeInteractionSnapshot) => void
  setDraft: RuntimeInteractionsValue['setDraft']
}) {
  const source = useNotificationTaskSource()
  const tabs = useWorkspaceTabs()
  const { t } = useTranslation('common')
  const sourceRef = useRef(source)
  sourceRef.current = source
  const cacheKey = `wework.interactions:${accountKey}:pending`
  const cached = useMemo(() => readPendingInteractionCache(cacheKey), [cacheKey])
  // Shared Issue cache belongs to its inbox, never native Runtime discovery.
  const cachedNative = useMemo(() => cached.filter(item => !item.sharedRequest), [cached])
  const issueInteractions = useIssueHumanInteractions(source?.services, cached)
  const { refresh: refreshIssueInteractions, errors: issueErrors } = issueInteractions
  const issueDiscoveryRef = useRef(issueInteractions)
  issueDiscoveryRef.current = issueInteractions
  const [loaded, setLoaded] = useState<Record<string, RuntimeInteraction[]>>(() => {
    const groups: Record<string, RuntimeInteraction[]> = {}
    for (const item of cachedNative) (groups[item.task.key] ??= []).push(item)
    return groups
  })
  const [inventory, setInventory] = useState<RuntimeTaskReminderItem[]>(() =>
    cachedNative.map(item => item.task)
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
  const reportedOfflineDevices = useRef(new Set<string>())
  const failedArchiveWrites = useRef(new Set<string>())
  const mounted = useRef(true)
  const [loading, setLoading] = useState(false)
  const [replyNotice, setReplyNotice] = useState<string | null>(null)
  const acceptancePrefix = `wework.interactions:${accountKey}:accepted:`
  const historyKey = `wework.interactions:${accountKey}:history`
  const projectItemsSupported = Boolean(
    source?.services?.projectSpaceApis?.local || source?.services?.projectSpaceApis?.cloud
  )
  const [projectCount, setProjectCount] = useState<{ key: string; count: number | null }>({
    key: historyKey,
    count: null,
  })
  const reportProjectPendingCount = useCallback(
    (count: number | null) => {
      setProjectCount(current =>
        current.key === historyKey && current.count === count ? current : { key: historyKey, count }
      )
    },
    [historyKey]
  )
  const [history, setHistory] = useState<InteractionHistory[]>(() =>
    readInteractionHistory(historyKey)
  )
  const [submitted, setSubmitted] = useState<Set<string>>(
    () => new Set(history.filter(item => !item.resolvedIssueQuestion).map(item => item.id))
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

  const archive = useCallback(
    async (
      item: RuntimeInteraction,
      answeredAt = item.createdAt,
      resolvedIssueQuestion?: InteractionHistory['resolvedIssueQuestion']
    ) => {
      await persistInteractionArchive(
        historyKey,
        {
          id: item.id,
          source: interactionSource(item),
          title: item.task.task.title,
          question: item.question,
          address: item.task.address,
          originalUrl: interactionOriginalScheme(item),
          sourceMessageIds: item.sourceMessageIds,
          answeredAt,
          ...(resolvedIssueQuestion ? { resolvedIssueQuestion } : {}),
        },
        failedArchiveWrites.current,
        next => {
          if (mounted.current) {
            setHistory(next)
            if (resolvedIssueQuestion && submittedRef.current.has(item.id)) {
              submittedRef.current = new Set(submittedRef.current)
              submittedRef.current.delete(item.id)
              setSubmitted(submittedRef.current)
            }
          }
        }
      )
    },
    [historyKey]
  )
  const archiveResolved = useCallback(
    (item: RuntimeInteraction) => {
      const questionIdentity = issueQuestionIdentity(item)
      return questionIdentity
        ? archive(item, Date.now(), { questionIdentity, nativeInteractionId: item.id }).catch(
            cause => logInteractionLoadFailure('archive', cause, item.task.address)
          )
        : Promise.resolve()
    },
    [archive]
  )
  useEffect(() => {
    for (const item of issueInteractions.resolved) void archiveResolved(item)
  }, [archiveResolved, issueInteractions.resolved])
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key?.startsWith(acceptancePrefix) && event.newValue !== null) {
        submittedRef.current = new Set(submittedRef.current).add(
          event.key.slice(acceptancePrefix.length)
        )
        setSubmitted(submittedRef.current)
        return
      }
      if (event.key !== historyKey) return
      const next = readInteractionHistory(historyKey)
      setHistory(next)
      const qualified = new Set(
        next.filter(item => item.resolvedIssueQuestion).map(item => item.id)
      )
      submittedRef.current = new Set([
        ...[...submittedRef.current].filter(id => !qualified.has(id)),
        ...next.filter(item => !item.resolvedIssueQuestion).map(item => item.id),
      ])
      setSubmitted(submittedRef.current)
    }
    window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [acceptancePrefix, historyKey])

  const refresh = useCallback(
    async (force = true) => {
      const current = sourceRef.current
      const api = current?.services?.runtimeWorkApi
      if (fetching.current) return
      if (!api) {
        if (force) {
          await issueDiscoveryRef.current.refresh()
          await Promise.all(issueDiscoveryRef.current.resolved.map(archiveResolved))
        } else await issueDiscoveryRef.current.discover()
        return
      }
      if (successfulReadApi.current !== api) {
        successfulReads.current.clear()
        successfulReadApi.current = api
      }
      fetching.current = true
      setLoading(true)
      let stage = 'inventory'
      const diagnosticTimer =
        import.meta.env.VITE_WEWORK_E2E === 'true'
          ? window.setTimeout(() => {
              void navigator.locks
                .query()
                .then(locks =>
                  console.info(
                    '[interaction-refresh-stalled]',
                    JSON.stringify({ window: getDesktopWindowLabel(), stage, locks })
                  )
                )
            }, 5000)
          : undefined
      try {
        if (force) await Promise.all(issueDiscoveryRef.current.resolved.map(archiveResolved))
        const discovered = await readInteractionTaskInventory(current)
        if (!mounted.current || sourceRef.current?.services?.runtimeWorkApi !== api) return
        if (force) await issueDiscoveryRef.current.refresh()
        else await issueDiscoveryRef.current.discover(discovered.localIssueQuestionsPending)
        const retained = inventoryRef.current.filter(
          item => !discovered.refreshedDevices.has(item.address.deviceId)
        )
        const archivedKeys = new Set(
          current.items
            .filter(
              item => item.task.status === 'archived' || isRuntimeConversationArchived(item.address)
            )
            .map(item => item.key)
        )
        const currentItems = current.items.filter(item => !archivedKeys.has(item.key))
        const nextInventory = [
          ...new Map([...retained, ...discovered.items].map(item => [item.key, item])).values(),
        ].filter(
          item =>
            item.task.status !== 'archived' &&
            !archivedKeys.has(item.key) &&
            !isRuntimeConversationArchived(item.address)
        )
        setInventory(nextInventory)
        const failedInventoryDevices = [...discovered.failedDevices].filter(
          deviceId =>
            discovered.failedRequests.has(deviceId) ||
            nextInventory.some(item => item.address.deviceId === deviceId) ||
            currentItems.some(
              item => item.address.deviceId === deviceId && item.task.interactionStatus
            ) ||
            deviceId === ''
        )
        const offlineDevices = new Set(
          failedInventoryDevices.filter(deviceId =>
            current.devices?.some(
              device => device.device_id === deviceId && device.status === 'offline'
            )
          )
        )
        for (const deviceId of offlineDevices) {
          if (!reportedOfflineDevices.current.has(deviceId))
            logInteractionLoadFailure('inventory', 'Device is marked offline', { deviceId })
        }
        reportedOfflineDevices.current = offlineDevices
        // Current sources own membership; cached questions must not resurrect archived tasks.
        const candidates = new Map(
          [...currentItems, ...nextInventory].map(item => [item.key, item])
        )
        const removedErrorKeys = new Set<string>()
        for (const [key, requests] of Object.entries(loadedRef.current)) {
          if (candidates.has(key)) continue
          removedErrorKeys.add(key)
          for (const request of requests) removedErrorKeys.add(request.id)
          successfulReads.current.delete(key)
        }
        setLoaded(value =>
          Object.fromEntries(Object.entries(value).filter(([key]) => candidates.has(key)))
        )
        setErrors(value => {
          const next = Object.fromEntries(
            Object.entries(value).filter(
              ([key]) => !key.startsWith('inventory:') && !removedErrorKeys.has(key)
            )
          )
          for (const deviceId of failedInventoryDevices) {
            next[`inventory:${deviceId}`] = t('interactions.load_failed')
          }
          return next
        })
        // Discovery owns persisted pending state; live sources supply turn identity.
        for (const item of currentItems) {
          const candidate = candidates.get(item.key)
          if (!candidate) continue
          if (item.lifecycle) candidates.set(item.key, { ...candidate, lifecycle: item.lifecycle })
        }
        const items = [...candidates.values()].filter(
          item =>
            (item.lifecycle?.interactionStatus ?? item.task.interactionStatus) ||
            loadedRef.current[item.key]?.some(request => !request.answered)
        )
        // Limit concurrent history reads without blocking unrelated tasks on one failure.
        const enrichQuestions = createIssueQuestionEnricher(
          current.services,
          current.userId,
          () => issueDiscoveryRef.current.items
        )
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
              let operation: 'transcript' | 'archive' = 'transcript'
              try {
                stage = `transcript:${item.address.taskId}`
                const requests = await enrichQuestions(await readRuntimeInteractions(item, api))
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
                  operation = 'archive'
                  stage = `archive:${answered.requestKey}`
                  await archive(answered)
                  localStorage.removeItem(acceptancePrefix + answered.id)
                }
              } catch (error) {
                successfulReads.current.delete(item.key)
                if (!mounted.current) return
                logInteractionLoadFailure(operation, error, {
                  deviceId: item.address.deviceId,
                  taskId: item.address.taskId,
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
        window.clearTimeout(diagnosticTimer)
        fetching.current = false
        if (mounted.current) setLoading(false)
      }
    },
    [acceptancePrefix, archive, archiveResolved, t]
  )
  const signature = JSON.stringify(
    source?.items.map(item => [
      item.key,
      item.task.status,
      item.lifecycle?.interactionStatus,
      item.task.interactionStatus,
      item.task.updatedAt,
      item.lifecycle?.turn.id,
      item.lifecycle?.turn.latestId,
      item.lifecycle?.turn.phase,
    ])
  )
  useEffect(() => {
    void refresh(false)
    const timer = window.setInterval(() => void refresh(false), 5000)
    return () => window.clearInterval(timer)
  }, [refresh, signature, source?.services?.runtimeWorkApi])

  const pending = useMemo(() => {
    const visible = new Map([...(source?.items ?? []), ...inventory].map(item => [item.key, item]))
    const runtime = Object.values(loaded)
      .flat()
      .filter(
        item =>
          !item.answered &&
          !isResolvedIssueQuestion(item, issueInteractions.resolved) &&
          !history.some(
            entry =>
              entry.resolvedIssueQuestion &&
              matchesIssueResolution(item, entry.resolvedIssueQuestion)
          ) &&
          !submitted.has(item.id) &&
          localStorage.getItem(acceptancePrefix + item.id) === null &&
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
    const shared = new Set(issueInteractions.items.map(item => item.id))
    const sharedQuestions = new Set(
      issueInteractions.items.map(issueQuestionIdentity).filter(Boolean)
    )
    const sharedItems = issueInteractions.items.map(item => {
      const identity = issueQuestionIdentity(item)
      const native =
        identity && runtime.find(candidate => issueQuestionIdentity(candidate) === identity)
      return native ? { ...item, source: native.source, task: native.task } : item
    })
    return [
      ...runtime.filter(
        item => !shared.has(item.id) && !sharedQuestions.has(issueQuestionIdentity(item))
      ),
      ...sharedItems,
    ].sort((a, b) => b.createdAt - a.createdAt)
  }, [
    acceptancePrefix,
    errors,
    inventory,
    loaded,
    source?.items,
    submitted,
    issueInteractions.items,
    issueInteractions.resolved,
    history,
  ])

  useEffect(() => {
    saveInteractionState(cacheKey, pendingInteractionCache(pending))
  }, [cacheKey, pending])

  const markHandled = useCallback(
    (id: string) => {
      submittedRef.current = new Set(submittedRef.current).add(id)
      setSubmitted(submittedRef.current)
      setDraft(id, '')
      setNoticeIds(current => current.filter(value => value !== id))
      setErrors(current => {
        const next = { ...current }
        delete next[id]
        return next
      })
    },
    [setDraft]
  )
  const dismiss = useCallback(
    async (item: RuntimeInteraction) => {
      if (item.sharedRequest || inFlight.current.has(item.id)) return
      inFlight.current.add(item.id)
      setBusy(new Set(inFlight.current))
      try {
        await navigator.locks.request(historyKey + ':' + item.id, async () => {
          await archive(item, Date.now())
          saveInteractionState(acceptancePrefix + item.id, true)
          if (!mounted.current) return
          markHandled(item.id)
        })
      } finally {
        inFlight.current.delete(item.id)
        if (mounted.current) setBusy(new Set(inFlight.current))
      }
    },
    [acceptancePrefix, archive, historyKey, markHandled]
  )
  const respond = useCallback(
    async (
      item: RuntimeInteraction,
      answer: string,
      options?: { clientMessageId?: string; send?: () => Promise<boolean> }
    ): Promise<boolean> => {
      const api = sourceRef.current?.services?.runtimeWorkApi
      if (
        (!api && !item.sharedRequest) ||
        !answer.trim() ||
        !canReplyToInteraction(item) ||
        inFlight.current.has(item.id)
      )
        return false
      inFlight.current.add(item.id)
      setBusy(new Set(inFlight.current))
      const confirmedResolved = () =>
        isResolvedIssueQuestion(item, issueDiscoveryRef.current.resolved) ||
        readInteractionHistory(historyKey).some(
          row =>
            row.resolvedIssueQuestion && matchesIssueResolution(item, row.resolvedIssueQuestion)
        )
      const clearHandledDraft = () => {
        setDraft(item.id, '')
        setErrors(current => {
          const next = { ...current }
          delete next[item.id]
          return next
        })
      }
      try {
        if (confirmedResolved()) {
          clearHandledDraft()
          return false
        }
        if (item.sharedRequest) {
          const services = sourceRef.current?.services
          if (!services) return false
          if (options?.send) {
            if (!(await options.send())) throw new Error(t('interactions.failed'))
          } else {
            await replyToInteractionProject(
              item,
              answer,
              options?.clientMessageId ?? crypto.randomUUID(),
              services,
              t('interactions.failed')
            )
          }
          await refreshIssueInteractions()
          void refresh()
          setDraft(item.id, '')
          return true
        }
        if (!api) return false
        return await navigator.locks.request(historyKey + ':' + item.id, async () => {
          if (!mounted.current || sourceRef.current?.services?.runtimeWorkApi !== api) return false
          if (confirmedResolved()) {
            clearHandledDraft()
            return false
          }
          // The request lock and persisted acceptance are shared by every workbench window.
          if (
            submittedRef.current.has(item.id) ||
            localStorage.getItem(acceptancePrefix + item.id) !== null ||
            readInteractionHistory(historyKey).some(
              row => !row.resolvedIssueQuestion && row.id === item.id
            )
          ) {
            submittedRef.current = new Set(submittedRef.current).add(item.id)
            setSubmitted(submittedRef.current)
            clearHandledDraft()
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
            options?.clientMessageId ??
            (previousClient?.answer === answer ? previousClient.id : crypto.randomUUID())
          clientIds.current.set(item.id, { answer, id })
          const message = requestUserInputResponseText(response)
          const asyncInput = isAsyncRequestUserInputPayload(live.payload)
          const result = options?.send
            ? { accepted: await options.send(), error: undefined }
            : live.project
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
          markHandled(item.id)
          setReplyNotice(t('interactions.reply_success'))
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
    [
      acceptancePrefix,
      archive,
      historyKey,
      markHandled,
      refresh,
      setDraft,
      t,
      refreshIssueInteractions,
    ]
  )

  const open = useCallback(
    (id?: string) => {
      const contentRoute = `${INTERACTIONS_PATH}${id ? `?${new URLSearchParams({ interaction: id })}` : ''}`
      openRuntimeInteractionsTab(tabs, t('interactions.title'), contentRoute)
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
      const category = isPersonalStandInTask(item.task)
        ? 'stand_in'
        : interactionSource(item) === 'task'
          ? 'tasks'
          : 'collaboration'
      // An inactive window with system notifications disabled has delivered nothing.
      // Keep the request eligible for its in-app reminder when the user returns.
      const systemAvailable = isElectronRuntime() && preferences[category].system
      if (!alreadyViewed && !(focused ? preferences[category].in_app : systemAvailable)) continue
      next[item.id] = { version: 'delivered', savedAt: Date.now() }
      changed = true
      if (alreadyViewed) continue
      if (!focused && systemAvailable) {
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
          const item = [
            ...Object.values(loadedRef.current).flat(),
            ...issueInteractions.items,
          ].find(item => item.id === reply.interactionId)
          // Cached entries cannot authorize a response; leave the host reply queued.
          if (!item || item.cached || inFlight.current.has(item.id)) continue
          setDraft(item.id, reply.text)
          const accepted = await respond(item, reply.text, { clientMessageId: reply.id })
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
    issueInteractions.items,
    respond,
    setDraft,
    source?.services?.runtimeWorkApi,
  ])

  const notice = noticeIds.map(id => pending.find(item => item.id === id)).find(Boolean) ?? null
  useEffect(() => {
    if (import.meta.env.VITE_WEWORK_E2E === 'true')
      console.info(
        '[interaction-focus-state]',
        JSON.stringify({ focused, pendingIds: pending.map(item => item.id), noticeIds })
      )
  }, [focused, pending, noticeIds])
  const dismissNotice = useCallback(
    () => setNoticeIds(current => current.filter(id => id !== notice?.id)),
    [notice?.id]
  )
  const value = useMemo(
    () => ({
      pending,
      projectItemsSupported,
      pendingProjectCount: projectCount.key === historyKey ? projectCount.count : null,
      reportProjectPendingCount,
      history,
      errors: { ...errors, ...issueErrors },
      busy,
      loading,
      respond,
      dismiss,
      refresh,
      open,
      notice,
      dismissNotice,
      registerView,
    }),
    [
      pending,
      projectItemsSupported,
      projectCount,
      historyKey,
      reportProjectPendingCount,
      history,
      errors,
      issueErrors,
      busy,
      loading,
      respond,
      dismiss,
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
