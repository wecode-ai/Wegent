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
const wework = fileURLToPath(new URL('..', import.meta.url))

test('native multiline batches preserve structured editor paragraphs and acknowledge every Enter', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-editor-native-'))
  try {
    const bundle = join(directory, 'fixture.js')
    const keyboard = join(directory, 'keyboard.cjs')
    await build({
      entryPoints: [fileURLToPath(new URL('./fixtures/editor-native-input.tsx', import.meta.url))],
      alias: { '@': join(wework, 'src') },
      bundle: true,
      outfile: bundle,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      tsconfigRaw: {},
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    })
    await build({
      entryPoints: [join(wework, 'electron/src/host/e2e-keyboard.ts')],
      bundle: true,
      outfile: keyboard,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    })
    const preload = join(directory, 'preload.cjs')
    await writeFile(
      preload,
      `const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('insertNativeText',text=>ipcRenderer.invoke('insert-text',text))`
    )
    const html = join(directory, 'index.html')
    await writeFile(html, '<div id="root"></div>')
    const main = join(directory, 'main.cjs')
    const output = join(directory, 'result.json')
    await writeFile(
      main,
      `const {app,BrowserWindow,ipcMain}=require('electron')
const {sendE2EKey,sendE2EText}=require(${JSON.stringify(keyboard)})
const startedAt=performance.now()
const progress=(stage,details={})=>console.log('[native-editor-contract]',JSON.stringify({stage,elapsedMs:performance.now()-startedAt,...details}))
progress('main-started')
const env={VITE_WEWORK_E2E:'true',WEWORK_E2E_CONTROL_URL:'http://127.0.0.1:1'}
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))})
app.whenReady().then(async()=>{
  progress('app-ready')
  const window=new BrowserWindow({show:true,webPreferences:{backgroundThrottling:false,preload:${JSON.stringify(preload)}}})
  progress('window-created')
  const wc=window.webContents,focus=()=>{window.focus();wc.focus()}
  wc.on('render-process-gone',(_event,details)=>progress('renderer-exited',details))
  wc.on('console-message',event=>{if(event.level==='error')console.error(event.message)})
  let calls=0
  ipcMain.handle('insert-text',(_event,text)=>{calls++;return sendE2EText(wc,text,focus,env)})
  await wc.loadFile(${JSON.stringify(html)})
  progress('loaded')
  await wc.executeJavaScript(${JSON.stringify(await readFile(bundle, 'utf8'))})
  await wc.executeJavaScript('window.editorReady()')
  progress('editor-ready')
  const tick=()=>wc.executeJavaScript('window.editorTick()')
  const inputs=['first\\nsecond','first\\n\\nthird','中文第一段\\r\\n\\r\\n最后一段','\\nfirst\\n',Array.from({length:31},(_,i)=>'paragraph '+i).join('\\n\\n')]
  const results=[]
  for(const input of inputs){
    const snapshots=[]
    for(const mode of ['reference','batch']){
      progress('input-started',{mode,lines:input.split('\\n').length})
      await wc.executeJavaScript('window.resetEditor()');await wc.executeJavaScript('window.editorReady()')
      await wc.executeJavaScript('document.querySelector("[data-testid=native-description]").focus()')
      wc.selectAll();await tick()
      if(mode==='batch')await wc.executeJavaScript('window.insertEditorBatch('+JSON.stringify(input)+')')
      else {
        const lines=input.replace(/\\r\\n?/g,'\\n').split('\\n')
        for(const [index,line]of lines.entries()){
          if(index){await sendE2EKey(wc,'Enter',focus,env);await tick()}
          if(line){await wc.insertText(line);await tick()}
        }
      }
      await tick();snapshots.push(await wc.executeJavaScript('window.editorSnapshot()'))
      progress('input-finished',{mode,blocks:snapshots.at(-1).blocks})
    }
    results.push({input,reference:snapshots[0],batch:snapshots[1]})
  }
  progress('nested-inputs-started')
  const nestedInputs=[]
  await wc.executeJavaScript('new Promise(resolve=>{const frame=document.createElement("iframe");frame.onload=()=>{frame.contentDocument.querySelector("textarea").focus();resolve()};frame.srcdoc="<textarea></textarea>";document.body.append(frame)})')
  await sendE2EText(wc,${JSON.stringify('frame first\nframe second')},focus,env)
  nestedInputs.push(await wc.executeJavaScript('document.querySelector("iframe").contentDocument.querySelector("textarea").value'))
  await wc.executeJavaScript('document.querySelector("iframe").remove();const host=document.createElement("div");host.id="shadow-input";const shadow=host.attachShadow({mode:"open"});shadow.innerHTML="<textarea></textarea>";document.body.append(host);shadow.querySelector("textarea").focus()')
  await sendE2EText(wc,${JSON.stringify('shadow first\nshadow second')},focus,env)
  nestedInputs.push(await wc.executeJavaScript('document.querySelector("#shadow-input").shadowRoot.querySelector("textarea").value'))
  require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({results,calls,nestedInputs}))
  progress('finished')
  window.destroy();progress('window-destroyed');app.exit(0)
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
    t.diagnostic(diagnostics)
    assert.equal(result.code, 0, JSON.stringify({ ...result, diagnostics }))
    const evidence = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(evidence.calls, 5)
    assert.deepEqual(evidence.nestedInputs, [
      'frame first\nframe second',
      'shadow first\nshadow second',
    ])
    for (const row of evidence.results) {
      assert.deepEqual(row.batch, row.reference, row.input)
      assert.equal(row.batch.text, row.input.replace(/\r\n?/g, '\n').replaceAll('\n', ''))
    }
    assert.equal(evidence.results.at(-1).batch.blocks, 61)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
