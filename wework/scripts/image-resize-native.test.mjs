import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

const require = createRequire(new URL('../package.json', import.meta.url))
const electronRequire = createRequire(new URL('../electron/package.json', import.meta.url))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const imageEntry = createRequire(require.resolve('@file-viewer/preset-lite'))
  .resolve('@file-viewer/renderer-image')
  .replace(/index\.js$/, 'image.js')

test('native image resizing preserves decoded fit without ResizeObserver errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-image-resize-'))
  try {
    const bundle = join(directory, 'fixture.js')
    await build({
      stdin: {
        resolveDir: dirname(imageEntry),
        contents: `import render from ${JSON.stringify(imageEntry)}
window.runImageResizeContract = async () => {
  const errors = []
  const startedAt = performance.now()
  const progress = (stage, details = {}) => console.log(JSON.stringify({
    stage, elapsedMs: performance.now() - startedAt, visibility: document.visibilityState, ...details
  }))
  progress('started')
  window.addEventListener('error', event => errors.push(event.message))
  const frames = async (count = 3) => {
    for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame)
  }
  const samples = []
  for (const size of [1, 256, 1024]) {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    progress('encoding', { size })
    const buffer = await (await new Promise(resolve => canvas.toBlob(resolve))).arrayBuffer()
    progress('encoded', { size })
    const target = document.createElement('div')
    target.style.cssText = 'width:611px;height:603px;overflow:auto'
    document.body.append(target)
    const viewer = await render(buffer, target, 'png', {})
    progress('renderer-created', { size })
    const image = target.querySelector('.image-stage img')
    if (!image.complete) await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = reject
    })
    progress('decoded', { size, naturalWidth: image.naturalWidth })
    await frames()
    for (const width of [100, 420, 611, 324, 800, 611]) {
      target.style.width = width + 'px'
      await frames()
      progress('resized', { size, width })
      samples.push({ size, naturalWidth: image.naturalWidth,
        width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height })
    }
    target.style.width = '300px'
    viewer.unmount()
    await frames()
    if (target.childNodes.length) throw Error('Image unmount retained content')
    target.remove()
  }
  return { errors, samples }
}`,
      },
      bundle: true,
      outfile: bundle,
      platform: 'browser',
      format: 'iife',
    })
    const output = join(directory, 'result.json')
    const main = join(directory, 'main.cjs')
    await writeFile(
      main,
      `const {app,BrowserWindow}=require('electron')
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))})
app.whenReady().then(async()=>{
  const window=new BrowserWindow({show:true,focusable:false,webPreferences:{backgroundThrottling:false}})
  window.webContents.on('console-message', event => console.log('[image-resize-contract]', event.message))
  window.webContents.on('render-process-gone', (_event, details) => console.error('[image-resize-contract] renderer exited', JSON.stringify(details)))
  await window.loadURL('data:text/html,<body>')
  if (!window.isVisible()) throw new Error('Image layout verification requires a visible native window')
  await window.webContents.executeJavaScript(${JSON.stringify(await readFile(bundle, 'utf8'))})
  const result=await window.webContents.executeJavaScript('window.runImageResizeContract()')
  require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(result))
  window.destroy()
  console.log('[image-resize-contract] window-destroyed')
  app.exit(0)
}).catch(error=>{console.error(error);app.exit(1)})`
    )
    const child = spawn(electronRequire('electron'), [main], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      killSignal: 'SIGKILL',
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
    const evidence = JSON.parse(
      await readFile(output, 'utf8').catch(error => {
        throw new Error(
          `Native image contract produced no readable result: ${JSON.stringify({ ...result, diagnostics })}`,
          { cause: error }
        )
      })
    )
    assert.match(diagnostics, /"stage":"decoded"/)
    assert.match(diagnostics, /"stage":"resized"/)
    assert.deepEqual(evidence.errors, [])
    assert.equal(evidence.samples.length, 18)
    for (const sample of evidence.samples) {
      assert.equal(sample.naturalWidth, sample.size)
      assert.ok(sample.width > 0 && sample.width <= sample.size, JSON.stringify(sample))
      assert.equal(sample.width, sample.height)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
