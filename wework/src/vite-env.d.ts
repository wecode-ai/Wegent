/// <reference types="vite/client" />

declare const __WEWORK_APP_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_WEWORK_POSTHOG_HOST?: string
  readonly VITE_WEWORK_POSTHOG_KEY?: string
  readonly VITE_WEWORK_RELEASE_CHANNEL?: string
  readonly VITE_WEWORK_SENTRY_DSN?: string
  readonly VITE_WEWORK_SENTRY_TRACES_SAMPLE_RATE?: string
  readonly VITE_WEWORK_TELEMETRY_ENVIRONMENT?: string
}
