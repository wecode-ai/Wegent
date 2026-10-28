/** Preset probes are fixed product endpoints, never renderer-supplied destinations. */
export const MODEL_PRESET_PROBES = {
  minimax: {
    baseUrl: 'https://api.minimaxi.com',
    requestPath: '/v1/text/chatcompletion_v2',
    apiFormat: 'openai-chat-completions',
  },
  'minimax-global': {
    baseUrl: 'https://api.minimax.io',
    requestPath: '/v1/text/chatcompletion_v2',
    apiFormat: 'openai-chat-completions',
  },
} as const
