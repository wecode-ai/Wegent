// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * Pet Context Provider
 *
 * Manages pet state at the application level.
 * Provides pet data and methods to update pet settings.
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from 'react'
import { petApis } from '@/apis/pet'
import type {
  Pet,
  PetUpdate,
  PetAnimationState,
  ExperienceGainedEvent,
  StageEvolvedEvent,
} from '@/features/pet/types/pet'
import { useSocket } from '@/contexts/SocketContext'

interface PetContextType {
  /** Current pet data */
  pet: Pet | null
  /** Whether pet data is loading */
  isLoading: boolean
  /** Error if any */
  error: Error | null
  /** Current animation state */
  animationState: PetAnimationState
  /** Pending experience gain to show animation */
  pendingExpGain: ExperienceGainedEvent | null
  /** Pending evolution to show animation */
  pendingEvolution: StageEvolvedEvent | null
  /** Fetch pet data */
  fetchPet: () => Promise<void>
  /** Update pet settings */
  updatePet: (data: PetUpdate) => Promise<void>
  /** Reset pet */
  resetPet: () => Promise<void>
  /** Set animation state */
  setAnimationState: (state: PetAnimationState) => void
  /** Clear pending experience gain */
  clearPendingExpGain: () => void
  /** Clear pending evolution */
  clearPendingEvolution: () => void
  /** Simulate experience gain (for testing/demo) */
  simulateExpGain: (amount: number) => void
}

const PetContext = createContext<PetContextType | undefined>(undefined)

interface PetProviderProps {
  children: ReactNode
}

export function PetProvider({ children }: PetProviderProps) {
  const [pet, setPet] = useState<Pet | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [animationState, setAnimationState] = useState<PetAnimationState>('idle')
  const [pendingExpGain, setPendingExpGain] = useState<ExperienceGainedEvent | null>(null)
  const [pendingEvolution, setPendingEvolution] = useState<StageEvolvedEvent | null>(null)

  const { socket, isConnected } = useSocket()

  // Fetch pet data
  const fetchPet = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await petApis.getPet()
      setPet(data)
    } catch (err) {
      setError(err as Error)
      console.error('[PetContext] Failed to fetch pet:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Update pet settings
  const updatePet = useCallback(async (data: PetUpdate) => {
    setError(null)
    try {
      const updated = await petApis.updatePet(data)
      setPet(updated)
    } catch (err) {
      setError(err as Error)
      console.error('[PetContext] Failed to update pet:', err)
      throw err
    }
  }, [])

  // Reset pet
  const resetPet = useCallback(async () => {
    setError(null)
    try {
      const reset = await petApis.resetPet()
      setPet(reset)
    } catch (err) {
      setError(err as Error)
      console.error('[PetContext] Failed to reset pet:', err)
      throw err
    }
  }, [])

  // Clear pending experience gain
  const clearPendingExpGain = useCallback(() => {
    setPendingExpGain(null)
    setAnimationState('idle')
  }, [])

  // Clear pending evolution
  const clearPendingEvolution = useCallback(() => {
    setPendingEvolution(null)
    setAnimationState('idle')
  }, [])

  // Simulate experience gain (for demo/testing)
  const simulateExpGain = useCallback(
    (amount: number) => {
      if (!pet) return

      const event: ExperienceGainedEvent = {
        amount,
        total: pet.experience + amount,
        source: 'chat',
        multiplier: pet.streak_multiplier,
      }

      setPendingExpGain(event)
      setAnimationState('gaining_exp')

      // Update local pet state
      setPet(prev => {
        if (!prev) return prev
        return {
          ...prev,
          experience: prev.experience + amount,
          total_chats: prev.total_chats + 1,
        }
      })
    },
    [pet]
  )

  // Register WebSocket event handlers
  useEffect(() => {
    if (!socket || !isConnected) return

    // Handle experience gained event
    const handleExpGained = (data: ExperienceGainedEvent) => {
      console.log('[PetContext] Experience gained:', data)
      setPendingExpGain(data)
      setAnimationState('gaining_exp')

      // Update pet state
      setPet(prev => {
        if (!prev) return prev
        return {
          ...prev,
          experience: data.total,
          total_chats: data.source === 'chat' ? prev.total_chats + 1 : prev.total_chats,
        }
      })
    }

    // Handle stage evolved event
    const handleStageEvolved = (data: StageEvolvedEvent) => {
      console.log('[PetContext] Stage evolved:', data)
      setPendingEvolution(data)
      setAnimationState('evolving')

      // Update pet state
      setPet(prev => {
        if (!prev) return prev
        return {
          ...prev,
          stage: data.new_stage,
        }
      })
    }

    // Handle traits updated event
    const handleTraitsUpdated = (data: { traits: Pet['appearance_traits'] }) => {
      console.log('[PetContext] Traits updated:', data)
      setPet(prev => {
        if (!prev) return prev
        return {
          ...prev,
          appearance_traits: data.traits,
        }
      })
    }

    socket.on('pet:experience_gained', handleExpGained)
    socket.on('pet:stage_evolved', handleStageEvolved)
    socket.on('pet:traits_updated', handleTraitsUpdated)

    return () => {
      socket.off('pet:experience_gained', handleExpGained)
      socket.off('pet:stage_evolved', handleStageEvolved)
      socket.off('pet:traits_updated', handleTraitsUpdated)
    }
  }, [socket, isConnected])

  // Auto-fetch pet data on mount
  useEffect(() => {
    fetchPet()
  }, [fetchPet])

  return (
    <PetContext.Provider
      value={{
        pet,
        isLoading,
        error,
        animationState,
        pendingExpGain,
        pendingEvolution,
        fetchPet,
        updatePet,
        resetPet,
        setAnimationState,
        clearPendingExpGain,
        clearPendingEvolution,
        simulateExpGain,
      }}
    >
      {children}
    </PetContext.Provider>
  )
}

/**
 * Hook to use pet context
 */
export function usePet(): PetContextType {
  const context = useContext(PetContext)
  if (!context) {
    throw new Error('usePet must be used within a PetProvider')
  }
  return context
}
