import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { WebContents } from 'electron'

interface ProfileContents {
  id: number
  debugger: Pick<WebContents['debugger'], 'isAttached' | 'attach' | 'sendCommand'>
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
      const session = contents.debugger
      if (!session.isAttached()) session.attach('1.3')
      await session.sendCommand('Profiler.enable')
      await session.sendCommand('Profiler.setSamplingInterval', { interval: 1000 })
      await session.sendCommand('Profiler.start')
      await new Promise(resolve => setTimeout(resolve, 20_000))
      if (contents.isDestroyed()) return
      const { profile } = await session.sendCommand('Profiler.stop')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, `renderer-${contents.id}-${sequence++}.cpuprofile`),
        JSON.stringify(profile),
        { mode: 0o600 }
      )
    } catch (error) {
      if (contents.isDestroyed()) return
      console.warn('[e2e-renderer-cpu-profile]', {
        webContentsId: contents.id,
        error: error instanceof Error ? error.name : typeof error,
      })
      return
    }
  }
}
