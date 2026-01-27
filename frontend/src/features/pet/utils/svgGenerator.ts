// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * SVG Generator for pet avatars.
 *
 * Generates consistent SVG avatars based on:
 * - svg_seed: Ensures same seed produces same base appearance
 * - stage: Affects size and complexity (1=baby, 2=growing, 3=mature)
 * - appearance_traits: Domain-specific colors and accessories
 */

import type { PetStage, AppearanceTraits } from '@/features/pet/types/pet'

// Color palettes for different domains
const COLOR_PALETTES: Record<string, { primary: string; secondary: string; accent: string }> = {
  navy: { primary: '#1e3a5f', secondary: '#2d5a8a', accent: '#f0f4f8' },
  teal: { primary: '#14b8a6', secondary: '#0d9488', accent: '#f0fdfa' },
  purple: { primary: '#8b5cf6', secondary: '#7c3aed', accent: '#faf5ff' },
  gold: { primary: '#f59e0b', secondary: '#d97706', accent: '#fffbeb' },
  blue: { primary: '#3b82f6', secondary: '#2563eb', accent: '#eff6ff' },
  green: { primary: '#22c55e', secondary: '#16a34a', accent: '#f0fdf4' },
}

// Size configurations per stage
const STAGE_SIZES: Record<PetStage, { size: number; bodyScale: number; eyeScale: number }> = {
  1: { size: 60, bodyScale: 0.8, eyeScale: 1.2 }, // Baby: small, round, big eyes
  2: { size: 70, bodyScale: 0.9, eyeScale: 1.0 }, // Growing: medium
  3: { size: 80, bodyScale: 1.0, eyeScale: 0.9 }, // Mature: large, detailed
}

/**
 * Simple seeded random number generator
 */
function seededRandom(seed: string): () => number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }

  return () => {
    hash = Math.sin(hash) * 10000
    return hash - Math.floor(hash)
  }
}

/**
 * Generate a unique pet SVG based on seed, stage, and traits
 */
