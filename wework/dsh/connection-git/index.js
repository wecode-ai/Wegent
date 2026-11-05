import { createProvider } from './provider.js'

export const name = 'wework-connection-git'
export const inject = ['weworkConnections']

export async function apply(ctx) {
  await ctx.weworkConnections.register(ctx, new URL('./package.json', import.meta.url), {
    github: createProvider('github'),
    gitlab: createProvider('gitlab'),
  })
}
