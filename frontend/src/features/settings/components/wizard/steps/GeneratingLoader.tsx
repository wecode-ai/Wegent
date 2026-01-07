// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface GeneratingLoaderProps {
  className?: string
}

// Robot part component with animation
function RobotPart({
  d,
  delay,
  isVisible,
  fill = 'currentColor',
}: {
  d: string
  delay: number
  isVisible: boolean
  fill?: string
}) {
  return (
    <path
      d={d}
      fill={fill}
      className={`transition-all duration-700 ${
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
      }`}
      style={{
        transitionDelay: `${delay}ms`,
      }}
    />
  )
}

export default function GeneratingLoader({ className }: GeneratingLoaderProps) {
  const { t } = useTranslation()
  const [tipIndex, setTipIndex] = useState(0)
  const [dots, setDots] = useState('')
  const [assemblyStep, setAssemblyStep] = useState(0)

  // Tips to cycle through - now synced with robot assembly
  const tips = [
    t('wizard:loading_tip_analyzing'),
    t('wizard:loading_tip_generating'),
    t('wizard:loading_tip_generating_test_data'),
    t('wizard:loading_tip_optimizing'),
    t('wizard:loading_tip_almost_done'),
  ]

  // Robot assembly animation - each step reveals more parts (slower pace)
  useEffect(() => {
    const assemblyInterval = setInterval(() => {
      setAssemblyStep(prev => {
        if (prev >= 5) return prev // Stop at fully assembled
        return prev + 1
      })
    }, 1500)

    return () => clearInterval(assemblyInterval)
  }, [])

  // Cycle through tips every 4 seconds, stop at the last one
  useEffect(() => {
    const tipInterval = setInterval(() => {
      setTipIndex(prev => {
        if (prev >= tips.length - 1) return prev
        return prev + 1
      })
    }, 4000)

    return () => clearInterval(tipInterval)
  }, [tips.length])

  // Animate dots
  useEffect(() => {
    const dotsInterval = setInterval(() => {
      setDots(prev => (prev.length >= 3 ? '' : prev + '.'))
    }, 500)

    return () => clearInterval(dotsInterval)
  }, [])

  return (
    <div className={`flex flex-col items-center justify-center py-12 ${className || ''}`}>
      {/* Robot Assembly Animation */}
      <div className="relative w-32 h-32 mb-2">
        {/* Glow effect behind robot */}
        <div
          className={`absolute inset-0 rounded-full bg-primary/10 blur-xl transition-opacity duration-1000 ${
            assemblyStep >= 5 ? 'opacity-100' : 'opacity-0'
          }`}
        />

        <svg
          viewBox="0 0 100 100"
          className="w-full h-full text-primary"
          style={{ overflow: 'visible' }}
        >
          {/* Step 1: Body (torso) */}
          <RobotPart
            d="M35 45 L35 70 L65 70 L65 45 L35 45 M40 50 L40 55 L45 55 L45 50 Z M55 50 L55 55 L60 55 L60 50 Z"
            delay={0}
            isVisible={assemblyStep >= 1}
          />

          {/* Step 2: Head */}
          <g
            className={`transition-all duration-700 ${
              assemblyStep >= 2 ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-4'
            }`}
            style={{ transitionDelay: '150ms' }}
          >
            {/* Head shape */}
            <rect x="38" y="20" width="24" height="22" rx="4" fill="currentColor" />
            {/* Antenna */}
            <line
              x1="50"
              y1="20"
              x2="50"
              y2="12"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <circle cx="50" cy="10" r="3" fill="currentColor" />
            {/* Eyes */}
            <circle cx="44" cy="28" r="3" fill="rgb(var(--color-bg-base))" />
            <circle cx="56" cy="28" r="3" fill="rgb(var(--color-bg-base))" />
            {/* Eye pupils - animated */}
            <circle
              cx="44"
              cy="28"
              r="1.5"
              fill="currentColor"
              className={assemblyStep >= 5 ? 'animate-pulse' : ''}
            />
            <circle
              cx="56"
              cy="28"
              r="1.5"
              fill="currentColor"
              className={assemblyStep >= 5 ? 'animate-pulse' : ''}
            />
            {/* Mouth */}
            <rect x="45" y="34" width="10" height="2" rx="1" fill="rgb(var(--color-bg-base))" />
          </g>

          {/* Step 3: Left Arm */}
          <g
            className={`transition-all duration-700 ${
              assemblyStep >= 3 ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-4'
            }`}
            style={{ transitionDelay: '200ms' }}
          >
            <rect x="20" y="47" width="12" height="6" rx="2" fill="currentColor" />
            <rect x="15" y="53" width="8" height="12" rx="2" fill="currentColor" />
            {/* Hand */}
            <circle cx="19" cy="68" r="4" fill="currentColor" />
          </g>

          {/* Step 4: Right Arm */}
          <g
            className={`transition-all duration-700 ${
              assemblyStep >= 4 ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'
            }`}
            style={{ transitionDelay: '250ms' }}
          >
            <rect x="68" y="47" width="12" height="6" rx="2" fill="currentColor" />
            <rect x="77" y="53" width="8" height="12" rx="2" fill="currentColor" />
            {/* Hand */}
            <circle cx="81" cy="68" r="4" fill="currentColor" />
          </g>

          {/* Step 5: Legs */}
          <g
            className={`transition-all duration-700 ${
              assemblyStep >= 5 ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            }`}
            style={{ transitionDelay: '300ms' }}
          >
            {/* Left leg */}
            <rect x="38" y="72" width="8" height="16" rx="2" fill="currentColor" />
            <rect x="36" y="88" width="12" height="4" rx="2" fill="currentColor" />
            {/* Right leg */}
            <rect x="54" y="72" width="8" height="16" rx="2" fill="currentColor" />
            <rect x="52" y="88" width="12" height="4" rx="2" fill="currentColor" />
          </g>

          {/* Sparkle effects when complete */}
          {assemblyStep >= 5 && (
            <>
              <circle cx="15" cy="25" r="2" fill="currentColor" className="animate-ping" />
              <circle
                cx="85"
                cy="30"
                r="1.5"
                fill="currentColor"
                className="animate-ping"
                style={{ animationDelay: '200ms' }}
              />
              <circle
                cx="20"
                cy="85"
                r="1.5"
                fill="currentColor"
                className="animate-ping"
                style={{ animationDelay: '400ms' }}
              />
              <circle
                cx="80"
                cy="80"
                r="2"
                fill="currentColor"
                className="animate-ping"
                style={{ animationDelay: '600ms' }}
              />
            </>
          )}
        </svg>

        {/* Assembly progress indicator */}
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex gap-1">
          {[1, 2, 3, 4, 5].map(step => (
            <div
              key={step}
              className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                assemblyStep >= step ? 'bg-primary scale-100' : 'bg-border scale-75'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Main text */}
      <p className="mt-6 text-base font-medium text-text-primary">
        {t('wizard:generating_prompt')}
      </p>

      {/* Dynamic tip with animated dots */}
      <p className="mt-2 text-sm text-text-muted h-5 transition-opacity duration-300">
        {tips[tipIndex]}
        {dots}
      </p>

      {/* Progress hint */}
      <p className="mt-4 text-xs text-text-muted/70">{t('wizard:loading_patience_hint')}</p>
    </div>
  )
}