export function generatePetSvg(
  seed: string,
  stage: PetStage,
  traits: AppearanceTraits
): string {
  const random = seededRandom(seed)
  const { size, bodyScale, eyeScale } = STAGE_SIZES[stage]
  const palette = COLOR_PALETTES[traits.color_tone] || COLOR_PALETTES.teal

  // Generate random variations based on seed
  const bodyVariation = random() * 0.2 - 0.1 // -0.1 to 0.1
  const eyeOffset = random() * 4 - 2 // -2 to 2
  const earAngle = random() * 20 - 10 // -10 to 10 degrees
  const blushOpacity = 0.3 + random() * 0.3 // 0.3 to 0.6

  // Calculate dimensions
  const viewBox = size * 1.2
  const centerX = viewBox / 2
  const centerY = viewBox / 2
  const bodyWidth = (size * 0.6 * bodyScale) * (1 + bodyVariation)
  const bodyHeight = (size * 0.5 * bodyScale) * (1 - bodyVariation)
  const eyeSize = size * 0.08 * eyeScale
  const pupilSize = eyeSize * 0.5

  // Generate accessory SVG elements based on stage and traits
  const accessories = generateAccessories(traits.accessories, stage, centerX, centerY, size, palette, random)

  return `
    <svg viewBox="0 0 ${viewBox} ${viewBox}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bodyGradient-${seed.slice(0, 8)}" cx="30%" cy="30%">
          <stop offset="0%" stop-color="${palette.accent}"/>
          <stop offset="100%" stop-color="${palette.primary}"/>
        </radialGradient>
        <filter id="shadow-${seed.slice(0, 8)}" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-opacity="0.2"/>
        </filter>
      </defs>

      <!-- Ears -->
      <ellipse
        cx="${centerX - bodyWidth * 0.6}"
        cy="${centerY - bodyHeight * 0.6}"
        rx="${size * 0.12}"
        ry="${size * 0.18}"
        fill="${palette.primary}"
        transform="rotate(${-30 + earAngle}, ${centerX - bodyWidth * 0.6}, ${centerY - bodyHeight * 0.6})"
      />
      <ellipse
        cx="${centerX + bodyWidth * 0.6}"
        cy="${centerY - bodyHeight * 0.6}"
        rx="${size * 0.12}"
        ry="${size * 0.18}"
        fill="${palette.primary}"
        transform="rotate(${30 - earAngle}, ${centerX + bodyWidth * 0.6}, ${centerY - bodyHeight * 0.6})"
      />
      <!-- Inner ears -->
      <ellipse
        cx="${centerX - bodyWidth * 0.6}"
        cy="${centerY - bodyHeight * 0.5}"
        rx="${size * 0.06}"
        ry="${size * 0.1}"
        fill="${palette.secondary}"
        transform="rotate(${-30 + earAngle}, ${centerX - bodyWidth * 0.6}, ${centerY - bodyHeight * 0.5})"
      />
      <ellipse
        cx="${centerX + bodyWidth * 0.6}"
        cy="${centerY - bodyHeight * 0.5}"
        rx="${size * 0.06}"
        ry="${size * 0.1}"
        fill="${palette.secondary}"
        transform="rotate(${30 - earAngle}, ${centerX + bodyWidth * 0.6}, ${centerY - bodyHeight * 0.5})"
      />

      <!-- Body -->
      <ellipse
        cx="${centerX}"
        cy="${centerY}"
        rx="${bodyWidth}"
        ry="${bodyHeight}"
        fill="url(#bodyGradient-${seed.slice(0, 8)})"
        filter="url(#shadow-${seed.slice(0, 8)})"
      />

      <!-- Blush -->
      <ellipse
        cx="${centerX - bodyWidth * 0.5}"
        cy="${centerY + bodyHeight * 0.2}"
        rx="${size * 0.08}"
        ry="${size * 0.05}"
        fill="#f87171"
        opacity="${blushOpacity}"
      />
      <ellipse
        cx="${centerX + bodyWidth * 0.5}"
        cy="${centerY + bodyHeight * 0.2}"
        rx="${size * 0.08}"
        ry="${size * 0.05}"
        fill="#f87171"
        opacity="${blushOpacity}"
      />

      <!-- Eyes -->
      <ellipse
        cx="${centerX - bodyWidth * 0.3 + eyeOffset}"
        cy="${centerY - bodyHeight * 0.1}"
        rx="${eyeSize}"
        ry="${eyeSize * 1.1}"
        fill="white"
      />
      <ellipse
        cx="${centerX + bodyWidth * 0.3 + eyeOffset}"
        cy="${centerY - bodyHeight * 0.1}"
        rx="${eyeSize}"
        ry="${eyeSize * 1.1}"
        fill="white"
      />

      <!-- Pupils -->
      <ellipse
        cx="${centerX - bodyWidth * 0.3 + eyeOffset}"
        cy="${centerY - bodyHeight * 0.05}"
        rx="${pupilSize}"
        ry="${pupilSize * 1.2}"
        fill="#1a1a1a"
      />
      <ellipse
        cx="${centerX + bodyWidth * 0.3 + eyeOffset}"
        cy="${centerY - bodyHeight * 0.05}"
        rx="${pupilSize}"
        ry="${pupilSize * 1.2}"
        fill="#1a1a1a"
      />

      <!-- Eye highlights -->
      <circle
        cx="${centerX - bodyWidth * 0.3 + eyeOffset - pupilSize * 0.3}"
        cy="${centerY - bodyHeight * 0.15}"
        r="${pupilSize * 0.4}"
        fill="white"
      />
      <circle
        cx="${centerX + bodyWidth * 0.3 + eyeOffset - pupilSize * 0.3}"
        cy="${centerY - bodyHeight * 0.15}"
        r="${pupilSize * 0.4}"
        fill="white"
      />

      <!-- Nose -->
      <ellipse
        cx="${centerX}"
        cy="${centerY + bodyHeight * 0.2}"
        rx="${size * 0.04}"
        ry="${size * 0.03}"
        fill="${palette.secondary}"
      />

      <!-- Mouth -->
      <path
        d="M ${centerX - size * 0.06} ${centerY + bodyHeight * 0.3}
           Q ${centerX} ${centerY + bodyHeight * 0.4} ${centerX + size * 0.06} ${centerY + bodyHeight * 0.3}"
        fill="none"
        stroke="${palette.secondary}"
        stroke-width="2"
        stroke-linecap="round"
      />

      <!-- Accessories based on stage and traits -->
      ${accessories}
    </svg>
  `.trim()
}

/**
 * Generate accessory SVG elements based on traits
 */
