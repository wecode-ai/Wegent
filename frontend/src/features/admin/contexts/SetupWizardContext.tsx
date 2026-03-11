// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react'

interface SetupWizardContextValue {
  /** Whether the setup wizard dialog is currently open */
  isSetupWizardOpen: boolean
  /** Set the setup wizard open state */
  setSetupWizardOpen: (open: boolean) => void
}

const SetupWizardContext = createContext<SetupWizardContextValue | undefined>(undefined)

interface SetupWizardProviderProps {
  children: ReactNode
}

/**
 * Provider for setup wizard state.
 * This allows other components (like OnboardingTour) to know when the setup wizard is open
 * and avoid showing conflicting UI elements.
 */
export function SetupWizardProvider({ children }: SetupWizardProviderProps) {
  const [isSetupWizardOpen, setIsSetupWizardOpen] = useState(false)

  const setSetupWizardOpen = useCallback((open: boolean) => {
    setIsSetupWizardOpen(open)
  }, [])

  return (
    <SetupWizardContext.Provider value={{ isSetupWizardOpen, setSetupWizardOpen }}>
      {children}
    </SetupWizardContext.Provider>
  )
}

/**
 * Hook to access setup wizard state.
 * Returns undefined if used outside of SetupWizardProvider (for backward compatibility).
 */
export function useSetupWizard(): SetupWizardContextValue | undefined {
  return useContext(SetupWizardContext)
}
