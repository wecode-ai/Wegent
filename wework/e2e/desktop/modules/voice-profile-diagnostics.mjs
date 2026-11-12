import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Observe profile writer ownership without removing locks or exposing settings. */
export function readVoiceProfileDiagnostics(userDataDirectory) {
  const root = join(userDataDirectory, 'dsh-core', 'profiles', 'wework-core')
  const result = {}
  try {
    const record = readFileSync(join(root, 'package.json.lock'), 'utf8')
    result.writer = record === '' ? 'empty' : 'invalid'
    if (/^[1-9]\d*\n$/.test(record) && Number(record.trim()) <= 2147483647) {
      result.writer = 'recorded'
      result.writerPid = Number(record.trim())
      try {
        process.kill(result.writerPid, 0)
        result.writerAlive = true
      } catch (error) {
        result.writerAlive = error.code === 'ESRCH' ? false : 'unknown'
      }
    }
  } catch (error) {
    result.writer = error.code === 'ENOENT' ? 'absent' : 'unreadable'
  }
  try {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    result.fixtureProviderPersisted =
      /^\s*defaultProvider:\s*['"]?voice-toolbar-model['"]?\s*$/m.test(patch)
  } catch (error) {
    result.patch = error.code === 'ENOENT' ? 'absent' : 'unreadable'
  }
  return result
}
