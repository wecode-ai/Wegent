import { execFileSync } from 'node:child_process'

export function isolatedGitEnvironment(environment = process.env) {
  const env = { ...environment }
  const names = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const name of names.trim().split(/\r?\n/)) delete env[name]
  return env
}
