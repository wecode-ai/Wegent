// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Zap } from 'lucide-react'

interface FlyingSkill {
  id: string
  skillName: string
  startX: number
  startY: number
  endX: number
  endY: number
}

interface SkillFlyAnimationProps {
  /** Skill name to animate */
  skillName: string | null
  /** Start position (from autocomplete item) */
  startPosition: { x: number; y: number } | null
  /** End position (skill button location) */
  endPosition: { x: number; y: number } | null
  /** Callback when animation completes */
  onAnimationComplete?: () => void
}

const ANIMATION_DURATION = 450 // ms

/**
 * SkillFlyAnimation Component
 *
 * Renders a flying animation when a skill is selected from the autocomplete menu.
 * The skill icon flies in a parabolic arc from the selected item to the skill button.
 *
 * Uses requestAnimationFrame for smooth parabolic animation:
 * - X direction: linear movement
 * - Y direction: parabolic curve (quadratic bezier)
 */
export default function SkillFlyAnimation({
  skillName,
  startPosition,
  endPosition,
  onAnimationComplete,
}: SkillFlyAnimationProps) {
  const [flyingSkills, setFlyingSkills] = useState<FlyingSkill[]>([])
  const [mounted, setMounted] = useState(false)

  // Ensure we only render portal on client side
  useEffect(() => {
    setMounted(true)
  }, [])

  // Add new flying skill when props change
  useEffect(() => {
    if (skillName && startPosition && endPosition) {
      const id = `${skillName}-${Date.now()}`
      const newSkill: FlyingSkill = {
        id,
        skillName,
        startX: startPosition.x,
        startY: startPosition.y,
        endX: endPosition.x,
        endY: endPosition.y,
      }
      setFlyingSkills(prev => [...prev, newSkill])

      // Remove after animation completes
      const timer = setTimeout(() => {
        setFlyingSkills(prev => prev.filter(s => s.id !== id))
        onAnimationComplete?.()
      }, ANIMATION_DURATION)

      return () => clearTimeout(timer)
    }
  }, [skillName, startPosition, endPosition, onAnimationComplete])

  // Don't render if not mounted or no flying skills
  if (!mounted || flyingSkills.length === 0) {
    return null
  }

  // Render flying skills using portal to ensure they're above everything
  return createPortal(
    <>
      {flyingSkills.map(skill => (
        <FlyingSkillElement key={skill.id} skill={skill} />
      ))}
    </>,
    document.body
  )
}

interface FlyingSkillElementProps {
  skill: FlyingSkill
}

function FlyingSkillElement({ skill }: FlyingSkillElementProps) {
  const { startX, startY, endX, endY } = skill
  const elementRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<number | null>(null)
  const startTimeRef = useRef<number | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    // Calculate the movement distances
    const deltaX = endX - startX
    const deltaY = endY - startY

    // Calculate arc height (higher arc for longer distances, negative for upward arc)
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)
    const arcHeight = Math.min(100, Math.max(40, distance * 0.4))

    const animate = (timestamp: number) => {
      if (!startTimeRef.current) {
        startTimeRef.current = timestamp
      }

      const elapsed = timestamp - startTimeRef.current
      const progress = Math.min(elapsed / ANIMATION_DURATION, 1)

      // Ease out cubic for smoother deceleration
      const easeProgress = 1 - Math.pow(1 - progress, 3)

      // Linear X movement
      const currentX = deltaX * easeProgress

      // Parabolic Y movement: y = ax^2 + bx where a and b are calculated
      // to create an arc that goes up first then down
      // Using quadratic bezier-like curve: start -> peak -> end
      // peak is at progress = 0.4 (slightly before middle for natural feel)
      const peakProgress = 0.4
      let currentY: number

      if (progress <= peakProgress) {
        // Going up phase
        const upProgress = progress / peakProgress
        const upEase = 1 - Math.pow(1 - upProgress, 2) // ease out
        currentY = -arcHeight * upEase
      } else {
        // Going down phase
        const downProgress = (progress - peakProgress) / (1 - peakProgress)
        const downEase = downProgress * downProgress // ease in
        currentY = -arcHeight * (1 - downEase) + deltaY * downEase
      }

      // Scale down slightly at the end
      const scale = 1 - progress * 0.3

      // Apply transform with scale
      element.style.transform = `translate(${currentX}px, ${currentY}px) scale(${scale})`

      // Fade out near the end - fade to 0 completely
      if (progress > 0.6) {
        const fadeProgress = (progress - 0.6) / 0.4
        element.style.opacity = String(1 - fadeProgress)
      }

      // Hide completely when animation ends
      if (progress >= 1) {
        element.style.opacity = '0'
        element.style.visibility = 'hidden'
      } else {
        animationRef.current = requestAnimationFrame(animate)
      }
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [startX, startY, endX, endY])

  return (
    <div
      className="fixed pointer-events-none z-[9999]"
      style={{
        left: startX,
        top: startY,
      }}
    >
      <div
        ref={elementRef}
        className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-white shadow-lg"
        style={{
          boxShadow: '0 4px 12px rgba(20, 184, 166, 0.4)',
        }}
      >
        <Zap className="h-4 w-4" />
      </div>
    </div>
  )
}

/**
 * Hook to manage skill fly animation state
 */
export function useSkillFlyAnimation() {
  const [animationState, setAnimationState] = useState<{
    skillName: string | null
    startPosition: { x: number; y: number } | null
    endPosition: { x: number; y: number } | null
  }>({
    skillName: null,
    startPosition: null,
    endPosition: null,
  })

  const triggerAnimation = useCallback(
    (skillName: string, startPos: { x: number; y: number }, endPos: { x: number; y: number }) => {
      setAnimationState({
        skillName,
        startPosition: startPos,
        endPosition: endPos,
      })
    },
    []
  )

  const clearAnimation = useCallback(() => {
    setAnimationState({
      skillName: null,
      startPosition: null,
      endPosition: null,
    })
  }, [])

  return {
    animationState,
    triggerAnimation,
    clearAnimation,
  }
}
