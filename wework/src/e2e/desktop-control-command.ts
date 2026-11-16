import type { DesktopControlCommand } from '@/extensions/desktop-control-contract'
import { logRuntimeTaskCreateStage } from '@/lib/runtime-create-diagnostics'

export interface DesktopControlResult {
  id: string
  clientId: string
  ok: boolean
  value?: string
  error?: string
}

export async function completeDesktopControlCommand(
  command: DesktopControlCommand,
  clientId: string,
  execute: (command: DesktopControlCommand) => Promise<string>,
  report: (result: DesktopControlResult) => Promise<void>
): Promise<DesktopControlResult> {
  const diagnostic = { commandId: command.id, action: command.action, clientId }
  let result: DesktopControlResult
  try {
    const value = await execute(command)
    result = { id: command.id, clientId, ok: true, value }
  } catch (error) {
    result = {
      id: command.id,
      clientId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    logRuntimeTaskCreateStage('desktop-control-executed', { ...diagnostic, ok: result.ok }, 'debug')
    await report(result)
    logRuntimeTaskCreateStage('desktop-control-result-acknowledged', diagnostic, 'debug')
  } catch (error) {
    console.error(
      '[Wework] Desktop E2E result acknowledgement failed:',
      JSON.stringify({
        commandId: command.id,
        action: command.action,
        actionSucceeded: result.ok,
        actionError: result.error,
        error: error instanceof Error ? error.message : String(error),
      })
    )
    throw error
  }
  return result
}
