import { createContext } from 'react'
import type { createReplyPredictionFeed } from './replyPredictionFeed'

export const ReplyPredictionFeedContext = createContext<ReturnType<
  typeof createReplyPredictionFeed
> | null>(null)
