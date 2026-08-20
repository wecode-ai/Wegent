import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}: ${stderr.trim()}`))
    })
  })
}

async function collectBinaryCandidates(directory) {
  const candidates = []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      candidates.push(...(await collectBinaryCandidates(entryPath)))
      continue
    }
    if (!entry.isFile()) continue

    const extension = path.extname(entry.name)
    const mode = (await stat(entryPath)).mode
    if ((mode & 0o111) !== 0 || ['.dylib', '.node', '.so'].includes(extension)) {
      candidates.push(entryPath)
    }
  }
  return candidates
}

export function macosSigningFingerprint(platform, identity) {
  if (platform !== 'darwin' || !identity) return 'unsigned'
  const identityHash = createHash('sha256').update(identity).digest('hex')
  return `developer-id:${identityHash}`
}

export async function signPreparedMacOsBinaries(
  directory,
  {
    platform = process.platform,
    identity = process.env.APPLE_SIGNING_IDENTITY,
    keychainPath = process.env.MACOS_KEYCHAIN_PATH,
    execute = runCommand,
    logger = console.log,
  } = {}
) {
  if (platform !== 'darwin' || !identity) return []

  const signed = []
  for (const candidate of await collectBinaryCandidates(directory)) {
    const description = await execute('file', ['-b', candidate], directory)
    if (!description.includes('Mach-O')) continue

    const args = ['--force', '--timestamp', '--options', 'runtime']
    if (keychainPath) args.push('--keychain', keychainPath)
    args.push('--sign', identity, candidate)
    logger(`Signing bundled DeepSeek Harness binary: ${path.relative(directory, candidate)}`)
    await execute('codesign', args, directory)
    signed.push(candidate)
  }
  return signed
}
