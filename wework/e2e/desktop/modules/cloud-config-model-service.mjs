import assert from 'node:assert/strict'
import { once } from 'node:events'
import { lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { rejectModelWebSocketUpgrade } from './reject-model-upgrade.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
  selectedToolCall,
  selectTool,
} from './response-protocol.mjs'

const ACCOUNT = 'cloud-config-recovery-enterprise'
const ACCESS = 'synthetic-cloud-config-recovery-access'

async function authFileMetadata(path) {
  try {
    const metadata = await lstat(path)
    const symlink = metadata.isSymbolicLink()
    return {
      path,
      exists: true,
      type: symlink ? 'symlink' : metadata.isFile() ? 'file' : 'other',
      ...(symlink ? { target: await readlink(path) } : {}),
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { path, exists: false }
  }
}

// The failure belongs to the model subscription service. Executor IPC, native
// Codex requests, notifications, persistence and restart are never substituted.
export function createCloudConfigModelService({ readUsage } = {}) {
  let server
  let codexHome
  let nativeHome
  let unavailable = false
  let bootstrapBundles = 0
  let bundleFailures = 0
  let bundleSuccesses = 0
  let accountChecks = 0
  const plans = new Map()
  const requests = []
  const authSnapshots = []
  const releases = new Set()

  return {
    plan(marker, responses = [{}]) {
      const rounds = responses.map(response => {
        let release
        const held = response.hold
          ? new Promise(resolve => {
              release = resolve
              releases.add(resolve)
            })
          : null
        return { ...response, held, release }
      })
      const plan = { marker, rounds, count: 0, calls: [] }
      plans.set(marker, plan)
      return plan
    },
    async prepareApp({ appEnvironment, codexHome: home, control }) {
      codexHome = home
      server = createServer((request, response) => {
        if (readUsage && request.url?.includes('/wham/usage')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(readUsage()))
          return
        }
        if (request.url?.startsWith('/backend-api/wham/accounts/check')) {
          accountChecks += 1
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(
            JSON.stringify({
              accounts: [
                {
                  id: ACCOUNT,
                  workspace_backend_origin: 'https://chatgpt.com',
                  account_routing_override: 'NO_CONSTRAINT',
                },
              ],
            })
          )
          return
        }
        if (request.url?.endsWith('/config/bundle')) {
          if (unavailable && bootstrapBundles === 0) {
            bundleFailures += 1
            response.writeHead(503, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'Model subscription service unavailable' }))
          } else {
            bootstrapBundles = Math.max(0, bootstrapBundles - 1)
            bundleSuccesses += 1
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end('{}')
          }
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')

      nativeHome = join(appEnvironment.HOME, '.codex')
      await mkdir(nativeHome, { recursive: true })
      const claims = Buffer.from(
        JSON.stringify({
          email: 'cloud-config-recovery@example.test',
          exp: Math.floor(Date.now() / 1000) + 3600,
          'https://api.openai.com/auth': {
            chatgpt_account_id: ACCOUNT,
            // An account-only synthetic identity cannot reuse the native bundle
            // disk cache. Each real loader therefore observes the service state.
            chatgpt_plan_type: 'enterprise',
          },
        })
      ).toString('base64url')
      await writeFile(
        join(nativeHome, 'auth.json'),
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            account_id: ACCOUNT,
            access_token: ACCESS,
            refresh_token: 'synthetic-cloud-config-recovery-refresh',
            id_token: `header.${claims}.signature`,
          },
          last_refresh: new Date().toISOString(),
        })
      )
      // Let production create and own the managed link/copy on every platform.
      await rm(join(codexHome, 'auth.json'), { force: true })
      appEnvironment.CODEX_HOME = nativeHome
      appEnvironment.WEWORK_E2E_NATIVE_CODEX_HOME = nativeHome
      // This checkpoint selects its configured native provider through real RPC.
      // Avoid unrelated custom catalog reconciliation: its restart endpoint must
      // preflight model/list, which would consume the failure before thread/resume.
      appEnvironment.WEWORK_E2E_SEED_LOCAL_MODELS = 'false'
      delete appEnvironment.OPENAI_API_KEY
      const configPath = join(codexHome, 'config.toml')
      const config = await readFile(configPath, 'utf8')
      await writeFile(
        configPath,
        `openai_base_url = "${control.url}/backend-api/codex"\nchatgpt_base_url = "http://127.0.0.1:${server.address().port}/backend-api/"\n${config}`
      )
    },
    attachServer(modelServer) {
      modelServer.on('upgrade', (_request, socket) => {
        rejectModelWebSocketUpgrade(modelServer, socket)
      })
    },
    async failBundle() {
      unavailable = true
      // Codex first loads bootstrap settings, then installs its long-lived cloud
      // loader. Drop the service between those two real requests so the configured
      // local origin survives and the second loader caches the genuine failure.
      bootstrapBundles = 1
      // This is solely the isolated fixture's Codex cache. A cold process must
      // consult the failing service instead of reusing an identity-matched bundle.
      await rm(join(codexHome, 'cloud-config-bundle-cache.json'), { force: true })
      return bundleFailures
    },
    recoverBundle() {
      unavailable = false
    },
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !url.pathname.endsWith('/responses')) return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (body.generate === false) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(createSse([responseCreated('warmup'), responseCompleted('warmup')]))
        return true
      }
      const serialized = JSON.stringify(body)
      const plan = [...plans.values()].reverse().find(value => serialized.includes(value.marker))
      assert.ok(plan, 'A foreground model request did not belong to the recovery fixture')
      const round = plan.rounds[plan.count++]
      assert.ok(round, `Unexpected model continuation for ${plan.marker}: ${plan.count}`)
      plan.calls.push({ body, at: Date.now() })
      const subscription = url.pathname === '/backend-api/codex/responses'
      if (subscription) {
        const [nativeAuth, managedAuth, nativeMarker, managedMarker] = await Promise.all([
          authFileMetadata(join(nativeHome, 'auth.json')),
          authFileMetadata(join(codexHome, 'auth.json')),
          authFileMetadata(join(nativeHome, '.wework-managed-auth')),
          authFileMetadata(join(codexHome, '.wework-managed-auth')),
        ])
        const snapshot = {
          marker: plan.marker,
          nativeAuth,
          managedAuth,
          nativeMarker,
          managedMarker,
        }
        authSnapshots.push(snapshot)
        console.info('[desktop-e2e] subscription auth file metadata', JSON.stringify(snapshot))
        assert.equal(request.headers.authorization, `Bearer ${ACCESS}`)
        assert.equal(request.headers['chatgpt-account-id'], ACCOUNT)
      }
      requests.push({ marker: plan.marker, round: plan.count, subscription })
      if (round.usageLimit) {
        const resetsAt = round.usageLimit()
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            error: {
              type: 'usage_limit_reached',
              code: 'usage_limit_reached',
              message: 'Synthetic subscription usage limit reached',
              plan_type: 'enterprise',
              resets_at: resetsAt,
            },
          })
        )
        return true
      }
      const id = `cloud-config-${requests.length}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(createSse([responseCreated(id)]))
      if (round.held) {
        await Promise.race([round.held, new Promise(resolve => response.once('close', resolve))])
      }
      if (response.destroyed) return true
      await round.beforeComplete?.()
      response.end(
        createSse([
          ...(round.tool
            ? selectedToolCall(
                `${id}-tool`,
                selectTool(body, round.tool.name, round.tool.arguments)
              )
            : [assistantMessage(round.text ?? `${plan.marker}_COMPLETE`)]),
          responseCompleted(id),
        ])
      )
      return true
    },
    diagnostics() {
      return {
        unavailable,
        bundleFailures,
        bundleSuccesses,
        accountChecks,
        requests,
        authSnapshots,
      }
    },
    async close() {
      for (const release of releases) release()
      if (!server) return
      server.closeAllConnections()
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    },
  }
}
