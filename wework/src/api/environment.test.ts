import { describe, expect, test, vi } from 'vitest'
import { loadProjectEnvironment, type DeviceCommandApi } from './environment'

describe('workspace diff summary', () => {
  test.each([
    { shortStat: '1 file changed, 4 insertions(+), 2 deletions(-)', counts: ['+4', '-2'] },
    { shortStat: '', counts: ['+0', '-0'] },
    { shortStat: null, counts: ['+2', '-0'] },
  ])('uses Git status only when the branch diff is unavailable ($shortStat)', async fixture => {
    const executeCommand = vi.fn<DeviceCommandApi['executeCommand']>(async (_, request) => {
      const outputs: Record<string, string | null> = {
        git_branch: 'feature/example',
        git_branch_diff_shortstat: fixture.shortStat,
        git_remote_url: '',
        git_status_porcelain: '?? new.txt\n?? another.txt',
      }
      const output = outputs[request.command_key]
      if (output === undefined) throw new Error(`Unexpected command: ${request.command_key}`)
      return { success: output !== null, stdout: output ?? '', stderr: '' }
    })

    const info = await loadProjectEnvironment({ executeCommand }, null, {
      deviceId: 'device-1',
      path: '/workspace/project',
    })

    expect([info.additions, info.deletions]).toEqual(fixture.counts)
    expect(
      executeCommand.mock.calls.filter(
        ([, request]) => request.command_key === 'git_status_porcelain'
      )
    ).toHaveLength(fixture.shortStat === null ? 1 : 0)
  })
})
