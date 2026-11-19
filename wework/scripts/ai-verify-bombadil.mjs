import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const controller = join(root, 'wework/scripts/ai-verify.mjs')
export const features = {
  workbench: {
    paths: [
      'wework/src/components/layout/',
      'wework/src/features/workspace-tabs/',
      'wework/src/components/chat/',
    ],
    setup: [],
  },
  appearance: {
    paths: ['wework/src/features/appearance/'],
    setup: ['settings-button', 'settings-menu-button', 'settings-nav-appearance'],
  },
}
const shared = [
  'wework/src/components/ui/',
  'wework/src/desktop/',
  'wework/electron/src/host/',
  'wework/e2e/desktop/bombadil/',
  'wework/scripts/ai-verify',
]

export function selectSuites(paths) {
  const suites = new Set()
  const uncovered = []
  for (const path of paths) {
    const matches = Object.entries(features).filter(([, feature]) =>
      feature.paths.some(prefix => path.startsWith(prefix))
    )
    if (shared.some(prefix => path.startsWith(prefix)))
      Object.keys(features).forEach(id => suites.add(id))
    else if (matches.length) matches.forEach(([id]) => suites.add(id))
    else if (/^(wework|packages)\//.test(path) && /\.(?:[cm]?[jt]sx?|css|json)$/.test(path))
      uncovered.push(path)
  }
  return { suites: [...suites].sort(), uncovered }
}

export function validateOptions(options) {
  const allowed = ['base', 'suite', 'seconds', 'plan', 'binary', 'packaged']
  for (const key of Object.keys(options))
    if (!allowed.includes(key)) throw new Error(`Unknown Bombadil option: --${key}`)
  for (const key of ['plan', 'packaged'])
    if (options[key] !== undefined && !['true', 'false'].includes(options[key]))
      throw new Error(`--${key} must be true or false`)
  if (options.suite && !Object.hasOwn(features, options.suite))
    throw new Error(`Unknown suite: ${options.suite}`)
  const seconds = Number(options.seconds ?? 30)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600)
    throw new Error('--seconds must be between 1 and 600 per suite')
  return seconds
}

async function cli(args) {
  const { stdout } = await exec(process.execPath, [controller, ...args], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout
}

export async function waitForSinglePage(
  readPages,
  { timeoutMs = 10_000, poll = () => new Promise(done => setTimeout(done, 100)) } = {}
) {
  const deadline = Date.now() + timeoutMs
  let pages = []
  while (Date.now() < deadline) {
    pages = await readPages()
    if (pages.length === 1) return pages[0]
    await poll()
  }
  throw new Error('Expected one isolated page after splash handoff; observed ' + pages.length)
}

async function connection(sessionPath) {
  const session = JSON.parse(await readFile(sessionPath, 'utf8'))
  const [port] = (
    await readFile(join(session.directory, 'user-data/DevToolsActivePort'), 'utf8')
  ).split('\n')
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('Invalid isolated debugger port')
  const endpoint = 'http://127.0.0.1:' + port
  const page = await waitForSinglePage(async () => {
    const response = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(1000) })
    if (!response.ok) throw new Error('Could not inspect isolated debugger targets')
    return (await response.json()).filter(target => target.type === 'page')
  })
  const url = new URL(page.url)
  if (url.hostname !== '127.0.0.1') throw new Error('Expected isolated loopback Wework origin')
  return { endpoint, origin: url.origin }
}

