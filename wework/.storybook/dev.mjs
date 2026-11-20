// Storybook's Watchpack reads this before main.ts loads; linked worktree events can be lost.
process.env.WATCHPACK_POLLING ??= '1000'
await import('storybook/internal/bin/dispatcher')
