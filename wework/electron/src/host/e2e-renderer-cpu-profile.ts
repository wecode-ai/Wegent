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
  let collecting = false
  contents.on('did-finish-load', () => {
    if (collecting) return
    collecting = true
    void collectProfiles(contents, directory).finally(() => {
      collecting = false
    })
  })
}

async function collectProfiles(contents: ProfileContents, directory: string): Promise<void> {
  let sequence = 0
  while (!contents.isDestroyed()) {
    try {
      await mkdir(directory, { recursive: true })
      const startedAt = Date.now()
      await contentTracing.startRecording({
        included_categories: ['disabled-by-default-v8.cpu_profiler', 'renderer.scheduler'],
        recording_mode: 'record-continuously',
        trace_buffer_size_in_kb: 32768,
      })
      await new Promise(resolve => setTimeout(resolve, 20_000))
      const file = `renderer-${contents.id}-${sequence++}.trace.json`
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
