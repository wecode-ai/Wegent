import type PostHog from 'posthog-react-native'
import type { PostHogOptions } from 'posthog-react-native'
import {
  isMobileAnalyticsEventName,
  MOBILE_ANALYTICS_COMMON_PROPERTY_KEYS,
  MOBILE_ANALYTICS_EVENT_PROPERTY_KEYS,
  POSTHOG_TRANSPORT_PROPERTY_KEYS,
  type MobileAnalyticsEventMap,
  type MobileAnalyticsEventName,
} from './events'
import type { MobileTelemetryConfig } from './config'

type CandidateCapture = {
  event: string
  properties?: Record<string, unknown>
  timestamp?: Date
  uuid?: string
}

export interface MobileTelemetryEventProperties {
  [key: string]: string | number | boolean
}

export function sanitizeMobileCapture(event: CandidateCapture): CandidateCapture | null {
  if (!isMobileAnalyticsEventName(event.event)) return null
  const allowedKeys = new Set<string>([
    ...MOBILE_ANALYTICS_COMMON_PROPERTY_KEYS,
    ...POSTHOG_TRANSPORT_PROPERTY_KEYS,
    ...MOBILE_ANALYTICS_EVENT_PROPERTY_KEYS[event.event],
  ])
  const properties = Object.fromEntries(
    Object.entries(event.properties ?? {}).filter(([key]) => allowedKeys.has(key))
  )
  return {
    event: event.event,
    properties,
    timestamp: event.timestamp,
    uuid: event.uuid,
  }
}

export class MobileTelemetryClient {
  private posthog: PostHog | null = null

  async start(
    config: MobileTelemetryConfig,
    distinctId: string,
    commonProperties: MobileTelemetryEventProperties
  ): Promise<void> {
    if (this.posthog) return
    const { default: PostHogClass } = await import('posthog-react-native')
    const client = new PostHogClass(config.posthogKey, {
      host: config.posthogHost,
      bootstrap: { distinctId, isIdentifiedId: false },
      persistence: 'file',
      captureAppLifecycleEvents: false,
      capturePushNotificationOpened: false,
      capturePushNotificationSubscriptions: false,
      enableSessionReplay: false,
      enablePersistSessionIdAcrossRestart: false,
      personProfiles: 'never',
      disableGeoip: true,
      disableRemoteFeatureFlags: true,
      disableSurveys: true,
      preloadFeatureFlags: false,
      sendFeatureFlagEvent: false,
      setDefaultPersonProperties: false,
      flushAt: 20,
      flushInterval: 10_000,
      maxBatchSize: 90,
      maxQueueSize: 500,
      before_send: sanitizeMobileCapture as NonNullable<PostHogOptions['before_send']>,
    })
    try {
      await client.ready()
      await client.register(commonProperties)
      this.posthog = client
    } catch (error) {
      try {
        client.reset()
      } catch {
        // Continue to shutdown so a failed initialization cannot leave timers running.
      }
      try {
        await client._shutdown()
      } catch {
        // Preserve the initialization error that explains why capture is unavailable.
      }
      throw error
    }
  }

  capture<EventName extends MobileAnalyticsEventName>(
    name: EventName,
    properties: MobileAnalyticsEventMap[EventName]
  ): void {
    this.posthog?.capture(name, properties)
  }

  flush(): Promise<void> {
    return this.posthog?.flush() ?? Promise.resolve()
  }

  async stop(): Promise<void> {
    const client = this.posthog
    this.posthog = null
    if (!client) return
    let failure: unknown = null
    try {
      await client.optOut()
    } catch (error) {
      failure = error
    }
    try {
      client.reset()
    } catch (error) {
      failure ??= error
    }
    try {
      await client._shutdown()
    } catch (error) {
      failure ??= error
    }
    if (failure !== null) throw failure
  }
}
