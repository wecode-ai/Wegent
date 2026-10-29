// Unit fixture: only the Electron/process-exit boundary is doubled. The parent
// recovery reader, generated child publisher, filesystem and IPC gates are real.
const childProcess = require('node:child_process')
const fs = require('node:fs/promises')
const { syncBuiltinESMExports } = require('node:module')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

async function writer(script, input, writeDelayMs) {
  process.argv = [process.execPath, script, input, 'verify']
  const fileSystem = {
    ...fs,
    async writeFile(file, data, options) {
      if (!path.basename(file).startsWith('evidence.json')) return fs.writeFile(file, data, options)
      const handle = await fs.open(file, 'w', options?.mode ?? 0o600)
      process.send({
        event: 'opened',
        file: path.basename(file),
        bytes: (await handle.stat()).size,
      })
      await new Promise(resolve => process.once('message', resolve))
      try {
        if (writeDelayMs) await new Promise(resolve => setTimeout(resolve, writeDelayMs))
        await handle.writeFile(data, options)
      } finally {
        await handle.close()
      }
      process.send({ event: 'written', bytes: Buffer.byteLength(data) })
    },
    async rename(source, target) {
      await fs.rename(source, target)
      process.send({ event: 'published', file: path.basename(target) })
    },
  }
  const electron = {
    app: {
      setPath() {},
      async whenReady() {
        throw new Error('Recovery verification failed')
      },
      exit() {
        process.exit(0)
      },
    },
  }
  await vm.runInNewContext(
    await fs.readFile(script, 'utf8'),
    {
      require: name =>
        name === 'electron' ? electron : name === 'node:fs/promises' ? fileSystem : require(name),
      process,
      Buffer,
      console,
    },
    { filename: script }
  )
}

async function completedWriter(input, mode, evidence) {
  await fs.writeFile(
    path.join(input.root, 'evidence.json'),
    mode === 'malformed' ? '{"broken":' : JSON.stringify(evidence)
  )
  for (const name of ['runtime-confirmation.png', 'user-confirmation.png', 'cleanup-failure.png']) {
    await fs.writeFile(path.join(input.root, name), 'unit diagnostic fixture')
  }
  await fs.writeFile(path.join(input.root, 'recovery.log'), 'app-state cleanup: failed\n')
  await fs.mkdir(path.join(input.root, 'user-data'), { recursive: true })
  await fs.writeFile(path.join(input.root, 'user-data', 'private-fixture'), 'synthetic credential')
}

async function reader(mode, root, modulePath, evidence) {
  const readFile = fs.readFile
  const fork = childProcess.fork
  const events = []
  let child
  let childExited
  let released = false
  childProcess.execFile = (_binary, args, _options, callback) => {
    if (mode !== 'race') {
      void completedWriter(JSON.parse(args[1]), mode, evidence).then(
        () => callback(null, '', ''),
        callback
      )
      return
    }
    child = fork(__filename, ['writer', args[0], args[1], String(evidence.writeDelayMs ?? 0)], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    childExited = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code))
    })
    child.on('message', event => {
      events.push(event)
      // The original process exits before its relaunched writer finishes.
      if (event.event === 'opened') callback(null, '', '')
    })
  }
  fs.readFile = async (file, ...args) => {
    if (mode !== 'race' || typeof file !== 'string' || path.basename(file) !== 'evidence.json') {
      return readFile(file, ...args)
    }
    try {
      const contents = await readFile(file, ...args)
      events.push({ event: 'read', bytes: Buffer.byteLength(contents) })
      return contents
    } catch (error) {
      events.push({ event: 'read-missing', code: error.code })
      throw error
    } finally {
      if (!released) {
        released = true
        child.send('finish-write')
      }
    }
  }
  syncBuiltinESMExports()
  const { verifyStartupRecovery } = await import(pathToFileURL(modulePath).href)
  const result = { events }
  try {
    result.evidence = await verifyStartupRecovery({
      resultDir: root,
      electronRoot: root,
      appBinary: '/unused',
    })
  } catch (error) {
    result.failure = { name: error.name, message: error.message }
  } finally {
    result.writerExitCode = await childExited
  }
  process.stdout.write(JSON.stringify(result))
}

const [mode, root, modulePath, evidence] = process.argv.slice(2)
;(mode === 'writer'
  ? writer(root, modulePath, Number(evidence))
  : reader(mode, root, modulePath, JSON.parse(evidence))
).catch(error => {
  console.error(error)
  process.exit(1)
})
