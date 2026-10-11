import { createContext } from 'react'

export interface ComposerPrediction {
  text: string
  onAccept: () => void
}

export const ComposerPredictionContext = createContext<ComposerPrediction | null>(null)
