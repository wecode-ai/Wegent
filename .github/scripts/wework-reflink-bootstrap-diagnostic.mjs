import fs from 'node:fs'
import physicalFs from 'original-fs'
import { join } from 'node:path'

const resources = process.resourcesPath
const archive = join(resources, 'app.asar')
const extracted = join(resources, 'app')
function copyDirectory(source, target) {
  physicalFs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(source)) {
    const entry = join(source, name)
    const destination = join(target, name)
    if (fs.statSync(entry).isDirectory()) copyDirectory(entry, destination)
    else physicalFs.writeFileSync(destination, fs.readFileSync(entry))
  }
}
copyDirectory(archive, extracted)
const bootstrap = join(extracted, 'dist', 'runtime', 'electron-node-runtime.js')
const source = physicalFs.readFileSync(bootstrap, 'utf8')
const marker = 'const ELECTRON_NODE_BOOTSTRAP = `'
if (!source.includes(marker)) throw new Error('Bootstrap constant not found')
const hook = `
const diagnosticModule = require('node:module')
const diagnosticLoad = diagnosticModule._load
let diagnosticClones = 0
diagnosticModule._load = function(request, ...args) {
  const loaded = diagnosticLoad.call(this, request, ...args)
  if (request === '@reflink/reflink' && !loaded.__weworkCloneDiagnostic) {
    const clone = loaded.reflinkFileSync
    loaded.reflinkFileSync = function(source, destination) {
      if (diagnosticClones++ < 20 || !/^[A-Za-z]:/.test(source)) {
        require('node:fs').writeSync(2, '[reflink-probe] ' + JSON.stringify({ source, destination, cwd: process.cwd() }) + String.fromCharCode(10))
      }
      return clone.apply(this, arguments)
    }
    loaded.__weworkCloneDiagnostic = true
  }
  return loaded
}
`
physicalFs.writeFileSync(bootstrap, source.replace(marker, marker + hook))
physicalFs.renameSync(archive, archive + '.diagnostic-backup')
console.log('Instrumented diagnostic package bootstrap without altering clone results')
