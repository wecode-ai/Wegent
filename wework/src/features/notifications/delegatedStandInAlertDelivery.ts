import { buildCollaborationExpScheme } from '@/features/collaboration-exp/integration/deepLinks'
import { createDingTalkMessageCenterApi } from '@/features/todo/dingTalkMessageCenterApi'
import type { MessageCenterRecord } from '@/api/standInMessageCenter'
import { standInDelegationCategory } from '@/features/todo/standInDelegationRecords'
import { sendSystemNotification } from '@/features/workbench/runtimeTaskSystemNotifications'
import { getDesktopWindowLabel } from '@/lib/runtime-environment'
import type { TaskSource } from './NotificationTaskSourceContext'

const POLL_INTERVAL_MS = 15_000

type Observation = {
  source: TaskSource | null
  userId: number | null
  systemEnabled: boolean
  describe(record: MessageCenterRecord): { title: string; body: string }
}

function storageKey(accountKey: string) {
  return `wework.delegated-stand-in-alerts:${accountKey}`
}

function baselineKey(accountKey: string) {
  return `${storageKey(accountKey)}:baseline`
}

function readDelivered(accountKey: string): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(accountKey)) ?? '[]')
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : []
    )
  } catch {
    return new Set()
  }
}

function writeDelivered(accountKey: string, delivered: ReadonlySet<string>) {
  try {
    localStorage.setItem(storageKey(accountKey), JSON.stringify([...delivered]))
  } catch {
    // A blocked local store must not suppress delivery for the current process.
  }
}

function needsDecision(record: MessageCenterRecord) {
  return standInDelegationCategory(record) === 'needs_user' && !record.takenOver
}

/** Alerts for delegated messages that stopped before any runtime conversation existed. */
export function createDelegatedStandInAlertDelivery(accountKey: string) {
  let observation: Observation | undefined
  let observing = false
  let running: symbol | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const delivered = readDelivered(accountKey)
  let baselineReady = localStorage.getItem(baselineKey(accountKey)) === '1'

  const reconcile = async () => {
    const current = observation
    const api = current?.source?.services?.standInApi
    const readIdentity = current?.source?.services?.getLocalRuntimeSidebarIdentity
    const userId = current?.userId
    if (
      !observing ||
      running ||
      !current?.systemEnabled ||
      getDesktopWindowLabel() !== 'main' ||
      !api ||
      !readIdentity ||
      userId == null
    )
      return
    const owner = Symbol()
    running = owner
    let deliveryChanged = false
    try {
      const local = await readIdentity()
      if (!local || !observing || observation !== current) return
      const settings = await api.personalGet(userId, local.deviceId)
      if (settings.executionDeviceId !== local.deviceId) return
      const snapshot = await createDingTalkMessageCenterApi(api).read({
        userId,
        deviceId: local.deviceId,
      })
      const identity = snapshot.identity
      if (!observing || observation !== current || !identity) return
      const decisions = snapshot.records.filter(needsDecision)
      const decisionKey = (record: MessageCenterRecord) =>
        JSON.stringify([identity.id, record.id, record.reason ?? ''])
      if (!baselineReady) {
        for (const record of decisions) delivered.add(decisionKey(record))
        writeDelivered(accountKey, delivered)
        localStorage.setItem(baselineKey(accountKey), '1')
        baselineReady = true
        return
      }
      for (const record of decisions) {
        const key = decisionKey(record)
        if (delivered.has(key)) continue
        const copy = current.describe(record)
        const sent = await sendSystemNotification({
          ...copy,
          url: buildCollaborationExpScheme('', {
            deviceId: local.deviceId,
            userId: String(userId),
          }),
        })
        if (!sent) break
        delivered.add(key)
        deliveryChanged = true
      }
    } catch (error) {
      console.warn('[Stand-in] Delegated message alert check failed', error)
    } finally {
      if (deliveryChanged) writeDelivered(accountKey, delivered)
      if (running === owner) running = undefined
    }
  }

  return {
    observe(next: Observation) {
      observation = next
      observing = true
      if (!timer) {
        timer = setInterval(() => void reconcile(), POLL_INTERVAL_MS)
      }
      void reconcile()
    },
    suspend() {
      observing = false
    },
    release() {
      observing = false
      observation = undefined
      running = undefined
      if (timer) clearInterval(timer)
      timer = undefined
    },
  }
}
