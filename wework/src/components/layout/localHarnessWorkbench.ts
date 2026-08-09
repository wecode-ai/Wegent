import type { LocalHarnessId } from '@/lib/local-harness'

export interface LocalHarnessWorkbenchSession {
  sessionId: string
  harnessId: LocalHarnessId
  title: string
  cwd: string
  createdAt: number
  proxyToken?: string
}
