import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { reservePort } from '../port-reservation.mjs'

const run = promisify(execFile)
const VERSION = '1.6.15'
const SHA256 = 'e93dc3ed2db0175a4d6e168743bde3c8ac8a7435490bdab3f12da33d491ee24e'

// GreenMail is a real, isolated IMAP/SMTP service. No production mailboxes are used.
export async function startRealMailServer(directory, runtimeRoot) {
  await mkdir(directory, { recursive: true })
  const jar = join(directory, 'greenmail.jar')
  const response = await fetch(
    `https://repo.maven.apache.org/maven2/com/icegreen/greenmail-standalone/${VERSION}/greenmail-standalone-${VERSION}.jar`
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
  const imapPort = await reservePort()
  const smtpPort = await reservePort(undefined, { excludedPorts: [imapPort] })
  const apiPort = await reservePort(undefined, { excludedPorts: [imapPort, smtpPort] })
  const log = createWriteStream(join(directory, 'greenmail.log'))
  const child = spawn(
    'java',
    [
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
  const require = createRequire(join(runtimeRoot, 'package.json'))
  const { ImapFlow } = require('imapflow')
  const nodemailer = require('nodemailer')
  const ca = await readFile(certificate)
  const config = {
    email: 'owner@example.com',
    username: 'owner',
    password: fixturePassword,
    imap: { host: 'localhost', port: imapPort, secure: true },
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
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve))
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