function generateAccessories(
  accessories: string[],
  stage: PetStage,
  centerX: number,
  centerY: number,
  size: number,
  palette: { primary: string; secondary: string; accent: string },
  _random: () => number
): string {
  // Only show accessories in stage 2+ and limit based on stage
  if (stage < 2) return ''

  const maxAccessories = stage === 2 ? 1 : 2
  const activeAccessories = accessories.slice(0, maxAccessories)

  return activeAccessories
    .map(accessory => {
      switch (accessory) {
        case 'glasses':
          return `
            <!-- Glasses -->
            <circle cx="${centerX - size * 0.2}" cy="${centerY - size * 0.08}" r="${size * 0.1}" fill="none" stroke="#1a1a1a" stroke-width="2"/>
            <circle cx="${centerX + size * 0.2}" cy="${centerY - size * 0.08}" r="${size * 0.1}" fill="none" stroke="#1a1a1a" stroke-width="2"/>
            <line x1="${centerX - size * 0.1}" y1="${centerY - size * 0.08}" x2="${centerX + size * 0.1}" y2="${centerY - size * 0.08}" stroke="#1a1a1a" stroke-width="2"/>
          `
        case 'bowtie':
          return `
            <!-- Bowtie -->
            <path d="M ${centerX - size * 0.15} ${centerY + size * 0.35}
                     L ${centerX - size * 0.05} ${centerY + size * 0.4}
                     L ${centerX - size * 0.15} ${centerY + size * 0.45}
                     Z" fill="#dc2626"/>
            <path d="M ${centerX + size * 0.15} ${centerY + size * 0.35}
                     L ${centerX + size * 0.05} ${centerY + size * 0.4}
                     L ${centerX + size * 0.15} ${centerY + size * 0.45}
                     Z" fill="#dc2626"/>
            <circle cx="${centerX}" cy="${centerY + size * 0.4}" r="${size * 0.03}" fill="#dc2626"/>
          `
        case 'tie':
          return `
            <!-- Tie -->
            <polygon points="${centerX},${centerY + size * 0.35} ${centerX - size * 0.06},${centerY + size * 0.45} ${centerX},${centerY + size * 0.65} ${centerX + size * 0.06},${centerY + size * 0.45}" fill="#1e40af"/>
            <polygon points="${centerX - size * 0.04},${centerY + size * 0.33} ${centerX + size * 0.04},${centerY + size * 0.33} ${centerX + size * 0.03},${centerY + size * 0.38} ${centerX - size * 0.03},${centerY + size * 0.38}" fill="#1e3a8a"/>
          `
        case 'code_symbol':
          return `
            <!-- Code brackets -->
            <text x="${centerX - size * 0.4}" y="${centerY - size * 0.3}" font-family="monospace" font-size="${size * 0.15}" fill="${palette.secondary}">&lt;/&gt;</text>
          `
        case 'gear':
          return `
            <!-- Small gear -->
            <circle cx="${centerX + size * 0.4}" cy="${centerY - size * 0.3}" r="${size * 0.06}" fill="${palette.secondary}"/>
            <circle cx="${centerX + size * 0.4}" cy="${centerY - size * 0.3}" r="${size * 0.03}" fill="${palette.accent}"/>
          `
        case 'paintbrush':
          return `
            <!-- Paintbrush -->
            <rect x="${centerX + size * 0.35}" y="${centerY - size * 0.4}" width="${size * 0.04}" height="${size * 0.2}" fill="#8b4513" transform="rotate(-30, ${centerX + size * 0.35}, ${centerY - size * 0.4})"/>
            <ellipse cx="${centerX + size * 0.32}" cy="${centerY - size * 0.48}" rx="${size * 0.04}" ry="${size * 0.06}" fill="${palette.primary}" transform="rotate(-30, ${centerX + size * 0.32}, ${centerY - size * 0.48})"/>
          `
        case 'book':
          return `
            <!-- Book -->
            <rect x="${centerX - size * 0.5}" y="${centerY + size * 0.2}" width="${size * 0.12}" height="${size * 0.15}" fill="#3b82f6" rx="1"/>
            <line x1="${centerX - size * 0.44}" y1="${centerY + size * 0.22}" x2="${centerX - size * 0.44}" y2="${centerY + size * 0.33}" stroke="white" stroke-width="1"/>
          `
        case 'graduation_cap':
          return `
            <!-- Graduation cap -->
            <polygon points="${centerX - size * 0.25},${centerY - size * 0.45} ${centerX},${centerY - size * 0.55} ${centerX + size * 0.25},${centerY - size * 0.45} ${centerX},${centerY - size * 0.38}" fill="#1a1a1a"/>
            <rect x="${centerX - size * 0.15}" y="${centerY - size * 0.42}" width="${size * 0.3}" height="${size * 0.05}" fill="#1a1a1a"/>
            <line x1="${centerX + size * 0.15}" y1="${centerY - size * 0.4}" x2="${centerX + size * 0.2}" y2="${centerY - size * 0.3}" stroke="#f59e0b" stroke-width="2"/>
            <circle cx="${centerX + size * 0.2}" cy="${centerY - size * 0.28}" r="${size * 0.02}" fill="#f59e0b"/>
          `
        case 'stethoscope':
          return `
            <!-- Stethoscope hint -->
            <path d="M ${centerX - size * 0.1} ${centerY + size * 0.35} Q ${centerX} ${centerY + size * 0.5} ${centerX + size * 0.1} ${centerY + size * 0.35}" fill="none" stroke="#6b7280" stroke-width="2"/>
            <circle cx="${centerX}" cy="${centerY + size * 0.52}" r="${size * 0.04}" fill="#6b7280"/>
          `
        case 'chart':
          return `
            <!-- Chart -->
            <rect x="${centerX + size * 0.3}" y="${centerY}" width="${size * 0.15}" height="${size * 0.12}" fill="white" stroke="#1a1a1a" stroke-width="1"/>
            <polyline points="${centerX + size * 0.32},${centerY + size * 0.1} ${centerX + size * 0.36},${centerY + size * 0.06} ${centerX + size * 0.4},${centerY + size * 0.08} ${centerX + size * 0.43},${centerY + size * 0.03}" fill="none" stroke="#22c55e" stroke-width="1"/>
          `
        default:
          return ''
      }
    })
    .join('\n')
}

/**
 * Get pet size based on stage
 */
export function getPetSize(stage: PetStage, isMobile: boolean): number {
  const baseSize = STAGE_SIZES[stage].size
  return isMobile ? baseSize * 0.6 : baseSize
}
