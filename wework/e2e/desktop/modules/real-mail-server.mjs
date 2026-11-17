import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer, connect } from 'node:net'
import { reservePort } from '../port-reservation.mjs'

const run = promisify(execFile)
// GreenMail 2.1.15 fixes APPEND noon timestamps being parsed as midnight.
const VERSION = '2.1.15'
const SHA256 = '91d58798698cac357f015365240383b936ced2f2a1a9f7db37d9e3e1a31391b1'

async function startImapProxy(port, targetPort) {
  let online = true
  const sockets = new Set()
  const track = socket => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  }
  const server = createServer(socket => {
    track(socket)
    if (!online) return socket.destroy()
    const upstream = connect(targetPort, '127.0.0.1')
    track(upstream)
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    pause() {
      online = false
      for (const socket of sockets) socket.destroy()
    },
    resume() {
      online = true
    },
    async close() {
      online = false
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

// GreenMail is a real, isolated IMAP/SMTP service. No production mailboxes are used.
export async function startRealMailServer(directory, runtimeRoot) {
  const { stdout, stderr } = await run('java', ['-version'])
  const version = `${stdout}\n${stderr}`.match(/version "(?:1\.)?(\d+)/)?.[1]
  assert.ok(
    Number(version) >= 11,
    `GreenMail ${VERSION} requires Java 11 or newer on PATH; select a supported JDK before running the mail checkpoint. Detected: ${stdout.trim()} ${stderr.trim()}`
  )
  await mkdir(directory, { recursive: true })
  const jar = join(directory, 'greenmail.jar')
  const response = await fetch(
    `https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/${VERSION}/greenmail-standalone-${VERSION}.jar`
  )
  assert.equal(response.ok, true, `GreenMail download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(createHash('sha256').update(bytes).digest('hex'), SHA256)
  await writeFile(jar, bytes)
  const certificate = join(directory, 'mail-ca.pem')
  const keystore = join(directory, 'mail.p12')
  const fixturePassword = 'isolated-mail-test'
  await run('keytool', [
    '-genkeypair',
    '-alias',
    'mail',
    '-keyalg',
    'RSA',
    '-keystore',
    keystore,
    '-storetype',
    'PKCS12',
    '-storepass',
    fixturePassword,
    '-keypass',
    fixturePassword,
    '-dname',
    'CN=localhost',
    '-ext',
    'SAN=dns:localhost,ip:127.0.0.1',
    '-validity',
    '2',
    '-noprompt',
  ])
  await run('keytool', [
    '-exportcert',
    '-rfc',
    '-alias',
    'mail',
    '-keystore',
    keystore,
    '-storepass',
    fixturePassword,
    '-file',
    certificate,
  ])
  const require = createRequire(join(runtimeRoot, 'package.json'))
  const { ImapFlow } = require('imapflow')
  const nodemailer = require('nodemailer')
  const ca = await readFile(certificate)
  const imapPort = await reservePort()
  const smtpPort = await reservePort(undefined, { excludedPorts: [imapPort] })
  const apiPort = await reservePort(undefined, { excludedPorts: [imapPort, smtpPort] })
  const proxyPort = await reservePort(undefined, { excludedPorts: [imapPort, smtpPort, apiPort] })
  const proxy = await startImapProxy(proxyPort, imapPort)
  const log = createWriteStream(join(directory, 'greenmail.log'))
  const child = spawn(
    'java',
    [
      '-Xms16m',
      '-Xmx128m',
      '-Dgreenmail.hostname=127.0.0.1',
      '-Dgreenmail.imaps.hostname=127.0.0.1',
      `-Dgreenmail.imaps.port=${imapPort}`,
      '-Dgreenmail.smtps.hostname=127.0.0.1',
      `-Dgreenmail.smtps.port=${smtpPort}`,
      '-Dgreenmail.users=owner:isolated-mail-test@example.com,sender:isolated-mail-test@example.com',
      `-Dgreenmail.api.port=${apiPort}`,
      `-Dgreenmail.tls.keystore.file=${keystore}`,
      `-Dgreenmail.tls.keystore.password=${fixturePassword}`,
      '-jar',
      jar,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  child.stdout.pipe(log)
  child.stderr.pipe(log, { end: false })
  let output = ''
  child.stdout.on('data', chunk => {
    output += chunk.toString()
  })
  child.stderr.on('data', chunk => {
    output += chunk.toString()
  })
  const config = {
    email: 'owner@example.com',
    username: 'owner',
    password: fixturePassword,
    imap: { host: 'localhost', port: proxyPort, secure: true },
    smtp: { host: 'localhost', port: smtpPort, secure: true },
  }
  const imap = async (username, action) => {
    const client = new ImapFlow({
      ...config.imap,
      auth: { user: username, pass: fixturePassword },
      tls: { ca },
      logger: false,
      connectionTimeout: 10000,
      socketTimeout: 10000,
    })
    client.on('error', () => {})
    try {
      await client.connect()
      await client.mailboxOpen('INBOX', { readOnly: true })
      return await action(client)
    } finally {
      client.close()
    }
  }
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('GreenMail did not announce IMAPS/SMTPS readiness')),
      15000
    )
    const observe = () => {
      if (output.includes(`Starting GreenMail API server at http://127.0.0.1:${apiPort}/`)) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout.on('data', observe)
    child.stderr.on('data', observe)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`GreenMail exited ${code}`))
    })
    observe()
  })
  const stop = async () => {
    await proxy.close()
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('close', resolve))
      child.kill()
      await exited
    }
    log.end()
  }
  try {
    await ready
    await imap('owner', () => {})
  } catch (error) {
    await stop()
    throw error
  }
  return {
    config,
    certificate,
    stop,
    pauseImap: () => proxy.pause(),
    resumeImap: () => proxy.resume(),
    async append(subject, text, messageId, internalDate) {
      assert.ok(internalDate instanceof Date && Number.isFinite(internalDate.getTime()))
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true })
      const encoded = await transport.sendMail({
        from: 'sender@example.com',
        to: config.email,
        subject,
        text,
        messageId,
        date: internalDate,
      })
      return imap('owner', async client => {
        const added = await client.append('INBOX', encoded.message, [], internalDate)
        assert.ok(added.uid, 'Real IMAP APPEND must return a UID')
        const stored = await client.fetchOne(
          added.uid,
          { uid: true, internalDate: true },
          { uid: true }
        )
        assert.equal(
          new Date(stored.internalDate).getTime(),
          Math.floor(internalDate.getTime() / 1000) * 1000
        )
        return { uid: added.uid, internalDate: new Date(stored.internalDate).toISOString() }
      })
    },
    async deliver(subject, text, messageId) {
      const smtp = nodemailer.createTransport({
        ...config.smtp,
        tls: { ca },
        auth: { user: 'sender', pass: fixturePassword },
      })
      try {
        const result = await smtp.sendMail({
          from: 'sender@example.com',
          to: config.email,
          subject,
          text,
          messageId,
        })
        assert.deepEqual(result.rejected, [])
      } finally {
        smtp.close()
      }
    },
    async received(username = 'sender') {
      return imap(username, async client => {
        const uids = await client.search({ all: true }, { uid: true })
        return uids.length
          ? client.fetchAll(uids, { envelope: true, source: true }, { uid: true })
          : []
      })
    },
  }
}
