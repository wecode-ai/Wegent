import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { startNativeAppServer } from './native-app-server.mjs'

export function upgradeWriterWaitSeconds(value = '0') {
  if (!/^(?:0|[1-9]\d*)$/.test(String(value)) || Number(value) > 600)
    throw new Error('Upgrade writer wait must be an integer between 0 and 600 seconds')
  return Number(value)
}

export function createUpgradeWriterWait(pair, checkpoint, options) {
  const seconds = upgradeWriterWaitSeconds(process.env.WEWORK_E2E_UPGRADE_WRITER_WAIT_SECONDS)
  if (seconds)
    assert.equal(
      pair.to.afterStopPreparation,
      1,
      'Writer-wait verification requires stopped preparation'
    )
  let writer
  return {
    async beforeRestart(workspace) {
      if (seconds && checkpoint === 'app-rollback')
        writer = await startUpgradeWriter({
          binary: pair.from.codex,
          home: options.codexHome,
          workspace,
          timeoutMs: options.workbenchReadyTimeoutMs,
        })
    },
    async afterRestart(root, assertStopped) {
      if (!writer) return
      await writer.holdActivation(root, pair.to, seconds, assertStopped)
      await writer.stop()
      writer = undefined
    },
    async cleanup() {
      await writer?.stop()
    },
  }
}

async function optional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/** A real, independently owned native writer; only its model service is mocked. */
export async function startUpgradeWriter({ binary, home, workspace, timeoutMs }) {
  let inference
  const inferred = new Promise(resolve => {
    inference = resolve
  })
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"models":[],"data":[]}')
      return
    }
    for await (const _chunk of request) {
      /* Drain the synthetic model request. */
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"upgrade-writer","status":"in_progress","output":[]}}\n\n'
    )
    inference()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const provider = 'upgrade-writer-fixture'
  const definition = `{name="${provider}",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",experimental_bearer_token="synthetic-key"}`
  let native
  const stop = async () => {
    try {
      await native?.stop()
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  }
  try {
    native = await startNativeAppServer({
      binary,
      home,
      workspace,
      timeoutMs,
      config: [`model_provider="${provider}"`, `model_providers.${provider}=${definition}`],
    })
    const { child, rpc } = native
    const { thread } = await rpc('thread/start', {
      modelProvider: provider,
      model: 'gpt-5.5',
      cwd: workspace,
      permissions: ':read-only',
      approvalPolicy: 'never',
      config: { mcp_servers: {} },
    })
    await rpc('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text: 'WEWORK_UPGRADE_HELD_NATIVE_WRITER' }],
    })
    let timer
    try {
      await Promise.race([
        inferred,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native upgrade writer did not reach inference')),
            timeoutMs
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    assert.notEqual(
      await optional(join(home, 'thread-writer-locks', `${thread.id}.lock`)),
      undefined
    )
    const rolloutName = (await readdir(join(home, 'sessions'), { recursive: true })).find(
      name => name.includes(thread.id) && name.endsWith('.jsonl')
    )
    assert.ok(rolloutName, 'The real native writer did not persist its rollout')
    const rollout = join(home, 'sessions', rolloutName)
    const originalHeader = (await readFile(rollout, 'utf8')).split('\n')[0]
    return {
      stop,
      async holdActivation(root, target, seconds, assertStopped) {
        const deadline = Date.now() + timeoutMs
        let activation
        while (Date.now() < deadline) {
          activation = JSON.parse((await optional(join(root, 'activation.json'))) ?? 'null')
          if (activation && (await optional(join(root, 'data-opened'))) === activation.token) {
            const request = JSON.parse(
              (await optional(join(root, 'slots', activation.to, 'after-stop-request.json'))) ??
                'null'
            )
            if (
              request?.token === activation.token &&
              request.release.version === target.version &&
              request.release.packageSha256 === target.sha256
            )
              break
          }
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        assert.ok(activation, 'The real bridge did not enter stopped preparation')
        const request = JSON.parse(
          (await optional(join(root, 'slots', activation.to, 'after-stop-request.json'))) ?? 'null'
        )
        assert.equal(request?.release.version, target.version)
        assert.equal(request?.release.packageSha256, target.sha256)
        assert.equal(await optional(join(root, 'data-opened')), activation.token)
        const started = Date.now()
        while (Date.now() - started < seconds * 1000) {
          assertStopped?.()
          assert.equal(child.exitCode, null)
          assert.equal(child.signalCode, null)
          assert.equal(
            (await readFile(rollout, 'utf8')).split('\n')[0],
            originalHeader,
            'Stopped migration rewrote a live native rollout'
          )
          assert.notEqual(
            await optional(join(root, 'attempted')),
            activation.token,
            'Trial timer started before stopped preparation finished'
          )
          const receipt = JSON.parse(
            (await optional(join(root, 'after-stop-ready.json'))) ?? 'null'
          )
          assert.notEqual(receipt?.token, activation.token, 'Bridge admitted a live native writer')
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        console.log(
          `[upgrade-e2e] Real native writer held stopped preparation for ${Date.now() - started}ms`
        )
      },
    }
  } catch (error) {
    await stop()
    throw error
  }
}
