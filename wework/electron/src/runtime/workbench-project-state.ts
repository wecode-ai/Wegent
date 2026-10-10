import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export type ProjectStateProjector = (
  state: Record<string, unknown>,
  oplog: string
) => Promise<Record<string, unknown>>

export function executorProjectStateProjector(executor: string): ProjectStateProjector {
  return async (state, oplog) => {
    const input = JSON.stringify({ protocol_version: 1, state, oplog })
    if (Buffer.byteLength(input) > 16 * 1024 * 1024)
      throw new Error('Development project-state input is too large')
    const result = execute(executor.trim(), ['--workbench-project-state', '--version'], {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
      },
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    result.child.stdin?.on('error', () => {})
    result.child.stdin?.end(input)
    try {
      const { stdout } = await result
      const response = JSON.parse(stdout)
      if (
        response?.protocol_version !== 1 ||
        !response.state ||
        typeof response.state !== 'object' ||
        Array.isArray(response.state)
      )
        throw new Error('Invalid project-state response')
      return response.state as Record<string, unknown>
    } catch {
      // execFile errors include stdin/stdout-related data; do not expose project contents.
      throw new Error(
        'Executor project-state replay failed; check the operation format and rebuild the development Executor'
      )
    }
  }
}

export async function replayProjectState(
  state: Record<string, unknown>,
  oplog: string,
  project?: ProjectStateProjector
): Promise<Record<string, unknown>> {
  if (!oplog.trim()) return state
  if (!project) throw new Error('Executor project-state replay is unavailable')
  return project(state, oplog)
}