async function runSuite(id, options, seconds, binary, output, signal, prepared) {
  let sessionPath
  const result = { suite: id, seconds, status: 'failed' }
  try {
    const stdout = await cli([
      'start',
      '--bombadil',
      'true',
      '--packaged',
      options.packaged ?? 'false',
      '--prepared',
      String(prepared),
    ])
    const start = stdout.match(/\{\s*"session"[\s\S]*\}\s*$/)
    if (!start) throw new Error('Verification start did not return a session')
    sessionPath = JSON.parse(start[0]).session
    signal.throwIfAborted()
    const snapshot = JSON.parse(await cli(['snapshot', '--session', sessionPath]))
    if (snapshot.testIds.includes('telemetry-consent-decline'))
      await cli([
        'click',
        '--session',
        sessionPath,
        '--selector',
        '[data-testid="telemetry-consent-decline"]',
      ])
    for (const selectorId of features[id].setup)
      await cli(['click', '--session', sessionPath, '--selector', `[data-testid="${selectorId}"]`])
    const { endpoint, origin } = await connection(sessionPath)
    const args = [
      'browser',
      'test-external',
      '--remote-debugger',
      endpoint,
      '--time-limit',
      `${seconds}s`,
      '--exit-on-violation',
      '--output-path',
      join(output, id),
      origin,
      join(root, `wework/e2e/desktop/bombadil/${id}.ts`),
    ]
    const { stdout: log, stderr } = await exec(binary, args, {
      cwd: root,
      signal,
      timeout: (seconds + 30) * 1000,
      maxBuffer: 16 * 1024 * 1024,
    })
    await writeFile(join(output, `${id}.log`), log + stderr)
    const records = (await readFile(join(output, id, 'trace.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(JSON.parse)
    result.actions = records.filter(record => record.action).length
    result.paths = [
      ...new Set(
        records
          .filter(record => record.state?.url)
          .map(record => new URL(record.state.url).pathname)
      ),
    ]
    if (!result.actions) throw new Error('Bombadil completed without exploring any actions')
    result.status = 'passed'
  } catch (error) {
    result.error = error.message.split('\n')[0]
    result.exitCode = error.code
    await writeFile(
      join(output, `${id}.error.log`),
      String(error.stdout ?? '') + String(error.stderr ?? '') + '\n' + error.message
    )
  } finally {
    if (sessionPath) {
      try {
        await cli(['stop', '--session', sessionPath])
      } catch (error) {
        result.status = 'failed'
        result.cleanupError = error.message
      }
    }
  }
  return result
}

export async function runBombadil(options) {
  const seconds = validateOptions(options)
  let plan
  if (options.suite) plan = { suites: [options.suite], uncovered: [] }
  else {
    if (!options.base) throw new Error('Supply --base REF for changed features or --suite NAME')
    const { stdout: base } = await exec('git', ['merge-base', '--', options.base, 'HEAD'], {
      cwd: root,
    })
    const { stdout } = await exec(
      'git',
      ['diff', '--name-only', '-z', '--no-renames', base.trim(), 'HEAD'],
      { cwd: root }
    )
    plan = { ...selectSuites(stdout.split('\0').filter(Boolean)), base: base.trim() }
  }
  console.log(JSON.stringify({ ...plan, secondsPerSuite: seconds }, null, 2))
  if (options.plan === 'true') return
  if (plan.uncovered.length)
    throw new Error(
      'Changed features lack Bombadil coverage; inspect --plan true and extend the feature map'
    )
  if (!plan.suites.length) return
  const binary = options.binary ?? process.env.BOMBADIL_BIN ?? 'bombadil'
  const { stdout: version } = await exec(binary, ['--version'])
  if (version.trim() !== 'bombadil 0.7.10')
    throw new Error(
      'Use Bombadil 0.7.10; specifications and trace reader are pinned to this version'
    )
  const output = join(
    root,
    'wework/test-results/bombadil',
    new Date().toISOString().replace(/[:.]/g, '-')
  )
  await mkdir(output, { recursive: true })
  const results = []
  const cancellation = new AbortController()
  const cancel = () => cancellation.abort(new Error('Exploration interrupted'))
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    for (const id of plan.suites) {
      results.push(
        await runSuite(
          id,
          options,
          seconds,
          binary,
          output,
          cancellation.signal,
          results.some(result => result.status === 'passed')
        )
      )
      if (cancellation.signal.aborted) break
    }
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
  }
  const summary = { version: version.trim(), plan, results }
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  console.log(JSON.stringify({ output, ...summary }, null, 2))
  if (results.some(result => result.status !== 'passed')) process.exitCode = 1
}
