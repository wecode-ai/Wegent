import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { bindGitProvider } from './runtime-bridge.js'
import { parseConnections } from '../plugin-runtime/connections.js'

const providerId = '@wegent/dsh-connection-git/github'

test('Git marks temporary failures only during collection and retains platform deadlines', async () => {
  for (const name of ['collect', 'listResources', 'executeAction']) {
    for (const code of [
      'git_cli_failed',
      'git_cli_timeout',
      'git_rate_limited',
      'cloud_unavailable',
      'cloud_request_failed',
      'connector_auth_required',
      'git_permission_denied',
      'git_connection_invalid',
    ]) {
      for (const delay of [undefined, 120000]) {
        const error = Object.assign(new Error('Native failure'), { code })
        if (delay !== undefined) error.retryAfterMs = delay
        const provider = bindGitProvider(
          providerId,
          { [name]: ctx => ctx.git.read({ operation: 'identity' }) },
          async () => {
            throw error
          }
        )
        const context = { providerId, signal: new AbortController().signal }
        await assert.rejects(provider[name](context, {}), failure => {
          const transient = [
            'git_cli_failed',
            'git_cli_timeout',
            'git_rate_limited',
            'cloud_unavailable',
            'cloud_request_failed',
          ].includes(code)
          assert.equal(
            failure.retryAfterMs,
            delay ?? (name === 'collect' && transient ? 30000 : undefined)
          )
          return true
        })
      }
    }
  }
})

test('both Git providers advertise instance discovery parameters without assuming a host', async () => {
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  const declaration = parseConnections(manifest)
  assert.equal(declaration.providers.length, 2)
  for (const provider of declaration.providers) {
    assert.deepEqual(provider.resourceQuerySchema.required, ['instance'])
    assert.equal(provider.resourceQuerySchema.properties.instance.type, 'string')
    assert.equal(provider.resourceQuerySchema.properties.instance.default, undefined)
  }
})

function fixture(operation) {
  const controller = new AbortController()
  const calls = []
  const provider = bindGitProvider(providerId, { collect: operation }, async (method, input) => {
    calls.push({ method, input })
    return { data: 'native result' }
  })
  return {
    controller,
    calls,
    provider,
    context: { providerId, signal: controller.signal },
  }
}

test('Git plugin pins native reads to its registered provider identity', async () => {
  const f = fixture(ctx => ctx.git.read({ operation: 'identity', providerId: 'foreign' }))
  assert.deepEqual(await f.provider.collect(f.context, {}), { data: 'native result' })
  assert.deepEqual(f.calls, [
    {
      method: 'runtime.connections.git.read',
      input: { operation: 'identity', providerId },
    },
  ])
  await assert.rejects(
    f.provider.collect({ ...f.context, providerId: '@wegent/dsh-connection-git/gitlab' }, {}),
    { code: 'connection_tool_denied' }
  )
  assert.equal(f.calls.length, 1)
})

test('Git inbox bridge permits only durable read and acknowledgement operations', async () => {
  for (const operation of ['events', 'ack', 'boundary']) {
    const f = fixture(ctx => ctx.git.inbox({ operation, subscriptionId: 'sub', generation: 'g' }))
    await f.provider.collect(f.context, {})
    assert.deepEqual(f.calls, [
      {
        method: 'runtime.connections.git.webhooks',
        input: { operation, subscriptionId: 'sub', generation: 'g', providerId },
      },
    ])
  }
  const f = fixture(ctx => ctx.git.inbox({ operation: 'create' }))
  await assert.rejects(f.provider.collect(f.context, {}), { code: 'connection_tool_denied' })
  assert.deepEqual(f.calls, [])
})

test('provider disposal prevents a native call and a late native response from being consumed', async () => {
  const f = fixture(ctx => ctx.git.read({ operation: 'repository' }))
  f.controller.abort()
  await assert.rejects(f.provider.collect(f.context, {}), { name: 'AbortError' })
  assert.deepEqual(f.calls, [])

  const controller = new AbortController()
  const provider = bindGitProvider(
    providerId,
    {
      collect: ctx => ctx.git.read({ operation: 'repository' }),
    },
    async () => {
      controller.abort()
      return { data: 'late result' }
    }
  )
  await assert.rejects(provider.collect({ providerId, signal: controller.signal }, {}), {
    name: 'AbortError',
  })
})

test('a foreign plugin cannot acquire the private native Git bridge', () => {
  assert.throws(() => bindGitProvider('@other/plugin/source', {}, () => {}), {
    code: 'connection_tool_denied',
  })
})

test('native GitLab authorization discovery preserves the selected instance and provider identity', async () => {
  const controller = new AbortController()
  const calls = []
  const gitlab = '@wegent/dsh-connection-git/gitlab'
  const target = {
    pluginKey: 'gitlab',
    connectorSlug: 'native-generated-slug',
    instance: 'https://git.company.example',
  }
  const provider = bindGitProvider(
    gitlab,
    {
      listResources: ctx =>
        ctx.git.authTarget({ instance: target.instance, providerId: 'foreign' }),
    },
    async (method, input) => {
      calls.push({ method, input })
      return target
    }
  )
  assert.deepEqual(
    await provider.listResources({ providerId: gitlab, signal: controller.signal }, {}),
    target
  )
  assert.deepEqual(calls, [
    {
      method: 'runtime.connections.git.authTarget',
      input: { instance: target.instance, providerId: gitlab },
    },
  ])
  controller.abort()
  await assert.rejects(
    provider.listResources({ providerId: gitlab, signal: controller.signal }, {}),
    { name: 'AbortError' }
  )
  assert.equal(calls.length, 1)
})

test('GitHub authorization uses only its declared target, without invoking the GitLab native route', async () => {
  const controller = new AbortController()
  const target = { pluginKey: 'github', connectorSlug: 'wework-github-cli' }
  let calls = 0
  const provider = bindGitProvider(
    providerId,
    { listResources: ctx => ctx.git.authTarget({ instance: 'https://github.com' }) },
    async () => {
      ++calls
    },
    target
  )
  const result = await provider.listResources({ providerId, signal: controller.signal }, {})
  assert.deepEqual(result, target)
  result.connectorSlug = 'mutated'
  assert.equal(target.connectorSlug, 'wework-github-cli')
  assert.equal(calls, 0)
})
