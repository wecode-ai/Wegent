import { useSyncExternalStore } from 'react'
import type { HarnessAppLaunchPhase } from '@/api/local/harnessApps'

export interface HarnessAppLaunchState {
  installationId: string
  title: string
  status: 'starting' | 'failed'
  phase: HarnessAppLaunchPhase
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
  retry: () => void,
  phase: HarnessAppLaunchPhase = 'preparingRuntime'
): void {
  states.set(installationId, {
    installationId,
    title,
    status: 'starting',
    phase,
    error: null,
    retry,
  })
  emit()
}

export function updateHarnessAppLaunchPhase(
  installationId: string,
  phase: HarnessAppLaunchPhase
): void {
  const current = states.get(installationId)
  if (!current || current.status !== 'starting' || current.phase === phase) return
  states.set(installationId, { ...current, phase })
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
