import { useSyncExternalStore } from 'react'

export interface HarnessAppLaunchState {
  installationId: string
  title: string
  status: 'starting' | 'failed'
  error: string | null
  retry: () => void
}

const states = new Map<string, HarnessAppLaunchState>()
const listeners = new Set<() => void>()
let revision = 0

function emit(): void {
  revision += 1
  listeners.forEach(listener => listener())
}

export function beginHarnessAppLaunch(
  installationId: string,
  title: string,
  retry: () => void
): void {
  states.set(installationId, {
    installationId,
    title,
    status: 'starting',
    error: null,
    retry,
  })
  emit()
}

export function failHarnessAppLaunch(installationId: string, error: string): void {
  const current = states.get(installationId)
  if (!current) return
  states.set(installationId, { ...current, status: 'failed', error })
  emit()
}

export function clearHarnessAppLaunch(installationId: string): void {
  if (!states.delete(installationId)) return
  emit()
}

export function harnessAppInstallationIdFromPath(path: string): string | null {
  const match = path.match(/^\/app\/harness-([^/]+)$/)
  return match ? decodeURIComponent(match[1]) : null
}

export function useHarnessAppLaunchState(
  installationId: string | null
): HarnessAppLaunchState | null {
  useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => revision,
    () => revision
  )
  return installationId ? (states.get(installationId) ?? null) : null
}
