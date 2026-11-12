import { createEmailAccounts } from './email-accounts.js'
import { createEmailProvider } from './email-provider.js'
import { createEmailSender } from './email-send.js'

export const name = 'wework-connection-runtime'
export const inject = ['weworkConnections', 'weworkSecureStorage', 'weworkPluginRuntime']

export async function apply(ctx) {
  const accounts = createEmailAccounts(ctx.weworkSecureStorage.scope('email-accounts'))
  const sendEmail = createEmailSender(accounts, ctx.weworkSecureStorage.scope('email-outbox'))
  const provider = createEmailProvider(accounts)
  await ctx.weworkConnections.register(ctx, new URL('./package.json', import.meta.url), {
    email: {
      ...provider,
      executeAction: (_context, input) => sendEmail(input),
    },
  })
  ctx.weworkPluginRuntime.register(ctx, {
    id: name,
    methods: {
      emailAccounts: () => accounts.list(),
      saveEmailAccount: input => accounts.save(input),
      removeEmailAccount: input => accounts.remove(input),
    },
  })
}
