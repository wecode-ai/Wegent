import { createProvider } from './provider.js'
import { bindGitProvider } from './runtime-bridge.js'
import { ExecutorRuntimeClient } from '@wegent/dsh-executor-runtime/client'
import { readFile } from 'node:fs/promises'

export const name = 'wework-connection-git'
export const inject = ['weworkConnections']

export async function apply(ctx) {
  const manifestUrl = new URL('./package.json', import.meta.url)
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))
  const client = ExecutorRuntimeClient.fromEnvironment()
  await client.start()
  ctx.effect(() => () => client.stop(), 'wework Git connection runtime')
  const provider = platform =>
    bindGitProvider(
      `@wegent/dsh-connection-git/${platform}`,
      createProvider(platform),
      (method, input) => client.request(method, input),
      manifest.wework.connections.providers.find(provider => provider.id === platform)?.authTarget
    )
  await ctx.weworkConnections.register(ctx, manifestUrl, {
    github: provider('github'),
    gitlab: provider('gitlab'),
  })
}
