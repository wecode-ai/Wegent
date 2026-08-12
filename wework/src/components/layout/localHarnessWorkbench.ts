import type { LocalHarnessId } from '@/lib/local-harness'

export interface LocalHarnessWorkbenchSession {
  sessionId: string
  harnessId: LocalHarnessId
  title: string
  cwd: string
  createdAt: number
  isPrimary: boolean
  projectId: number | null
  active: boolean
  modelKey?: string | null
  pluginRoots?: string[]
  proxyToken?: string
}

export interface LocalHarnessSessionRegistrationOptions {
  activate?: boolean
}
