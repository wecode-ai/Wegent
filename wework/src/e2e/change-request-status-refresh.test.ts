// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { linkedChangeRequestTarget, type TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { ChangeRequestUiObserver } from '@/features/workbench/changeRequestUiObserver'
import { createBarrier } from '@/test/async-barrier'
import { createConnectionObserverFixture } from '@/test/connection-observer'
import type { DeviceCommandRequest } from '@/types/api'
import { showChangeRequestFixtureState } from '../../e2e/desktop/scenarios/change-request-status.scenario.mjs'

const environment = '[data-testid="environment-info-button"]'
const summary = '[data-testid="environment-info-popover"]'

test.each([false, true])(
  'sets the provider state before one fresh observation when the summary starts open=%s',
  async initiallyOpen => {
    const directory = await mkdtemp(join(tmpdir(), 'change-request-refresh-'))
    const statePath = join(directory, 'provider-state')
    await writeFile(statePath, 'failure\n')
    const target = linkedChangeRequestTarget(
      'native-runtime',
      'https://github.com/wecode-ai/Wegent/pull/2631'
    )!
    const firstRefresh = createBarrier()
    const releaseRefresh = createBarrier()
    const providerReads: string[] = []
    const reply = createConnectionObserverFixture()
    const executeCommand = async (_device: string, request: DeviceCommandRequest) => {
      const state = (await readFile(statePath, 'utf8')).trim()
      if (request.command_key === 'connection_observer_refresh') {
        providerReads.push(state)
        firstRefresh.release()
        await releaseRefresh.promise
      }
      const response = reply(request)
      const output = response.stdout as {
        observation: {
          refreshPending: boolean
          resourceStates: Array<{ data: Record<string, unknown> }>
        }
      }
      output.observation.refreshPending = false
      output.observation.resourceStates[0].data.statusCheckRollup = {
        state: state === 'success' ? 'SUCCESS' : 'FAILURE',
      }
      return response
    }
    const observer = new ChangeRequestUiObserver({ executeCommand })
    observer.synchronize([target])
    let snapshot: TaskChangeRequestSnapshot | null = await observer.read(target, false)
    let open = initiallyOpen
    const pending: Array<Promise<unknown>> = []
    const command = vi.fn(async (action: string, selector: string) => {
      if (action === 'getElementCount' && selector === summary) return open ? 1 : 0
      if (action === 'waitFor' && selector === summary) {
        expect(open).toBe(true)
        return
      }
      if (action === 'click' && selector === environment) {
        open = !open
        if (open) {
          pending.push(
            observer.read(target, true).then(result => {
              snapshot = result
            })
          )
          // The real native collector can read the provider before a later UI command.
          if (!providerReads.length) await firstRefresh.promise
        }
        return
      }
      throw new Error(`Unexpected control command: ${action} ${selector}`)
    })

    try {
      await showChangeRequestFixtureState({ command }, { statePath, state: 'success' })

      expect(providerReads).toEqual(['success'])
      expect(command.mock.calls.filter(([action]) => action === 'click')).toHaveLength(
        initiallyOpen ? 2 : 1
      )
      expect(open).toBe(true)
      releaseRefresh.release()
      await Promise.all(pending)
      expect(snapshot?.changeRequest?.checks).toBe('success')
    } finally {
      releaseRefresh.release()
      await Promise.all(pending)
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('does not open the summary if updating the provider fixture fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'change-request-refresh-'))
  const command = vi.fn(async () => 0)
  try {
    await expect(
      showChangeRequestFixtureState(
        { command },
        { statePath: join(directory, 'missing', 'state'), state: 'success' }
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(command.mock.calls.some(([action]) => action === 'click')).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
