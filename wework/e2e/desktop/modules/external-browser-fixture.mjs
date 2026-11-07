import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const CHROME_BUNDLE_ID = 'com.google.Chrome'

async function defaultBrowser(bundleId, timeoutMs) {
  const script = `function run(argv) {
    ObjC.import('AppKit')
    ObjC.import('CoreServices')
    if (argv.length) {
      // macOS confirms a default-browser change through the HTTP scheme.
      // Setting HTTPS directly fails with permErr even for the current browser.
      const status = $.LSSetDefaultHandlerForURLScheme($('http'), $(argv[0]))
      if (status !== 0) throw new Error('Requesting default browser failed: ' + status)
    }
    const handlers = {}
    for (const scheme of ['http', 'https']) {
      const url = $.NSURL.URLWithString(scheme + '://example.com')
      const app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url)
      handlers[scheme] = ObjC.unwrap($.NSBundle.bundleWithURL(app).bundleIdentifier)
    }
    return JSON.stringify(handlers)
  }`
  const query = async target => {
    const { stdout } = await executeFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', script, ...(target ? [target] : [])],
      { timeout: timeoutMs }
    )
    return JSON.parse(stdout)
  }
  const current = await query()
  if (!bundleId) {
    assert.equal(current.http, current.https, 'The fixture requires one default web browser')
    return current.https
  }
  const matches = handlers => handlers.http === bundleId && handlers.https === bundleId
  if (matches(current)) return bundleId
  await query(bundleId)
  const deadline = Date.now() + timeoutMs
  const applicationName = bundleId === CHROME_BUNDLE_ID ? 'Google Chrome' : 'Safari'
  let dialog = ''
  while (Date.now() < deadline) {
    if (matches(await query())) return bundleId
    const { stdout } = await executeFile(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        `function run(argv) {
          const process = Application('System Events').processes.byName('CoreServicesUIAgent')
          if (!process.exists()) return 'No confirmation process'
          const names = []
          for (const window of process.windows()) {
            for (const button of window.buttons()) {
              const name = button.name()
              names.push(name)
              if (name.startsWith('Use ') && name.includes(argv[0])) button.click()
            }
          }
          return JSON.stringify(names)
        }`,
        applicationName,
      ],
      { timeout: Math.max(1, deadline - Date.now()) }
    )
    dialog = stdout.trim()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Default browser confirmation failed: ' + bundleId + '; dialog=' + dialog)
}

function driverPort(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(
      () => finish(new Error('ChromeDriver did not become ready')),
      timeoutMs
    )
    const exited = code =>
      finish(new Error(`ChromeDriver exited before startup: ${code}; ${output}`))
    const received = chunk => {
      output = (output + chunk.toString()).slice(-4096)
      const match = output.match(/ChromeDriver was started successfully on port (\d+)/)
      if (match) finish(null, Number(match[1]))
    }
    function finish(error, port) {
      clearTimeout(timer)
      child.stdout.off('data', received)
      child.stderr.off('data', received)
      child.off('error', finish)
      child.off('exit', exited)
      if (error) reject(error)
      else resolve(port)
    }
    child.stdout.on('data', received)
    child.stderr.on('data', received)
    child.once('error', finish)
    child.once('exit', exited)
  })
}

/** Use only the disposable CI macOS account, never a developer's browser profile. */
export async function startExternalBrowserFixture(resultDir, timeoutMs) {
  assert.equal(process.platform, 'darwin')
  assert.equal(
    process.env.CI,
    'true',
    'External browser verification requires a disposable CI account'
  )
  const originalBrowser = await defaultBrowser(null, timeoutMs)
  assert.ok(originalBrowser, 'The runner has no HTTPS default browser')
  assert.ok(process.env.CHROMEWEBDRIVER, 'The runner must provide its preinstalled ChromeDriver')
  const profile = await mkdtemp(join(tmpdir(), 'wework-external-browser-'))
  const child = spawn(join(process.env.CHROMEWEBDRIVER, 'chromedriver'), ['--port=0'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let baseUrl
  let sessionId
  let browserChangeRequested = false
  const preparation = []
  async function record(stage, error) {
    preparation.push({ stage, ...(error ? { error: error.stack ?? String(error) } : {}) })
    await writeFile(
      join(resultDir, 'external-browser-preparation.json'),
      JSON.stringify(preparation, null, 2)
    )
  }
  async function request(path, body, budgetMs = timeoutMs) {
    const response = await fetch(baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(budgetMs),
    })
    const { value } = await response.json()
    assert.ok(response.ok && !value?.error, `ChromeDriver ${path}: ${JSON.stringify(value)}`)
    return value
  }
  async function dispose() {
    try {
      if (browserChangeRequested) await defaultBrowser(originalBrowser, timeoutMs)
    } finally {
      try {
        if (sessionId) {
          const response = await fetch(`${baseUrl}/session/${sessionId}`, {
            method: 'DELETE',
            signal: AbortSignal.timeout(timeoutMs),
          })
          assert.ok(response.ok, 'ChromeDriver could not close the isolated browser')
        }
      } finally {
        try {
          const exited =
            child.pid && child.exitCode === null && child.signalCode === null
              ? once(child, 'exit', { signal: AbortSignal.timeout(timeoutMs) })
              : Promise.resolve()
          try {
            if (child.pid) process.kill(-child.pid, 'SIGTERM')
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
          await exited
        } finally {
          await rm(profile, { recursive: true, force: true })
        }
      }
    }
  }
  try {
    await record('start-chromedriver')
    baseUrl = `http://127.0.0.1:${await driverPort(child, timeoutMs)}`
    await record('create-browser-session')
    const session = await request('/session', {
      capabilities: {
        alwaysMatch: {
          browserName: 'chrome',
          'goog:chromeOptions': {
            binary: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            args: [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'],
          },
        },
      },
    })
    sessionId = session.sessionId
    assert.ok(sessionId, 'ChromeDriver did not create a real browser session')
    await record('configure-default-browser')
    browserChangeRequested = true
    await defaultBrowser(CHROME_BUNDLE_ID, timeoutMs)
    await record('ready')
    const evidence = []
    return {
      dispose,
      async waitForPage(expectedUrl, expectedText) {
        const deadline = Date.now() + timeoutMs
        let pages = []
        while (Date.now() < deadline) {
          const remaining = () => Math.max(1, deadline - Date.now())
          const handles = await request(
            `/session/${sessionId}/window/handles`,
            undefined,
            remaining()
          )
          pages = []
          for (const handle of handles) {
            await request(`/session/${sessionId}/window`, { handle }, remaining())
            const page = await request(
              `/session/${sessionId}/execute/sync`,
              {
                script:
                  'return {url: location.href, title: document.title, text: document.body?.innerText ?? ""}',
                args: [],
              },
              remaining()
            )
            pages.push(page)
            if (page.url === expectedUrl && page.text.includes(expectedText)) {
              evidence.push(page)
              await writeFile(
                join(resultDir, 'external-browser-pages.json'),
                JSON.stringify(evidence, null, 2)
              )
              return
            }
          }
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error(
          `External Chrome did not display ${expectedUrl}; pages=${JSON.stringify(pages)}`
        )
      },
    }
  } catch (error) {
    await record('setup-failed', error)
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'External browser setup and cleanup failed', {
        cause: error,
      })
    }
    throw error
  }
}
