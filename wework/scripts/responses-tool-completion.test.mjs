import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
  MODEL_REQUEST_TIMEOUT_MS,
} from '../e2e/desktop/modules/shared.mjs'
import { createDesktopScenario } from '../e2e/desktop/scenarios/responses-tool-compatibility.scenario.mjs'

vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  createSingleRootLocalProject: vi.fn().mockResolvedValue(undefined),
  selectE2EModel: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../e2e/desktop/modules/workspace-flows.mjs', async importOriginal => ({
  ...(await importOriginal()),
  reloadMainWindow: vi.fn().mockResolvedValue(undefined),
}))

const workspaces = []

afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('gives each real tool round its model budget before the unchanged DOM assertion', async () => {
  vi.useFakeTimers()
  const fixture = await createFixture()
  const verification = fixture.scenario.verify(fixture.control)
  for (const round of [1, 2, 3]) {
    await fixture.submitted[round].promise
    await vi.advanceTimersByTimeAsync(11_000)
    expect(fixture.domWaits).toHaveLength(round - 1)
    await fixture.startOracle(round)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.domWaits).toHaveLength(round - 1)
    const response = await fixture.finishOracle(round)
    expect(response.end).toHaveBeenCalledWith(
      expect.stringContaining(`RESPONSES_TOOL_COMPLETED ${round}`)
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(fixture.domWaits).toHaveLength(round)
    expect(fixture.domWaits[round - 1]).toEqual({
      selector: `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="message-assistant"]`,
      options: {
        text: `RESPONSES_TOOL_COMPLETED ${round}`,
        timeoutMs: MODEL_REQUEST_TIMEOUT_MS,
      },
    })
  }
  await verification
  expect(DEFAULT_STEP_TIMEOUT_MS).toBe(10_000)
  expect(fixture.scenario.diagnostics().requests).toHaveLength(6)
  expect(fixture.scenario.diagnostics().completedRounds).toEqual([1, 2, 3])
})

test('preserves the original DOM failure after the protocol completes', async () => {
  vi.useFakeTimers()
  const originalError = new Error('The completed answer was not rendered')
  const fixture = await createFixture(originalError)
  const verification = fixture.scenario.verify(fixture.control).catch(error => error)
  await fixture.submitted[1].promise
  await fixture.startOracle(1)
  await fixture.finishOracle(1)
  await vi.advanceTimersByTimeAsync(100)
  expect(await verification).toBe(originalError)
  expect(fixture.domWaits).toHaveLength(1)
})

test('does not unlock the DOM assertion when writing the final model response fails', async () => {
  vi.useFakeTimers()
  const originalError = new Error('The final SSE could not be written')
  const fixture = await createFixture()
  const verification = fixture.scenario.verify(fixture.control).catch(error => error)
  await fixture.submitted[1].promise
  await fixture.startOracle(1)
  await expect(fixture.finishOracle(1, originalError)).rejects.toBe(originalError)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await verification).toMatchObject({
    message: 'Responses tool protocol did not finish round 1: false',
  })
  expect(fixture.domWaits).toHaveLength(0)
  expect(fixture.scenario.diagnostics().completedRounds).toEqual([])
})

async function createFixture(domError) {
  const workspace = await mkdtemp(join(tmpdir(), 'responses-completion-unit-'))
  workspaces.push(workspace)
  await writeFile(join(workspace, 'responses-tool-compatibility.txt'), 'RESPONSES_SHELL_OK')
  const scenario = createDesktopScenario({
    electronUserDataDirectory: workspace,
    workspacePath: workspace,
    resultDir: workspace,
    modelResponseTimeoutMs: 30_000,
  })
  const submitted = Object.fromEntries([1, 2, 3].map(round => [round, deferred()]))
  const domWaits = []
  let round
  const control = {
    command: vi.fn(async (action, selector, options) => {
      if (action === 'clickWhenEnabled' && selector === '[data-testid="provider-editor-test"]')
        for (const native of [false, true])
          await request(scenario, {
            model: `custom-responses-model${native ? '-native' : ''}`,
            tools: [
              {
                type: native ? 'custom' : 'function',
                name: native ? 'apply_patch' : 'wework_capability_probe',
              },
            ],
            input: [],
          })
      if (action === 'getValue') return 'standard'
      if (action === 'fill' && selector === ACTIVE_COMPOSER_SELECTOR)
        round = Number(options.value.split(' ').at(-1))
      if (action === 'clickWhenEnabled' && selector.endsWith('[data-testid="send-message-button"]'))
        submitted[round].resolve()
      if (action === 'waitFor' && selector.endsWith('[data-testid="message-assistant"]')) {
        domWaits.push({ selector, options })
        if (domError) throw domError
      }
      return ''
    }),
  }
  return {
    scenario,
    control,
    submitted,
    domWaits,
    startOracle: round => request(scenario, toolBody(round, false)),
    finishOracle: (round, error) => request(scenario, toolBody(round, true), error),
  }
}

function toolBody(round, completed) {
  const native = round === 3
  const call = {
    type: native ? 'custom_tool_call' : 'function_call',
    call_id: `responses-exec-${round}`,
    name: 'exec',
    ...(native
      ? { input: 'text("done")' }
      : { arguments: JSON.stringify({ input: 'text("done")' }) }),
  }
  return {
    model: `custom-responses-model${native ? '-native' : ''}`,
    tools: [
      {
        type: native ? 'custom' : 'function',
        name: 'exec',
        parameters: { properties: { input: { type: 'string' } } },
      },
    ],
    input: completed
      ? [call, { type: `${call.type}_output`, call_id: call.call_id, output: 'RESPONSES_SHELL_OK' }]
      : [],
  }
}

async function request(scenario, body, endError) {
  const stream = new PassThrough()
  stream.headers = { authorization: 'Bearer responses-protocol-fixture-key' }
  const response = {
    writeHead: vi.fn(),
    end: vi.fn(() => {
      if (endError) throw endError
    }),
  }
  const handled = scenario.handleHttp(
    stream,
    response,
    new URL('http://127.0.0.1/compat/responses')
  )
  stream.end(JSON.stringify(body))
  expect(await handled).toBe(true)
  return response
}

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}
