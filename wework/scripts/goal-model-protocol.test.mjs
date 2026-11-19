// @vitest-environment node
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { expect, test, vi } from 'vitest'

const base = vi.hoisted(() => ({ handleHttp: vi.fn(async () => true) }))
vi.mock('../e2e/desktop/scenarios/goal-state-sync.scenario.mjs', () => ({
  createDesktopScenario: () => ({ ...base, verify: async () => {} }),
}))
import { createDesktopScenario as createOutput } from '../e2e/desktop/scenarios/goal-output-identity.scenario.mjs'
import { createDesktopScenario as createStopped } from '../e2e/desktop/scenarios/goal-stopped-state.scenario.mjs'
import { createDesktopScenario as createResume } from '../e2e/desktop/scenarios/goal-resume-route.scenario.mjs'

test.each([
  ['stopped', createStopped],
  ['resume', createResume],
])('nested %s Goal scenarios preserve the shared model request context', async (_name, create) => {
  const scenario = create({})
  const args = [{}, {}, new URL('http://localhost/v1/messages'), { protocol: 'anthropic' }]
  await scenario.handleHttp(...args)
  expect(base.handleHttp).toHaveBeenLastCalledWith(...args)
})

for (const protocol of ['responses', 'chat', 'anthropic']) {
  test(`restored Goal follow-up terminates using the selected ${protocol} protocol`, async () => {
    const scenario = createOutput({})
    await expect(
      scenario.verify({
        command: async name => {
          if (name === 'setLocalStorageItem') throw new Error('Fixture activated')
        },
      })
    ).rejects.toThrow('Fixture activated')
    const body = {
      input:
        'WEWORK_OUTPUT_IDENTITY_BASE WEWORK_OUTPUT_IDENTITY_FOLLOW_UP WEWORK_OUTPUT_IDENTITY_AFTER_RESTART WEWORK_OUTPUT_IDENTITY_AFTER_RESTORE',
    }
    let finalFrames
    for (let stage = 0; stage < 7; stage += 1) {
      const response = new EventEmitter()
      const frames = []
      response.writeHead = status => {
        expect(status).toBe(200)
        if ([2, 3, 4].includes(stage)) {
          queueMicrotask(() => {
            response.destroyed = true
            response.emit('close')
          })
        }
      }
      response.write = frame => frames.push(frame)
      response.end = frame => frames.push(frame)
      const request = Readable.from([JSON.stringify(body)])
      request.method = 'POST'
      expect(
        await scenario.handleHttp(request, response, new URL('http://localhost/model'), {
          protocol,
        })
      ).toBe(true)
      finalFrames = frames.join('')
      if (stage === 2) {
        expect(finalFrames).not.toMatch(/response.completed|message_stop|\[DONE\]/)
        if (protocol === 'responses') expect(finalFrames).toContain('"phase":"commentary"')
      }
    }
    const events = finalFrames
      .split('\n')
      .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map(line => JSON.parse(line.slice(6)))
    const text = events
      .map(event =>
        protocol === 'responses'
          ? event.type === 'response.output_text.delta'
            ? event.delta
            : ''
          : protocol === 'chat'
            ? (event.choices[0].delta.content ?? '')
            : event.type === 'content_block_delta'
              ? event.delta.text
              : ''
      )
      .join('')
    expect(text).toBe('Restored history with an older streaming turn must remain sendable.')
    expect(finalFrames).toContain(
      protocol === 'responses'
        ? 'response.completed'
        : protocol === 'chat'
          ? '[DONE]'
          : 'message_stop'
    )
  })
}
