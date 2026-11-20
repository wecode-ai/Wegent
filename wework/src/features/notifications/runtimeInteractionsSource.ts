import { createRuntimeInteractionSettlements } from './runtimeInteractionSettlements'
import { createNativeInteractionReplies } from './nativeInteractionReplies'
import { selectPendingRuntimeInteractions } from './runtimeInteractionsProjection'
import { createRuntimeInteractionInboxState } from './runtimeInteractionInboxState'
import type { SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import {
  isAsyncRequestUserInputPayload,
  requestUserInputResponseText,
  requestUserInputResponseAttachments,
} from '@wegent/chat-core/runtime-user-input'
import type { RequestUserInputResponse } from '@wegent/chat-core/runtime'
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/desktop/windowFocus'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { TaskSource } from './NotificationTaskSourceContext'
import {
  isResolvedIssueQuestion,
  issueQuestionIdentity,
  issueQuestionHandoff,
  hasRecordedIssueResolution,
} from './issueHumanInteractions'
import { createIssueQuestionEnricher } from './enrichIssueQuestions'
import {
  interactionResponse,
  interactionId,
  interactionSource,
  canReplyToInteraction,
  interactionAllowsNativeReply,
  readRuntimeInteractions,
  type RuntimeInteraction,
} from './runtimeInteractions'
import {
  INTERACTIONS_PATH,
  type InteractionHistory,
  type RuntimeInteractionsValue,
} from './RuntimeInteractionsContext'
import { openRuntimeInteractionsTab } from './runtimeInteractionsNavigation'
import { createStandInRecordStore } from './standInNotificationStorage'
import { readActiveNotificationPreferences } from './notificationPreferences'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { isPersonalStandInTask } from '@/features/workbench/runtimeTaskNotificationContent'
import { weworkInteractionScheme } from './scheme'
import { replyToInteractionProject } from './interactionProjectReply'
import { prepareRuntimeQuestionResponse } from '@/features/workbench/useWorkbenchRuntimeMessaging'
import { prepareRuntimeContinuationModel } from '@/features/workbench/runtimeContinuationModel'
import { readInteractionTaskInventory } from './interactionTaskInventory'
import { logInteractionLoadFailure } from './interactionDiagnostics'
import { interactionHistoryEntry, persistInteractionArchive } from './interactionArchive'
import type { useInteractionDrafts } from './useInteractionDrafts'
import type { RuntimeTaskReminderItem } from '@/features/workbench/runtimeTaskReminders'
import { isRuntimeConversationArchived } from '@/features/workbench/runtimeConversationCacheStore'
import {
  readInteractionHistory,
  readInteractionDismissal,
  saveInteractionState,
  pendingInteractionCache,
} from './interactionStorage'

type InteractionSnapshot = Omit<
  RuntimeInteractionsValue,
  'drafts' | 'replyDrafts' | 'setDraft' | 'discardDraft'
>
interface InteractionSourceOptions {
  source: TaskSource | null
  tabs: WorkspaceTabsContextValue
  t: TFunction
  setDraft: RuntimeInteractionsValue['setDraft']
  retainDraft: ReturnType<typeof useInteractionDrafts>['retainDraft']
  retainedReply: ReturnType<typeof useInteractionDrafts>['retainedReply']
}

/** One account owns discovery, acceptance locks, cached questions and notification delivery. */
export function createRuntimeInteractionsSource(
  accountKey: string,
  cached: RuntimeInteraction[],
  initialOptions: InteractionSourceOptions
) {
  let context = initialOptions
  const inbox = createRuntimeInteractionInboxState(context.source?.services, cached)
  let inboxSnapshot = inbox.getSnapshot()
  let issueDiscovery = { ...inboxSnapshot, refresh: inbox.refresh, discover: inbox.discover }
  let stopInbox: (() => void) | undefined
  const cacheKey = `wework.interactions:${accountKey}:pending`
  const acceptancePrefix = `wework.interactions:${accountKey}:accepted:`
  const historyKey = `wework.interactions:${accountKey}:history`
  const cachedNative = cached.filter(item => !item.sharedRequest)
  let loaded: Record<string, RuntimeInteraction[]> = {}
  for (const item of cachedNative) (loaded[item.task.key] ??= []).push(item)
  let inventory: RuntimeTaskReminderItem[] = cachedNative.map(item => item.task)
  let errors: Record<string, string> = {}
  let busy = new Set<string>()
  const inFlight = new Set<string>()
  const clientIds = new Map<string, { answer: string; id: string }>()
  const successfulReads = new Map<string, { signature: string; readAt: number }>()
  let successfulReadApi = context.source?.services?.runtimeWorkApi
  let fetching = false
  let reportedOfflineDevices = new Set<string>()
  let loading = false
  let replyNotice: string | null = null
  let projectCount = { key: historyKey, count: null as number | null }
  let history = readInteractionHistory(historyKey)
  let submitted = new Set(history.filter(item => !item.resolvedIssueQuestion).map(item => item.id))
  const delivered = createStandInRecordStore(`wework.interactions:${accountKey}:delivered`)
  let noticeIds: string[] = []
  let focused = isMainWindowFocused()
  let preferences = readActiveNotificationPreferences()
  const views = new Map<string, string>()
  const listeners = new Set<() => void>()
  const active = () => listeners.size > 0
  const update = <T>(value: SetStateAction<T>, previous: T): T =>
    typeof value === 'function' ? (value as (previous: T) => T)(previous) : value
  const setLoaded = (value: SetStateAction<typeof loaded>) => {
    const next = update(value, loaded)
    loaded = next
    publish()
  }
  const setInventory = (value: SetStateAction<typeof inventory>) => {
    const next = update(value, inventory)
    inventory = next
    publish()
  }
  const setErrors = (value: SetStateAction<typeof errors>) => {
    const next = update(value, errors)
    errors = next
    publish()
  }
  const setBusy = (value: SetStateAction<typeof busy>) => {
    const next = update(value, busy)
    busy = next
    publish()
  }
  const setLoading = (value: SetStateAction<typeof loading>) => {
    const next = update(value, loading)
    loading = next
    publish()
  }
  const setReplyNotice = (value: SetStateAction<typeof replyNotice>) => {
    const next = update(value, replyNotice)
    replyNotice = next
    publish()
  }
  const setProjectCount = (value: SetStateAction<typeof projectCount>) => {
    const next = update(value, projectCount)
    projectCount = next
    publish()
  }
  const setHistory = (value: SetStateAction<typeof history>) => {
    const next = update(value, history)
    history = next
    publish()
  }
  const setSubmitted = (value: SetStateAction<typeof submitted>) => {
    const next = update(value, submitted)
    submitted = next
    publish()
  }
  const setNoticeIds = (value: SetStateAction<typeof noticeIds>) => {
    const next = update(value, noticeIds)
    if (next === noticeIds) return
    noticeIds = next
    publish()
  }
  const setFocused = (value: SetStateAction<typeof focused>) => {
    const next = update(value, focused)
    if (next === focused) return
    focused = next
    publish()
  }
  const setPreferences = (value: SetStateAction<typeof preferences>) => {
    const next = update(value, preferences)
    if (next === preferences) return
    preferences = next
    publish()
  }

  const reportProjectPendingCount = (count: number | null) => {
    setProjectCount(current =>
      current.key === historyKey && current.count === count ? current : { key: historyKey, count }
    )
  }

  const registerView = (owner: string, id: string | null) => {
    if (id) {
      views.set(owner, id)
    } else views.delete(owner)
  }

  const archive = async (
    item: RuntimeInteraction | InteractionHistory,
    answeredAt = 'task' in item ? item.createdAt : item.answeredAt,
    resolvedIssueQuestion?: InteractionHistory['resolvedIssueQuestion']
  ) => {
    await persistInteractionArchive(
      historyKey,
      {
        ...('task' in item ? interactionHistoryEntry(item, answeredAt) : { ...item, answeredAt }),
        ...(resolvedIssueQuestion ? { resolvedIssueQuestion } : {}),
      },
      next => {
        if (active()) {
          setHistory(next)
          if (resolvedIssueQuestion && submitted.has(item.id)) {
            submitted = new Set(submitted)
            submitted.delete(item.id)
            setSubmitted(submitted)
          }
        }
      }
    )
  }

  const archiveResolved = (item: RuntimeInteraction) => {
    const questionIdentity = issueQuestionIdentity(item)
    return questionIdentity
      ? archive(item, Date.now(), { questionIdentity, nativeInteractionId: item.id }).catch(cause =>
          logInteractionLoadFailure('archive', cause, item.task.address)
        )
      : Promise.resolve()
  }

  const refresh = async (force = true) => {
    if (!active()) return
    const current = context.source
    const api = current?.services?.runtimeWorkApi
    if (fetching) return
    if (!api) {
      if (force) {
        await issueDiscovery.refresh()
        await Promise.all(issueDiscovery.resolved.map(archiveResolved))
      } else await issueDiscovery.discover()
      return
    }
    if (successfulReadApi !== api) {
      successfulReads.clear()
      successfulReadApi = api
    }
    fetching = true
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
      if (force) await Promise.all(issueDiscovery.resolved.map(archiveResolved))
      const discovered = await readInteractionTaskInventory(current)
      if (!active() || context.source?.services?.runtimeWorkApi !== api) return
      if (force) await issueDiscovery.refresh()
      else await issueDiscovery.discover(discovered.localIssueQuestionsPending)
      const retained = inventory.filter(
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
        if (!reportedOfflineDevices.has(deviceId))
          logInteractionLoadFailure('inventory', 'Device is marked offline', { deviceId })
      }
      reportedOfflineDevices = offlineDevices
      // Current sources own membership; cached questions must not resurrect archived tasks.
      const candidates = new Map([...currentItems, ...nextInventory].map(item => [item.key, item]))
      const removedErrorKeys = new Set<string>()
      for (const [key, requests] of Object.entries(loaded)) {
        if (candidates.has(key)) continue
        removedErrorKeys.add(key)
        for (const request of requests) removedErrorKeys.add(request.id)
        successfulReads.delete(key)
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
          next[`inventory:${deviceId}`] = context.t('interactions.load_failed')
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
          loaded[item.key]?.some(request => !request.answered)
      )
      // Limit concurrent history reads without blocking unrelated tasks on one failure.
      const enrichQuestions = createIssueQuestionEnricher(
        current.services,
        current.userId,
        () => issueDiscovery.items
      )
      let index = 0
      await Promise.all(
        Array.from({ length: Math.min(4, items.length) }, async () => {
          while (index < items.length) {
            const item = items[index++]
            if (
              discovered.failedDevices.has(item.address.deviceId) ||
              discovered.failedDevices.has('') ||
              (loaded[item.key]?.some(request => request.cached) &&
                !discovered.refreshedDevices.has(item.address.deviceId))
            ) {
              successfulReads.delete(item.key)
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
            const previousRead = successfulReads.get(item.key)
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
              if (!active() || context.source?.services?.runtimeWorkApi !== api) return
              successfulReads.set(item.key, {
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
                await context.retainDraft(interactionHistoryEntry(answered, answered.createdAt))
                await archive(answered)
                if (!readInteractionDismissal(acceptancePrefix + answered.id))
                  localStorage.removeItem(acceptancePrefix + answered.id)
              }
            } catch (error) {
              successfulReads.delete(item.key)
              if (!active()) return
              logInteractionLoadFailure(operation, error, {
                deviceId: item.address.deviceId,
                taskId: item.address.taskId,
              })
              setErrors(value => ({ ...value, [item.key]: context.t('interactions.load_failed') }))
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
                            question: context.t('interactions.needs_reply'),
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
      fetching = false
      if (active()) setLoading(false)
    }
  }

  const isDismissed = (id: string, questionIdentity?: string | null, handoff?: string) =>
    history.some(
      entry =>
        entry.dismissed &&
        (questionIdentity
          ? entry.dismissedQuestionIdentity === questionIdentity &&
            (handoff === undefined || (entry.dismissedHandoff ?? 'initial') === handoff)
          : entry.id === id)
    ) ||
    readInteractionDismissal(
      acceptancePrefix +
        (questionIdentity
          ? `issue:${handoff === undefined ? questionIdentity : JSON.stringify([questionIdentity, handoff])}`
          : id)
    )

  const clearReplyDraft = (id: string) => {
    context.setDraft(id, '')
    setErrors(current => {
      const next = { ...current }
      delete next[id]
      return next
    })
  }

  const markHandled = (id: string) => {
    submitted = new Set(submitted).add(id)
    setSubmitted(submitted)
    setNoticeIds(current => current.filter(value => value !== id))
  }

  const settleFromConversation = (item: RuntimeInteraction) =>
    navigator.locks.request(historyKey + ':' + item.id, async () => {
      await context.retainDraft(interactionHistoryEntry(item, Date.now()))
      await archive(item, Date.now())
      saveInteractionState(acceptancePrefix + item.id, true)
      // A task answer settles the question, not another sender's unsent text.
      if (active()) markHandled(item.id)
    })

  const dismiss = async (item: RuntimeInteraction | InteractionHistory) => {
    if (!active()) return
    if (inFlight.has(item.id)) return
    inFlight.add(item.id)
    setBusy(new Set(inFlight))
    try {
      await navigator.locks.request(historyKey + ':' + item.id, async () => {
        const handledAt = Date.now()
        const questionIdentity =
          'task' in item ? issueQuestionIdentity(item) : item.dismissedQuestionIdentity
        const handoff =
          'task' in item
            ? (issueQuestionHandoff(
                issueDiscovery.items.find(
                  candidate =>
                    questionIdentity && issueQuestionIdentity(candidate) === questionIdentity
                ) ?? item
              ) ?? 'initial')
            : (item.dismissedHandoff ?? 'initial')
        await archive(
          {
            ...('task' in item ? interactionHistoryEntry(item, handledAt) : item),
            dismissed: true,
            ...(questionIdentity
              ? { dismissedQuestionIdentity: questionIdentity, dismissedHandoff: handoff }
              : {}),
          },
          handledAt
        )
        saveInteractionState(acceptancePrefix + item.id, 'dismissed')
        if (questionIdentity) {
          saveInteractionState(acceptancePrefix + `issue:${questionIdentity}`, 'dismissed')
          saveInteractionState(
            acceptancePrefix + `issue:${JSON.stringify([questionIdentity, handoff])}`,
            'dismissed'
          )
        }
        if (!active()) return
        markHandled(item.id)
        clearReplyDraft(item.id)
      })
    } finally {
      inFlight.delete(item.id)
      if (active()) setBusy(new Set(inFlight))
    }
  }

  const respond = async (
    item: RuntimeInteraction,
    answer: string,
    options?: {
      clientMessageId?: string
      send?: () => Promise<boolean>
      response?: RequestUserInputResponse
    }
  ): Promise<boolean> => {
    if (!active()) return false
    const api = context.source?.services?.runtimeWorkApi
    if (
      (!api && !item.sharedRequest) ||
      (!answer.trim() &&
        (!options?.response || !requestUserInputResponseAttachments(options.response).length)) ||
      !canReplyToInteraction(item) ||
      inFlight.has(item.id)
    )
      return false
    inFlight.add(item.id)
    setBusy(new Set(inFlight))
    const confirmedResolved = () =>
      isResolvedIssueQuestion(item, issueDiscovery.resolved) ||
      hasRecordedIssueResolution(item, readInteractionHistory(historyKey))
    try {
      if (confirmedResolved()) {
        await context.retainDraft(interactionHistoryEntry(item, Date.now())).catch(console.error)
        return false
      }
      if (item.sharedRequest) {
        const services = context.source?.services
        if (!services) return false
        if (options?.send) {
          if (!(await options.send())) throw new Error(context.t('interactions.failed'))
        } else {
          await replyToInteractionProject(
            item,
            answer,
            options?.clientMessageId ?? crypto.randomUUID(),
            services,
            context.t('interactions.failed'),
            options?.response ? requestUserInputResponseAttachments(options.response) : []
          )
        }
        await issueDiscovery.refresh()
        void refresh()
        context.setDraft(item.id, '')
        return true
      }
      if (!api) return false
      return await navigator.locks.request(historyKey + ':' + item.id, async () => {
        if (!active() || context.source?.services?.runtimeWorkApi !== api) return false
        if (confirmedResolved()) {
          await context.retainDraft(interactionHistoryEntry(item, Date.now())).catch(console.error)
          return false
        }
        // The request lock and persisted acceptance are shared by every workbench window.
        if (
          submitted.has(item.id) ||
          localStorage.getItem(acceptancePrefix + item.id) !== null ||
          readInteractionHistory(historyKey).some(
            row => !row.resolvedIssueQuestion && row.id === item.id
          )
        ) {
          submitted = new Set(submitted).add(item.id)
          setSubmitted(submitted)
          await context.retainDraft(interactionHistoryEntry(item, Date.now())).catch(console.error)
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
          throw new Error(context.t('interactions.expired'))
        if (!active() || context.source?.services?.runtimeWorkApi !== api) return false
        const asyncInput = isAsyncRequestUserInputPayload(live.payload)
        const originalResponse = {
          ...(options?.response ??
            interactionResponse(live.payload, {
              [live.payload.questions![0].id!]: { answers: [answer] },
            })),
          ...(asyncInput ? { delivery: 'async' as const } : {}),
        }
        const response = live.project
          ? originalResponse
          : await prepareRuntimeQuestionResponse(
              originalResponse,
              live.task.address.deviceId,
              context.source?.devices ?? [],
              context.source?.services?.attachmentApi?.uploadLocalAttachmentToCloud
            )
        if (!active() || context.source?.services?.runtimeWorkApi !== api) return false
        const previousClient = clientIds.get(item.id)
        const id =
          options?.clientMessageId ??
          (previousClient?.answer === answer ? previousClient.id : crypto.randomUUID())
        clientIds.set(item.id, { answer, id })
        const message = requestUserInputResponseText(response)
        const attachments = requestUserInputResponseAttachments(response)
        const runtimePayload =
          !options?.send && !live.project
            ? await prepareRuntimeContinuationModel(
                {
                  address: live.task.address,
                  message,
                  ...(attachments.length ? { attachments } : {}),
                  ...(asyncInput ? { queueIfBusy: true } : {}),
                  requestUserInputResponse: response,
                  clientUserMessageId: id,
                },
                {
                  projects: [],
                  chats: [{ ...live.task.workspace, tasks: [live.task.task] }],
                  totalTasks: 1,
                },
                () => api.listRuntimeWork()
              )
            : undefined
        if (!active() || context.source?.services?.runtimeWorkApi !== api) return false
        const result = options?.send
          ? { accepted: await options.send(), error: undefined }
          : live.project
            ? await replyToInteractionProject(
                live,
                message,
                id,
                context.source!.services!,
                context.t('interactions.failed'),
                attachments
              ).then(() => ({ accepted: true, error: undefined }))
            : await api.sendRuntimeMessage(runtimePayload!)
        const accepted = result.accepted ?? ('success' in result && result.success)
        if (!accepted) throw new Error(result.error || context.t('notifications.failed'))
        saveInteractionState(acceptancePrefix + item.id, true)
        // Delivery is already accepted. Archive failure must never reclassify it as unsent.
        await archive(item, Date.now()).catch(error =>
          logInteractionLoadFailure('archive', error, item.task.address)
        )
        if (!active()) return true
        markHandled(item.id)
        clearReplyDraft(item.id)
        setReplyNotice(context.t('interactions.reply_success'))
        // Refresh failure must never turn an accepted answer into a failed send.
        void context.source?.refresh?.().catch(console.error)
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
      if (active())
        setErrors(current => ({
          ...current,
          [item.id]:
            error instanceof Error && error.message === context.t('interactions.expired')
              ? context.t('interactions.expired')
              : context.t('interactions.failed'),
        }))
      return false
    } finally {
      inFlight.delete(item.id)
      if (active()) setBusy(new Set(inFlight))
    }
  }

  const open = (id?: string) => {
    const contentRoute = `${INTERACTIONS_PATH}${id ? `?${new URLSearchParams({ interaction: id })}` : ''}`
    openRuntimeInteractionsTab(context.tabs, context.t('interactions.title'), contentRoute)
  }

  const isHandled = (id: string) =>
    submitted.has(id) || localStorage.getItem(acceptancePrefix + id) !== null

  const isBusy = (id: string) => inFlight.has(id)

  const dismissNotice = () => setNoticeIds(current => current.filter(id => id !== notice?.id))

  const computePending = () =>
    selectPendingRuntimeInteractions({
      source: context.source,
      inventory,
      loaded,
      errors,
      submitted,
      history,
      issueInteractions: issueDiscovery,
      acceptancePrefix,
      isDismissed,
    })
  const deliverNotices = () => {
    if (isElectronRuntime() && getDesktopWindowLabel() !== 'main') return
    const records = delivered.getSnapshot()
    const next = { ...records }
    let changed = false
    for (const item of pending) {
      if (records[item.id]) continue
      const alreadyViewed = focused && [...views.values()].includes(item.id)
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
                  placeholder: context.t('interactions.reply_placeholder'),
                },
              }
            : {}),
        })
      } else if (focused && preferences[category].in_app)
        setNoticeIds(current => (current.includes(item.id) ? current : [...current, item.id]))
    }
    if (changed) delivered.write(next)
  }
  const logFocusState = () => {
    if (import.meta.env.VITE_WEWORK_E2E === 'true')
      console.info(
        '[interaction-focus-state]',
        JSON.stringify({ focused, pendingIds: pending.map(item => item.id), noticeIds })
      )
  }
  const handleStorage = (event: StorageEvent) => {
    if (!active()) return
    if (event.key?.startsWith(acceptancePrefix) && event.newValue !== null) {
      submitted = new Set(submitted).add(event.key.slice(acceptancePrefix.length))
      setSubmitted(submitted)
      return
    }
    if (event.key !== historyKey) return
    const next = readInteractionHistory(historyKey)
    setHistory(next)
    const qualified = new Set(next.filter(item => item.resolvedIssueQuestion).map(item => item.id))
    submitted = new Set([
      ...[...submitted].filter(id => !qualified.has(id)),
      ...next.filter(item => !item.resolvedIssueQuestion).map(item => item.id),
    ])
    setSubmitted(submitted)
  }

  let pending: RuntimeInteraction[] = []
  let pendingInputs: unknown[] = []
  let persistedPending: RuntimeInteraction[] | undefined
  let nativeItems: RuntimeInteraction[] = []
  let nativeInputs: unknown[] = []
  let notice: RuntimeInteraction | null = null
  let value: InteractionSnapshot | undefined
  let valueInputs: unknown[] = []
  let notificationInputs: unknown[] = []
  let debugInputs: unknown[] = []
  let notificationTimer: ReturnType<typeof setTimeout> | undefined
  let discoveryTimer: ReturnType<typeof setInterval> | undefined
  let stopFocus: (() => void) | undefined
  let lastSignature: string | undefined
  let lastApi: typeof successfulReadApi
  let lastResolved: RuntimeInteraction[] | undefined
  let lastTranslation: InteractionSourceOptions['t'] | undefined
  let lastRetainDraft: InteractionSourceOptions['retainDraft'] | undefined
  const changed = (previous: unknown[], next: unknown[]) =>
    previous.length !== next.length || next.some((item, index) => item !== previous[index])
  function buildSnapshot(): RuntimeInteractionSourceSnapshot {
    if (inboxSnapshot !== inbox.getSnapshot()) {
      inboxSnapshot = inbox.getSnapshot()
      issueDiscovery = { ...inboxSnapshot, refresh: inbox.refresh, discover: inbox.discover }
    }
    const nextPendingInputs = [
      errors,
      inventory,
      loaded,
      context.source?.items,
      submitted,
      issueDiscovery.items,
      issueDiscovery.resolved,
      history,
    ]
    if (changed(pendingInputs, nextPendingInputs)) {
      pendingInputs = nextPendingInputs
      pending = computePending()
    }
    const nextNativeInputs = [loaded, issueDiscovery.items]
    if (changed(nativeInputs, nextNativeInputs)) {
      nativeInputs = nextNativeInputs
      nativeItems = [...Object.values(loaded).flat(), ...issueDiscovery.items]
    }
    notice = noticeIds.map(id => pending.find(item => item.id === id)).find(Boolean) ?? null
    const projectItemsSupported = Boolean(
      context.source?.services?.projectSpaceApis?.local ||
      context.source?.services?.projectSpaceApis?.cloud
    )
    const nextValueInputs = [
      pending,
      projectItemsSupported,
      projectCount,
      history,
      errors,
      issueDiscovery.errors,
      busy,
      loading,
      notice,
    ]
    if (!value || changed(valueInputs, nextValueInputs)) {
      valueInputs = nextValueInputs
      value = {
        pending,
        projectItemsSupported,
        pendingProjectCount: projectCount.key === historyKey ? projectCount.count : null,
        reportProjectPendingCount,
        history,
        errors: { ...errors, ...issueDiscovery.errors },
        busy,
        loading,
        respond,
        dismiss,
        isDismissed,
        refresh,
        open,
        notice,
        dismissNotice,
        registerView,
      }
    }
    return { value, replyNotice, nativeItems }
  }
  let snapshot = buildSnapshot()
  const nativeReplies = createNativeInteractionReplies(accountKey, {
    active,
    enabled: () => Boolean(context.source?.services?.runtimeWorkApi),
    items: () => snapshot.nativeItems,
    isHandled,
    isBusy,
    respond,
    setDraft: (id, text) => context.setDraft(id, text),
    retainDraft: (item, reply) => context.retainDraft(item, reply),
    retainedReply: id => context.retainedReply(id),
  })
  const settlements = createRuntimeInteractionSettlements({
    active,
    pending: () => pending,
    settle: settleFromConversation,
  })
  function publish() {
    const previousNativeItems = snapshot.nativeItems
    snapshot = buildSnapshot()
    if (!active()) return
    if (persistedPending !== pending) {
      persistedPending = pending
      saveInteractionState(cacheKey, pendingInteractionCache(pending))
    }
    listeners.forEach(listener => listener())
    settlements.synchronize()
    nativeReplies.synchronize(previousNativeItems !== snapshot.nativeItems)
    if (lastResolved !== issueDiscovery.resolved) {
      lastResolved = issueDiscovery.resolved
      for (const item of lastResolved) void archiveResolved(item)
    }
    const nextNotifications = [
      pending,
      focused,
      preferences,
      context.source?.currentAddress,
      context.tabs.activeTab,
      context.t,
    ]
    if (changed(notificationInputs, nextNotifications)) {
      notificationInputs = nextNotifications
      clearTimeout(notificationTimer)
      // Publish request data before delivering; the displayed page commits its viewed lease first.
      notificationTimer = setTimeout(() => {
        if (active()) deliverNotices()
      }, 0)
    }
    const nextDebug = [focused, pending, noticeIds]
    if (changed(debugInputs, nextDebug)) {
      debugInputs = nextDebug
      logFocusState()
    }
  }
  const discoverySignature = () =>
    JSON.stringify(
      context.source?.items.map(item => [
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
  const stop = () => {
    nativeReplies.disconnect()
    settlements.disconnect()
    stopInbox?.()
    stopInbox = undefined
    stopFocus?.()
    stopFocus = undefined
    clearInterval(discoveryTimer)
    discoveryTimer = undefined
    clearTimeout(notificationTimer)
    notificationTimer = undefined
    lastSignature = undefined
    lastTranslation = undefined
    lastRetainDraft = undefined
  }
  let observation:
    | { options: InteractionSourceOptions; binding: RuntimeInteractionObservation }
    | undefined
  const equalOptions = (left: InteractionSourceOptions, right: InteractionSourceOptions) =>
    left.source === right.source &&
    left.tabs === right.tabs &&
    left.t === right.t &&
    left.setDraft === right.setDraft &&
    left.retainDraft === right.retainDraft &&
    left.retainedReply === right.retainedReply
  return {
    observe(next: InteractionSourceOptions): RuntimeInteractionObservation {
      if (observation && equalOptions(observation.options, next)) return observation.binding
      const binding = {
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) {
          context = next
          listeners.add(listener)
          inbox.configure(context.source?.services)
          if (!stopInbox) stopInbox = inbox.subscribe(publish)
          if (!stopFocus) stopFocus = subscribeMainWindowFocus(setFocused)
          if (!discoveryTimer) discoveryTimer = setInterval(() => void refresh(false), 5000)
          publish()
          const signature = discoverySignature()
          const api = context.source?.services?.runtimeWorkApi
          if (
            lastSignature !== signature ||
            lastApi !== api ||
            lastTranslation !== context.t ||
            lastRetainDraft !== context.retainDraft
          ) {
            lastSignature = signature
            lastApi = api
            lastTranslation = context.t
            lastRetainDraft = context.retainDraft
            void refresh(false)
          }
          return () => {
            listeners.delete(listener)
            queueMicrotask(() => {
              if (!active()) stop()
            })
          }
        },
      }
      observation = { options: next, binding }
      return binding
    },
    handleStorage,
    refreshPreferences: () => setPreferences(readActiveNotificationPreferences()),
    clearReplyNotice: () => setReplyNotice(null),
  }
}

interface RuntimeInteractionSourceSnapshot {
  value: InteractionSnapshot
  replyNotice: string | null
  nativeItems: RuntimeInteraction[]
}
interface RuntimeInteractionObservation {
  getSnapshot(): RuntimeInteractionSourceSnapshot
  subscribe(listener: () => void): () => void
}
