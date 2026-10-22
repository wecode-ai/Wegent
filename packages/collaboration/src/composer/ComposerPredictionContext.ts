import { createContext } from 'react'

export interface ComposerPrediction {
  text: string
  acceptLabel?: string
  onAccept: () => void
}

export const ComposerPredictionContext =
  createContext<ComposerPrediction | null>(null)

export const ComposerPredictionPendingContext = createContext<string | null>(
  null,
)
