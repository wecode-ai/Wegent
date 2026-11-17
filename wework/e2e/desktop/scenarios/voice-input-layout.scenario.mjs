import { createDesktopScenario as createVoiceScenario } from './voice-input.scenario.mjs'
import {
  verifyVoicePreparationLayout,
  verifyVoiceThemeTransitions,
} from '../modules/voice-preparation-layout.mjs'

export async function createDesktopScenario(options) {
  const voice = await createVoiceScenario(options)
  return {
    ...voice,
    async verify(control) {
      await verifyVoicePreparationLayout(control)
      await verifyVoiceThemeTransitions(control)
      await voice.verify(control)
    },
  }
}
