import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const require = createRequire(new URL('../package.json', import.meta.url))
const electronRequire = createRequire(new URL('../electron/package.json', import.meta.url))
const { build } = createRequire(require.resolve('vite'))('esbuild')

test('native conversation size compensation and scroll rendering preserve frame coverage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-conversation-resize-'))
  try {
    const bundle = join(directory, 'fixture.js')
    await build({
      entryPoints: [
        fileURLToPath(new URL('./fixtures/conversation-resize-native.tsx', import.meta.url)),
      ],
      bundle: true,
      outfile: bundle,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      tsconfigRaw: {},
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    const main = join(directory, 'main.cjs')
    const output = join(directory, 'result.json')
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron')
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))})
app.whenReady().then(async()=>{
  const window=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}})
  await window.loadURL('data:text/html,'+encodeURIComponent('<div id="root"></div>'))
  await window.webContents.executeJavaScript(${JSON.stringify(await readFile(bundle, 'utf8'))})
  const result=await window.webContents.executeJavaScript('window.runConversationResizeContract()')
  require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(result))
  window.destroy()
  app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})`
    )
    const child = spawn(electronRequire('electron'), [main], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    })
    let diagnostics = ''
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', chunk => {
        diagnostics = (diagnostics + chunk).slice(-8000)
      })
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    assert.equal(result.code, 0, JSON.stringify({ ...result, diagnostics }))
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    assert.deepEqual(evidence.errors, [])
    assert.equal(evidence.anchorOffsets.length, 20)
    assert.equal(evidence.scrollSamples, 15)
    assert.ok(
      evidence.anchorOffsets.every(offset => Math.abs(offset) <= 1),
      JSON.stringify(evidence)
    )
    assert.deepEqual(evidence.uncovered, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
