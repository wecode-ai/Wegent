import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { contentTracing } from 'electron'

interface ProfileContents {
  id: number
  isDestroyed(): boolean
  on(event: 'did-finish-load', listener: () => void): unknown
}

export function installE2ERendererCpuProfiling(
  contents: ProfileContents,
  environment: NodeJS.ProcessEnv = process.env
): void {
  const directory = environment.WEWORK_E2E_RENDERER_CPU_PROFILE_DIRECTORY
  if (
    environment.VITE_WEWORK_E2E !== 'true' ||
    !environment.WEWORK_E2E_CONTROL_URL ||
    !directory ||
    !isAbsolute(directory)
  )
    return
  const maximum = Number(environment.WEWORK_E2E_RENDERER_CPU_PROFILE_LIMIT ?? Infinity)
  if (maximum !== Infinity && (!Number.isSafeInteger(maximum) || maximum < 1)) return
  const progress = { sequence: 0, maximum }
  let collecting = false
  contents.on('did-finish-load', () => {
    if (collecting || progress.sequence >= maximum) return
    collecting = true
    void collectProfiles(contents, directory, progress).finally(() => {
      collecting = false
    })
  })
}

async function collectProfiles(
  contents: ProfileContents,
  directory: string,
  progress: { sequence: number; maximum: number }
): Promise<void> {
  while (!contents.isDestroyed() && progress.sequence < progress.maximum) {
    try {
      await mkdir(directory, { recursive: true })
      const startedAt = Date.now()
      await contentTracing.startRecording({
        included_categories: ['disabled-by-default-v8.cpu_profiler', 'renderer.scheduler'],
        recording_mode: 'record-continuously',
        trace_buffer_size_in_kb: 32768,
      })
      await new Promise(resolve => setTimeout(resolve, 20_000))
      const file = `renderer-${contents.id}-${progress.sequence++}.trace.json`
      await contentTracing.stopRecording(join(directory, file))
      console.info('[e2e-renderer-cpu-profile]', { file, startedAt, finishedAt: Date.now() })
    } catch (error) {
      if (contents.isDestroyed()) return
      console.warn('[e2e-renderer-cpu-profile]', {
        webContentsId: contents.id,
        error: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : undefined,
      })
      return
    }
  }
}
