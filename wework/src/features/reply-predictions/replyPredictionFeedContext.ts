import { createContext } from 'react'
import type { ReplyPredictionFeedSnapshot } from './replyPredictionFeed'

export const ReplyPredictionFeedContext = createContext<ReplyPredictionFeedSnapshot | null>(null)
