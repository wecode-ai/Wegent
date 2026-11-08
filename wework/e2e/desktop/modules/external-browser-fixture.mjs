import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { recordBrowserStartup } from './external-browser-diagnostics.mjs'
import { preReadBrowserRuntime } from './external-browser-preread.mjs'

const CHROME_BINARY = process.env.WEWORK_E2E_EXTERNAL_CHROME_BIN || '/opt/google/chrome/chrome'
const CHROMEDRIVER_BINARY =
  process.env.WEWORK_E2E_EXTERNAL_CHROMEDRIVER_BIN || '/opt/wegent-e2e/chromedriver/chromedriver'

export async function requestExternalBrowser(baseUrl, path, body, budgetMs, fetcher = fetch) {
  const method = body === undefined ? 'GET' : 'POST'
  const started = Date.now()
  try {
    const response = await fetcher(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(budgetMs),
    })
    const { value } = await response.json()
    assert.ok(response.ok && !value?.error, `ChromeDriver ${path}: ${JSON.stringify(value)}`)
    return value
  } catch (cause) {
    const route = path.replace(/\/session\/[^/]+/, '/session/:id')
    throw new Error(
      `ChromeDriver ${method} ${route} failed after ${Date.now() - started}ms (budget ${budgetMs}ms)`,
      { cause }
    )
  }
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

/** Register the real browser only in this checkpoint's private XDG directories. */
export async function prepareExternalBrowserFixture(resultDir, timeoutMs) {
  assert.equal(process.platform, 'linux')
  await Promise.all([access(CHROME_BINARY), access(CHROMEDRIVER_BINARY)])
  const preRead = await preReadBrowserRuntime(
    process.env.WEWORK_E2E_EXTERNAL_BROWSER_PREREAD === '1'
  )
  if (preRead) {
    await writeFile(
      join(resultDir, 'external-browser-preread.json'),
      JSON.stringify(preRead, null, 2)
    )
    console.log(`[desktop-e2e] browser runtime preparation ${JSON.stringify(preRead)}`)
  }
  const root = await mkdtemp(join(tmpdir(), 'wework-external-browser-'))
  const profile = join(root, 'profile')
  const config = join(root, 'config')
  const data = join(root, 'data')
  const applications = join(data, 'applications')
  const launcher = join(root, 'browser')
  const desktopId = 'wework-external-browser.desktop'
  await Promise.all([mkdir(config), mkdir(applications, { recursive: true })])
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(
    launcher,
    '#!/bin/sh\nexec ' +
      quote(CHROME_BINARY) +
      ' --no-sandbox --disable-dev-shm-usage --user-data-dir=' +
      quote(profile) +
      ' --no-first-run --no-default-browser-check "$@"\n',
    { mode: 0o700 }
  )
  await writeFile(
    join(applications, desktopId),
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Wework E2E Chrome',
      `Exec=${launcher} %u`,
      `Icon=${join(dirname(CHROME_BINARY), 'product_logo_48.png')}`,
      'MimeType=x-scheme-handler/http;x-scheme-handler/https;',
      'NoDisplay=true',
      '',
    ].join('\n')
  )
  await writeFile(
    join(config, 'mimeapps.list'),
    `[Default Applications]\nx-scheme-handler/http=${desktopId}\nx-scheme-handler/https=${desktopId}\n`
  )
  const appEnvironment = { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data }
  let child
  let baseUrl
  let sessionId
  let disposed = false
  const preparation = []
  const preparationStarted = Date.now()
  async function record(stage, error) {
    preparation.push({
      stage,
      elapsedMs: Date.now() - preparationStarted,
      at: new Date().toISOString(),
      ...(child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode } : {}),
      ...(error ? { error: error.stack ?? String(error), cause: String(error.cause ?? '') } : {}),
    })
    await writeFile(
      join(resultDir, 'external-browser-preparation.json'),
      JSON.stringify(preparation, null, 2)
    )
  }
  async function request(path, body, budgetMs = timeoutMs) {
    return requestExternalBrowser(baseUrl, path, body, budgetMs)
  }
  async function dispose() {
    if (disposed) return
    disposed = true
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
          child?.pid && child.exitCode === null && child.signalCode === null
            ? once(child, 'exit', { signal: AbortSignal.timeout(timeoutMs) })
            : Promise.resolve()
        try {
          if (child?.pid) process.kill(-child.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
        await exited
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
  const evidence = []
  return {
    appEnvironment,
    dispose,
    async start() {
      let stopDiagnostics
      try {
        await record('start-chromedriver')
        child = spawn(
          CHROMEDRIVER_BINARY,
          [
            '--port=0',
            '--verbose',
            `--log-path=${join(resultDir, 'external-browser-chromedriver.log')}`,
          ],
          {
            detached: true,
            env: { ...process.env, ...appEnvironment },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        )
        const output = createWriteStream(join(resultDir, 'external-browser-process.log'))
        output.on('error', error =>
          console.error('External browser diagnostic write failed', error)
        )
        child.stdout.pipe(output, { end: false })
        child.stderr.pipe(output, { end: false })
        child.once('close', () => output.end())
        stopDiagnostics = recordBrowserStartup(child.pid, resultDir)
        baseUrl = `http://127.0.0.1:${await driverPort(child, timeoutMs)}`
        await record('create-browser-session')
        const session = await request('/session', {
          capabilities: {
            alwaysMatch: {
              browserName: 'chrome',
              'goog:chromeOptions': {
                binary: CHROME_BINARY,
                // Chrome rejects OS URL handoffs when --enable-automation is present.
                excludeSwitches: ['enable-automation'],
                args: [
                  `--user-data-dir=${profile}`,
                  '--no-sandbox',
                  '--disable-dev-shm-usage',
                  '--no-first-run',
                  '--no-default-browser-check',
                  '--enable-logging=stderr',
                  '--v=1',
                ],
              },
            },
          },
        })
        sessionId = session.sessionId
        assert.ok(sessionId, 'ChromeDriver did not create a real browser session')
        await record('ready')
      } catch (error) {
        await record('setup-failed', error)
        throw error
      } finally {
        await stopDiagnostics?.().catch(error =>
          console.error('External browser scheduling diagnostic write failed', error)
        )
      }
    },
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
}
