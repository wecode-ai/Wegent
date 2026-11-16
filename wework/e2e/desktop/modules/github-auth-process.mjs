// Observe process boundaries while executing the actual installed CLI/runtime.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [kind, binary, log, ...args] = process.argv.slice(2)
appendFileSync(
  log,
  `${JSON.stringify({ kind, operation: kind === 'gh' ? args.slice(0, 2) : ['launch'], configDir: process.env.GH_CONFIG_DIR })}\n`
)
const environment = { ...process.env }
if (kind === 'gh') {
  if (environment.WEWORK_E2E_GITHUB_PROXY) {
    environment.HTTPS_PROXY = environment.WEWORK_E2E_GITHUB_PROXY
    environment.SSL_CERT_FILE = environment.WEWORK_E2E_GITHUB_CA
    environment.NO_PROXY = ''
    environment.no_proxy = ''
  }
  // Only the real sync writer's token-login prepares a new revision's transport.
  // Read-only probes and interactive login/logout never prepare a synced store.
  if (args.includes('--with-token') && environment.WEWORK_E2E_GITHUB_SOCKET) {
    mkdirSync(environment.GH_CONFIG_DIR, { recursive: true })
    writeFileSync(
      join(environment.GH_CONFIG_DIR, 'config.yml'),
      `http_unix_socket: ${JSON.stringify(environment.WEWORK_E2E_GITHUB_SOCKET)}\n`
    )
  }
  // Keep synthetic protocol credentials in the isolated directory, never Keychain.
  if (args[0] === 'auth' && args[1] === 'login' && !args.includes('--insecure-storage')) {
    args.push('--insecure-storage')
  }
  const gatePath = environment.WEWORK_E2E_GITHUB_GATE
  if (gatePath && existsSync(gatePath)) {
    const gate = JSON.parse(readFileSync(gatePath, 'utf8'))
    if (
      gate.configDir === environment.GH_CONFIG_DIR &&
      args.slice(0, 2).join(' ') === gate.operation
    ) {
      writeFileSync(`${gatePath}.entered`, '')
      const deadline = Date.now() + 20_000
      while (!existsSync(`${gatePath}.released`)) {
        if (Date.now() > deadline) throw new Error('GitHub command barrier was not released')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
  }
}
// Replace this observer so Executor cancellation kills the actual CLI, too.
process.execve(binary, [binary, ...args], environment)
