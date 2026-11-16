import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CoordinationRuntime } from './runtime.js'
import { ASSESSMENT_INSTRUCTIONS, PROJECT_ASSESSMENT_INSTRUCTIONS } from './instructions.js'

function fixture(overrides = {}) {
  const calls = []
  const contexts = [{ id: 'personal:7', revision: 'v1', enabled: true, needsProcessing: true }]
  const executor = {
    describe: () => ({
      capabilities: [
        'runtime.command-receipts-v1',
        'runtime.coordination-v1',
        'runtime.coordination-arrangements-v1',
      ],
    }),
    async request(method, params) {
      calls.push({ method, params })
      if (overrides.request) return overrides.request(method, params)
      if (method === 'runtime.coordination.contexts') return { contexts }
      if (method === 'runtime.coordination.snapshot') {
        return {
          id: 'snapshot-1',
          context: contexts[0],
          now: '2026-11-02T00:00:00Z',
          events: [
            {
              id: 'event-1',
              kind: 'human_command',
              sourceKey: 'chat',
              processingMode: 'immediate',
            },
          ],
        }
      }
      return { accepted: true }
    },
  }
  const errors = []
  const runtime = new CoordinationRuntime(executor, {
    onError: (error, id) => errors.push({ error, id }),
  })
  return { runtime, calls, contexts, executor, errors }
}

test('routing commits the native snapshot identity and structured decision', async () => {
  const { runtime, calls, errors } = fixture()
  try {
    await runtime.start()
    await runtime.running
    assert.equal(errors.length, 0)
    assert.deepEqual(calls.at(-1), {
      method: 'runtime.coordination.commit',
      params: {
        contextId: 'personal:7',
        snapshotId: 'snapshot-1',
        actions: [{ kind: 'assess', eventIds: ['event-1'] }],
        nextWakeAt: null,
        assessmentInstructions: ASSESSMENT_INSTRUCTIONS,
      },
    })
  } finally {
    runtime.stop()
  }
})

test('project assessments use shared-context instructions without changing personal assessments', async () => {
  const f = fixture()
  f.contexts[0].kind = 'project'
  f.contexts[0].id = 'project:binding'
  try {
    await f.runtime.start()
    await f.runtime.running
    assert.equal(f.errors.length, 0)
    assert.equal(f.calls.at(-1).params.assessmentInstructions, PROJECT_ASSESSMENT_INSTRUCTIONS)
    assert.equal(f.calls.at(-1).params.contextId, 'project:binding')
  } finally {
    f.runtime.stop()
  }
})

test('discovery failures are visible while other authorized contexts still process', async () => {
  const f = fixture()
  const request = f.executor.request.bind(f.executor)
  f.executor.request = async (method, params) => {
    const result = await request(method, params)
    if (method === 'runtime.coordination.contexts') {
      result.errors = [
        { contextId: 'project:cloud', code: 'source_unavailable', message: 'Offline' },
      ]
    }
    return result
  }
  try {
    await f.runtime.start()
    await f.runtime.running
    assert.equal(f.errors.length, 1)
    assert.equal(f.errors[0].id, 'project:cloud')
    assert.equal(f.errors[0].error.code, 'source_unavailable')
    assert.equal(f.calls.at(-1).method, 'runtime.coordination.commit')
  } finally {
    f.runtime.stop()
  }
})

test('unsupported executors do not silently run another coordination path', async () => {
  const { runtime, executor, calls } = fixture()
  executor.describe = () => ({ capabilities: [] })
  await assert.rejects(() => runtime.start(), /does not support/)
  assert.equal(calls.length, 0)
  runtime.stop()
})

test('dispose during snapshot loading prevents a later decision commit', async () => {
  let release
  let entered
  const loading = new Promise(resolve => {
    entered = resolve
  })
  const blocked = new Promise(resolve => {
    release = resolve
  })
  const { runtime, calls } = fixture({
    async request(method) {
      if (method === 'runtime.coordination.contexts') {
        return {
          contexts: [{ id: 'personal:7', revision: 'v1', enabled: true, needsProcessing: true }],
        }
      }
      if (method === 'runtime.coordination.snapshot') {
        entered()
        await blocked
        return {}
      }
      throw new Error('Unexpected commit after disposal')
    },
  })
  const started = runtime.start()
  await loading
  runtime.stop()
  release()
  await started
  await runtime.running
  assert.ok(!calls.some(call => call.method === 'runtime.coordination.commit'))
})

test('a native busy snapshot never rotates or commits an AI batch', async () => {
  const { runtime, calls, errors } = fixture({
    async request(method) {
      if (method === 'runtime.coordination.contexts')
        return {
          contexts: [{ id: 'personal:7', revision: 'v1', enabled: true, needsProcessing: true }],
        }
      if (method === 'runtime.coordination.snapshot') return { skip: true }
      throw new Error('A busy conversation must not receive a commit')
    },
  })
  try {
    await runtime.start()
    await runtime.running
    assert.equal(errors.length, 0)
    assert.ok(!calls.some(call => call.method === 'runtime.coordination.commit'))
  } finally {
    runtime.stop()
  }
})

test('a failed project does not stop the next authorized project', async () => {
  const { runtime, calls, errors } = fixture({
    async request(method, params) {
      if (method === 'runtime.coordination.contexts') {
        return {
          contexts: ['project-a', 'project-b'].map(id => ({
            id,
            revision: 'v1',
            enabled: true,
            needsProcessing: true,
          })),
        }
      }
      if (method === 'runtime.coordination.snapshot') {
        if (params.contextId === 'project-a') throw new Error('Project unavailable')
        return {
          id: 'snapshot-b',
          context: { id: 'project-b', revision: 'v1', enabled: true },
          now: '2026-11-02T00:00:00Z',
          events: [],
        }
      }
      return { accepted: true }
    },
  })
  try {
    await runtime.start()
    await runtime.running
    assert.deepEqual(
      errors.map(error => error.id),
      ['project-a']
    )
    assert.equal(calls.at(-1).params.contextId, 'project-b')
  } finally {
    runtime.stop()
  }
})
