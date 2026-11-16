import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function runJsonResultProcess({
  executable,
  scriptPath,
  input,
  launchArguments = [],
  environment,
  timeout,
  resultFile,
}) {
  await rm(resultFile, { force: true })
  const { stdout, stderr } = await execFileAsync(
    executable,
    [scriptPath, JSON.stringify({ ...input, resultFile }), ...launchArguments],
    {
      ...(environment ? { env: environment } : {}),
      timeout,
      maxBuffer: 1024 * 1024,
    }
  )
  if (stdout.trim()) console.log(stdout.trim())
  if (stderr.trim()) console.error(stderr.trim())
  return JSON.parse(await readFile(resultFile, 'utf8'))
}
