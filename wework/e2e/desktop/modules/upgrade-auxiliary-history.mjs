import assert from 'node:assert/strict'
import { readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { startNativeAppServer } from './native-app-server.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  responseCompleted,
  responseCreated,
  handleEmptyReplyPrediction,
} from './response-protocol.mjs'

const SUMMARY =
  'WEWORK_AUXILIARY_COMPACTED_HISTORY: user WEWORK_UPGRADE_PERSISTENCE; assistant WEWORK_UPGRADE_REAL_RUNTIME_OK; successful tool WEWORK_UPGRADE_REAL_TOOL_HISTORY'

async function rollout(home, id) {
  for (const directory of ['sessions', 'archived_sessions']) {
    const root = join(home, directory)
    let entries
    try {
      entries = await readdir(root, { recursive: true })
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const name = entries.find(name => name.includes(id) && /\.jsonl(?:\.zst)?$/.test(name))
    if (name) return join(root, name)
  }
  throw new Error('The native fork has no persisted rollout')
}

async function contents(path) {
  const bytes = await readFile(path)
  return path.endsWith('.zst') ? zstdDecompressSync(bytes) : bytes
}

/** Fork, compact and compress through native APIs; never reconstruct session history. */
export function createUpgradeAuxiliaryHistory(pair, control, options) {
  const enabled = pair.to.afterStopPreparation === 1
  const home = options.codexHome
  const timeoutMs = options.workbenchReadyTimeoutMs
  const provider = 'upgrade-history-fixture'
  const replies = []
  let forkId
  let parentId
  let preservedTail
  let server
  let compacting = false
  let latestInput
  let modelFailure
  const definition = () =>
    `{name="${provider}",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",experimental_bearer_token="synthetic-key"}`
  const start = (binary, compression = false, selectedProvider = provider) =>
    startNativeAppServer({
      binary,
      home,
      workspace: options.workspacePath,
      timeoutMs,
      config: [
        `model_provider="${selectedProvider}"`,
        `model_providers.${provider}=${definition()}`,
        `model_providers.~=${definition()}`,
        `features.local_thread_store_compression=${compression}`,
      ],
    })
  const waitCompleted = native =>
    waitForValue(
      async () => {
        if (modelFailure) throw modelFailure
        return native.notifications
      },
      messages =>
        messages.some(
          message => message.method === 'turn/completed' && message.params.threadId === forkId
        ),
      'Native fork turn did not complete',
      timeoutMs
    )
  async function capture() {
    const bytes = await contents(await rollout(home, forkId))
    preservedTail = bytes.subarray(bytes.indexOf(10) + 1)
  }
  return {
    async seed(sourceId) {
      if (!enabled) return
      parentId = sourceId
      const handleModel = async (request, response) => {
        if (request.method !== 'POST' || !request.url.endsWith('/responses')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{"models":[],"data":[]}')
          return
        }
        const body = await readRequestBody(request)
        if (handleEmptyReplyPrediction(body, response)) return
        latestInput = JSON.stringify(body.input ?? body.messages)
        const serializedMetadata =
          body.client_metadata?.['x-codex-turn-metadata'] ??
          request.headers['x-codex-turn-metadata']
        const metadata =
          typeof serializedMetadata === 'string'
            ? JSON.parse(serializedMetadata)
            : serializedMetadata
        assert.ok(
          ['turn', 'compaction'].includes(metadata?.request_kind),
          'Native model request must declare its request kind'
        )
        const isCompaction = metadata.request_kind === 'compaction'
        if (compacting) assert.equal(isCompaction, true)
        if (isCompaction) {
          for (const marker of [
            'WEWORK_UPGRADE_PERSISTENCE',
            'WEWORK_UPGRADE_REAL_RUNTIME_OK',
            'WEWORK_UPGRADE_REAL_TOOL_HISTORY',
          ])
            assert.ok(latestInput.includes(marker), 'Native fork compaction lost source history')
        } else {
          assert.ok(latestInput.includes(SUMMARY), 'Native continuation lost persisted compaction')
          for (const reply of replies)
            assert.ok(latestInput.includes(reply), 'Native fork lost a post-upgrade reply')
        }
        const answer = isCompaction
          ? [SUMMARY, ...replies].join('\n')
          : `WEWORK_AUXILIARY_REPLY_${replies.length}`
        if (!isCompaction) replies.push(answer)
        const id = `auxiliary-${replies.length}`
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          createSse([responseCreated(id), assistantMessage(answer), responseCompleted(id)])
        )
      }
      server = createServer((request, response) => {
        handleModel(request, response).catch(async error => {
          await writeFile(
            join(options.resultDir ?? home, 'upgrade-auxiliary-model-input.json'),
            latestInput ?? ''
          ).catch(() => undefined)
          modelFailure = error
          response.destroy()
        })
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      let native = await start(pair.from.codex)
      try {
        const { thread } = await native.rpc('thread/fork', {
          threadId: parentId,
          modelProvider: provider,
          model: 'gpt-5.5',
          approvalPolicy: 'never',
          sandbox: 'read-only',
          config: { mcp_servers: {} },
        })
        forkId = thread.id
        assert.equal(thread.forkedFromId, parentId)
        compacting = true
        await native.rpc('thread/compact/start', { threadId: forkId })
        await waitCompleted(native)
        const plain = await rollout(home, forkId)
        assert.ok(
          (await contents(plain))
            .toString()
            .split('\n')
            .some(line => line && JSON.parse(line).type === 'compacted'),
          'Native compaction must publish a real compacted record'
        )
        assert.ok(
          (await contents(plain)).includes(Buffer.from(SUMMARY)),
          'Native source compaction did not persist its summary'
        )
        await native.rpc('thread/archive', { threadId: forkId })
      } finally {
        await native.stop()
      }
      const archived = await rollout(home, forkId)
      assert.ok(archived.includes('archived_sessions'))
      const cold = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      await utimes(archived, cold, cold)
      native = await start(pair.from.codex, true)
      try {
        await waitForValue(
          async () => rollout(home, forkId),
          path => path.endsWith('.jsonl.zst'),
          'Native cold-history compression did not finish',
          timeoutMs
        )
        const { thread } = await native.rpc('thread/read', { threadId: forkId, includeTurns: true })
        assert.equal(thread.id, forkId)
        assert.equal(thread.forkedFromId, parentId)
        await capture()
      } finally {
        await native.stop()
      }
      compacting = false
    },
    async verify(stage) {
      if (!enabled) return
      const bytes = await contents(await rollout(home, forkId))
      assert.ok(
        bytes.subarray(bytes.indexOf(10) + 1).equals(preservedTail),
        `${stage} changed archived/compacted fork history bytes`
      )
      const diagnostics = JSON.parse(
        await control().command('getDesktopRuntimeDiagnostics', 'body')
      )
      const native = await start(diagnostics.release.codexPath, false, '~')
      try {
        const { thread } = await native.rpc('thread/read', { threadId: forkId, includeTurns: true })
        assert.equal(thread.id, forkId)
        assert.equal(thread.forkedFromId, parentId)
        await native.rpc('thread/unarchive', { threadId: forkId })
        const resumed = await native.rpc('thread/resume', {
          threadId: forkId,
          modelProvider: '~',
          config: { mcp_servers: {} },
        })
        assert.equal(resumed.thread.id, forkId)
        await native.rpc('turn/start', {
          threadId: forkId,
          input: [{ type: 'text', text: `Continue existing native fork after ${stage}` }],
        })
        await waitCompleted(native)
        await native.rpc('thread/archive', { threadId: forkId })
        await capture()
      } finally {
        await native.stop()
      }
    },
    async cleanup() {
      if (!server) return
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    },
    evidence() {
      return enabled
        ? {
            nativeForkIdentityPreserved: true,
            nativeCompactionAndCompression: true,
            verifiedContinuations: replies.length,
          }
        : undefined
    },
  }
}
