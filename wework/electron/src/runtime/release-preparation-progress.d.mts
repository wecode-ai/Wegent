import type { ChildProcess } from 'node:child_process'

export const RELEASE_PREPARATION_PHASE_TIMEOUT_MS: number
export const RELEASE_PREPARATION_PROGRESS_PREFIX: string

interface PreparationProgress {
  phase: string
  downloadedBytes?: number
  failure?: { message?: string }
}

interface PreparationTiming {
  phaseTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

type PreparationProcess<T> = Promise<T> & { child: ChildProcess }
type StopPreparation = (child: ChildProcess) => Promise<void>

export function spawnReleaseProcess(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; maxBuffer?: number }
): PreparationProcess<{ stdout: string; stderr: string }>

export function prepareReleaseProcess(
  executable: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    progress: 'stdout' | { logPath: string }
    releaseId: string
    version: string
    stop: StopPreparation
  }
): PreparationProcess<{ stdout: string; stderr: string }>

export function releasePreparationProgress(
  log: string,
  releaseId: string,
  version: string,
  source?: 'journal' | 'stdout'
): PreparationProgress

export function waitForReleasePreparation<T>(
  preparation: PreparationProcess<T>,
  readProgress: () => Promise<PreparationProgress>,
  options: PreparationTiming & { stop: StopPreparation }
): Promise<T>

export function waitForPreparationPhases(
  readProgress: () => Promise<PreparationProgress>,
  options: PreparationTiming & { phases: string[]; description?: string }
): Promise<PreparationProgress>
