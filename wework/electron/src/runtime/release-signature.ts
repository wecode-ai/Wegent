import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export async function verifyReleaseSignature(
  currentExecutable: string,
  nextExecutable: string
): Promise<void> {
  if (process.platform === 'darwin') {
    const appRoot = (executable: string) => resolve(executable, '..', '..', '..')
    const inspect = async (executable: string) => {
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appRoot(executable)])
      const { stderr } = await execute('/usr/bin/codesign', [
        '--display',
        '--verbose=4',
        appRoot(executable),
      ])
      return {
        team: /^TeamIdentifier=(.*)$/m.exec(stderr)?.[1],
        identifier: /^Identifier=(.*)$/m.exec(stderr)?.[1],
      }
    }
    const [current, next] = await Promise.all([inspect(currentExecutable), inspect(nextExecutable)])
    if (!current.identifier || current.identifier !== next.identifier || current.team !== next.team)
      throw new Error('Target release signing identity does not match Wework')
  } else if (process.platform === 'win32') {
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
    const script = `$a=Get-AuthenticodeSignature -LiteralPath ${literal(currentExecutable)}; $b=Get-AuthenticodeSignature -LiteralPath ${literal(nextExecutable)}; @{a=$a.Status.ToString();b=$b.Status.ToString();publisherA=$a.SignerCertificate.Subject;publisherB=$b.SignerCertificate.Subject}|ConvertTo-Json -Compress`
    const { stdout } = await execute(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true }
    )
    const signature = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as {
      a: string
      b: string
      publisherA: string
      publisherB: string
    }
    const signed =
      signature.a === 'Valid' &&
      signature.b === 'Valid' &&
      signature.publisherA === signature.publisherB
    // Unsignable local regression builds may update to another unsigned build;
    // an installed signed application never accepts this mode.
    if (!signed && !(signature.a === 'NotSigned' && signature.b === 'NotSigned'))
      throw new Error('Target release publisher verification failed')
  }
}
