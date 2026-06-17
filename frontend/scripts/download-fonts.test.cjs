// SPDX-FileCopyrightText: 2025 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

const assert = require('assert')
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const test = require('node:test')

const SCRIPT_PATH = path.join(__dirname, 'download-fonts.cjs')

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-fonts-'))
  const scriptDir = path.join(root, 'scripts')
  const appDir = path.join(root, 'src', 'app')
  fs.mkdirSync(scriptDir, { recursive: true })
  fs.mkdirSync(appDir, { recursive: true })
  fs.copyFileSync(SCRIPT_PATH, path.join(scriptDir, 'download-fonts.cjs'))
  return {
    root,
    scriptPath: path.join(scriptDir, 'download-fonts.cjs'),
    cssPath: path.join(appDir, 'google-sans-local.css'),
  }
}

function createFontServer() {
  let baseUrl = ''
  const server = http.createServer((req, res) => {
    if (req.url === '/google.css') {
      res.writeHead(200, { 'content-type': 'text/css' })
      res.end(
        [
          '@font-face {',
          "  font-family: 'Google Sans';",
          `  src: url('${baseUrl}/fonts/test.woff2') format('woff2');`,
          '}',
          '',
        ].join('\n')
      )
      return
    }

    if (req.url === '/fonts/test.woff2') {
      res.writeHead(200, { 'content-type': 'font/woff2' })
      res.end(Buffer.from('font-bytes'))
      return
    }

    res.writeHead(404)
    res.end()
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      baseUrl = `http://${address.address}:${address.port}`
      resolve({
        cssUrl: `${baseUrl}/google.css`,
        close: () => new Promise(closeResolve => server.close(closeResolve)),
      })
    })
  })
}

function runDownloadScript(scriptPath, cssUrl, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(path.dirname(scriptPath)),
      env: {
        ...process.env,
        SKIP_FONT_DOWNLOAD: '0',
        SKIP_PDF_FONT_DOWNLOAD: '1',
        SKIP_UI_FONT_DOWNLOAD: '0',
        GOOGLE_SANS_CSS_URLS: cssUrl,
        ...extraEnv,
      },
      stdio: 'pipe',
    })

    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(output)
        return
      }
      reject(new Error(`download-fonts exited with ${code}\n${output}`))
    })
  })
}

test('regular install does not rewrite existing tracked Google Sans CSS', async () => {
  const fixture = createFixture()
  const server = await createFontServer()
  const trackedCss = '/* tracked css */\n'

  try {
    fs.writeFileSync(fixture.cssPath, trackedCss, 'utf8')

    await runDownloadScript(fixture.scriptPath, server.cssUrl)

    assert.strictEqual(fs.readFileSync(fixture.cssPath, 'utf8'), trackedCss)

    await runDownloadScript(fixture.scriptPath, server.cssUrl, {
      REFRESH_UI_FONT_CSS: '1',
    })

    assert.match(
      fs.readFileSync(fixture.cssPath, 'utf8'),
      /url\('\/fonts\/google-sans\/01-test\.woff2'\)/
    )
  } finally {
    await server.close()
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})
