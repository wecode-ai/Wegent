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
  gray: { primary: '#9ca3af', secondary: '#6b7280', accent: '#f9fafb' },
  navy: { primary: '#1e3a5f', secondary: '#2d5a8a', accent: '#f0f4f8' },
  teal: { primary: '#14b8a6', secondary: '#0d9488', accent: '#f0fdfa' },
  purple: { primary: '#8b5cf6', secondary: '#7c3aed', accent: '#faf5ff' },
  gold: { primary: '#f59e0b', secondary: '#d97706', accent: '#fffbeb' },
  blue: { primary: '#3b82f6', secondary: '#2563eb', accent: '#eff6ff' },
  green: { primary: '#22c55e', secondary: '#16a34a', accent: '#f0fdf4' },
}
// Experience thresholds for progressive feature appearance
// Designed for 3-5 days between each unlock (assuming ~5-10 messages/day = 5-10 exp/day)
const EXPERIENCE_THRESHOLDS = {
  BASIC_SHAPE: 0, // Always visible - basic ball shape
  EYES: 20, // Eyes appear after ~3 days
  NOSE: 45, // Nose appears after ~3-5 more days
  MOUTH: 70, // Mouth appears after ~3-5 more days
  EARS: 95, // Ears appear after ~3-5 more days
  BLUSH: 120, // Blush appears after ~3-5 more days
  DETAILS: 145, // Eye highlights and other details after ~3-5 more days
} as const
// Size configurations per stage - size stays constant, growth shown through visual effects
const STAGE_SIZES: Record<PetStage, { size: number; bodyScale: number; eyeScale: number }> = {
  1: { size: 60, bodyScale: 1.0, eyeScale: 1.2 }, // Baby: big eyes, simple
  2: { size: 60, bodyScale: 1.0, eyeScale: 1.0 }, // Growing: balanced
  3: { size: 60, bodyScale: 1.0, eyeScale: 0.9 }, // Mature: detailed eyes
}

// Stage visual effects - growth shown through glow, saturation, and decorations
const STAGE_EFFECTS: Record<
  PetStage,
  {
    glowIntensity: number // Glow effect intensity (0-1)
    glowRadius: number // Glow blur radius
    saturationBoost: number // Color saturation multiplier
    hasAura: boolean // Show aura ring
    starCount: number // Number of floating stars
  }
> = {
  1: { glowIntensity: 0, glowRadius: 0, saturationBoost: 0.8, hasAura: false, starCount: 0 },
  2: { glowIntensity: 0.3, glowRadius: 6, saturationBoost: 1.0, hasAura: false, starCount: 2 },
  3: { glowIntensity: 0.5, glowRadius: 10, saturationBoost: 1.2, hasAura: true, starCount: 4 },
}

/**
 * Adjust color saturation
 */
function adjustSaturation(hexColor: string, factor: number): string {
  // Convert hex to RGB
  const r = parseInt(hexColor.slice(1, 3), 16)
  const g = parseInt(hexColor.slice(3, 5), 16)
  const b = parseInt(hexColor.slice(5, 7), 16)

  // Convert to HSL
  const max = Math.max(r, g, b) / 255
  const min = Math.min(r, g, b) / 255
  const l = (max + min) / 2

  let h = 0
  let s = 0

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)

    switch (Math.max(r, g, b)) {
      case r:
        h = ((g / 255 - b / 255) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b / 255 - r / 255) / d + 2) / 6
        break
      case b:
        h = ((r / 255 - g / 255) / d + 4) / 6
        break
    }
  }

  // Adjust saturation
  s = Math.min(1, Math.max(0, s * factor))

  // Convert back to RGB
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q

  const newR = Math.round(hue2rgb(p, q, h + 1 / 3) * 255)
  const newG = Math.round(hue2rgb(p, q, h) * 255)
  const newB = Math.round(hue2rgb(p, q, h - 1 / 3) * 255)

  return `#${newR.toString(16).padStart(2, '0')}${newG.toString(16).padStart(2, '0')}${newB.toString(16).padStart(2, '0')}`
}

/**
 * Generate stage-based visual effects (glow, aura, sparkles, stars)
 */
function generateStageEffects(
  stage: PetStage,
  centerX: number,
  centerY: number,
  bodyRadius: number,
  palette: { primary: string; secondary: string; accent: string },
  _seed: string,
  random: () => number
): string {
  const effects = STAGE_EFFECTS[stage]
  let svg = ''

  // Generate floating stars - use primary color for visibility on light backgrounds
  if (effects.starCount > 0) {
    const starPositions = []
    for (let i = 0; i < effects.starCount; i++) {
      const angle = (i / effects.starCount) * Math.PI * 2 + random() * 0.5
      const distance = bodyRadius * (1.1 + random() * 0.3)
      const x = centerX + Math.cos(angle) * distance
      const y = centerY + Math.sin(angle) * distance
      const starSize = 3 + random() * 2
      starPositions.push({ x, y, size: starSize })
    }

    svg += starPositions
      .map(
        (star, i) => `
      <!-- Star ${i + 1} -->
      <g class="pet-star">
        <polygon
          points="${star.x},${star.y - star.size} ${star.x + star.size * 0.3},${star.y - star.size * 0.3} ${star.x + star.size},${star.y} ${star.x + star.size * 0.3},${star.y + star.size * 0.3} ${star.x},${star.y + star.size} ${star.x - star.size * 0.3},${star.y + star.size * 0.3} ${star.x - star.size},${star.y} ${star.x - star.size * 0.3},${star.y - star.size * 0.3}"
          fill="${palette.primary}"
          opacity="0.6"
        >
          <animate attributeName="opacity" values="0.4;0.8;0.4" dur="${1.5 + i * 0.3}s" repeatCount="indefinite"/>
        </polygon>
      </g>
    `
      )
      .join('')
  }

  // Generate aura ring for stage 3 - use primary/secondary colors for visibility
  if (effects.hasAura) {
    svg += `
      <!-- Aura ring -->
      <circle
        cx="${centerX}"
        cy="${centerY}"
        r="${bodyRadius * 1.15}"
        fill="none"
        stroke="${palette.primary}"
        stroke-width="1.5"
        opacity="0.3"
      >
        <animate attributeName="r" values="${bodyRadius * 1.1};${bodyRadius * 1.2};${bodyRadius * 1.1}" dur="2s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.2;0.4;0.2" dur="2s" repeatCount="indefinite"/>
      </circle>
      <circle
        cx="${centerX}"
        cy="${centerY}"
        r="${bodyRadius * 1.25}"
        fill="none"
        stroke="${palette.secondary}"
        stroke-width="1"
        opacity="0.15"
      >
        <animate attributeName="r" values="${bodyRadius * 1.2};${bodyRadius * 1.35};${bodyRadius * 1.2}" dur="3s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.1;0.25;0.1" dur="3s" repeatCount="indefinite"/>
      </circle>
    `
  }

  return svg
}

/**
 * Calculate feature visibility based on experience
 */
function getFeatureVisibility(experience: number) {
  return {
    hasEyes: experience >= EXPERIENCE_THRESHOLDS.EYES,
    hasNose: experience >= EXPERIENCE_THRESHOLDS.NOSE,
    hasMouth: experience >= EXPERIENCE_THRESHOLDS.MOUTH,
    hasEars: experience >= EXPERIENCE_THRESHOLDS.EARS,
    hasBlush: experience >= EXPERIENCE_THRESHOLDS.BLUSH,
    hasDetails: experience >= EXPERIENCE_THRESHOLDS.DETAILS,
  }
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
 * Generate a unique pet SVG based on seed, stage, traits, and experience
 */
export function generatePetSvg(
  seed: string,
  stage: PetStage,
  traits: AppearanceTraits,
  experience: number = 0
): string {
  const random = seededRandom(seed)
  const { size, bodyScale, eyeScale } = STAGE_SIZES[stage]
  const basePalette = COLOR_PALETTES[traits.color_tone] || COLOR_PALETTES.gray
  const effects = STAGE_EFFECTS[stage]

  // Apply saturation boost based on stage
  const palette = {
    primary: adjustSaturation(basePalette.primary, effects.saturationBoost),
    secondary: adjustSaturation(basePalette.secondary, effects.saturationBoost),
    accent: basePalette.accent, // Keep accent light
  }

  // Get feature visibility based on experience
  const features = getFeatureVisibility(experience)

  // Generate random variations based on seed
  // Only apply body variation after ears appear (more experience = more personality)
  const baseBodyVariation = random() * 0.2 - 0.1 // -0.1 to 0.1
  const bodyVariation = features.hasEars ? baseBodyVariation : 0 // Keep circular until ears appear
  const eyeOffset = random() * 4 - 2 // -2 to 2
  const earAngle = random() * 20 - 10 // -10 to 10 degrees
  const blushOpacity = 0.3 + random() * 0.3 // 0.3 to 0.6

  // Calculate dimensions - use larger viewBox to accommodate effects
  const viewBox = size * 1.5
  const centerX = viewBox / 2
  const centerY = viewBox / 2
  // Use same radius for width and height to make a perfect circle initially
  const baseBodyRadius = size * 0.55 * bodyScale
  const bodyWidth = baseBodyRadius * (1 + bodyVariation * 0.5)
  const bodyHeight = baseBodyRadius * (1 - bodyVariation * 0.5)
  const eyeSize = size * 0.08 * eyeScale
  const pupilSize = eyeSize * 0.5

  // Generate accessory SVG elements based on stage and traits
  const accessories = generateAccessories(
    traits.accessories,
    stage,
    centerX,
    centerY,
    size,
    palette,
    random
  )

  // Generate stage-based visual effects (glow, aura, sparkles, stars)
  const stageEffects = generateStageEffects(
    stage,
    centerX,
    centerY,
    baseBodyRadius,
    palette,
    seed,
    random
  )

  return `
    <svg viewBox="0 0 ${viewBox} ${viewBox}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bodyGradient-${seed.slice(0, 8)}" cx="30%" cy="30%">
          <stop offset="0%" stop-color="${palette.accent}"/>
          <stop offset="100%" stop-color="${palette.primary}"/>
        </radialGradient>
        ${
          effects.glowIntensity > 0
            ? `
        <filter id="glow-${seed.slice(0, 8)}" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="${effects.glowRadius}" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
        `
            : ''
        }
      </defs>
      
      <!-- Stage effects (aura, stars) rendered behind the pet -->
      ${stageEffects}

      <!-- Body (always visible) -->
      <ellipse
        cx="${centerX}"
        cy="${centerY}"
        rx="${bodyWidth}"
        ry="${bodyHeight}"
        fill="url(#bodyGradient-${seed.slice(0, 8)})"
        ${effects.glowIntensity > 0 ? `filter="url(#glow-${seed.slice(0, 8)})"` : ''}
      />
  
        ${
          features.hasEars
            ? `
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
        />`
            : ''
        }
  
        ${
          features.hasBlush
            ? `
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
        />`
            : ''
        }
  
        ${
          features.hasEyes
            ? `
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
        />`
            : ''
        }
  
        ${
          features.hasDetails
            ? `
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
        />`
            : ''
        }
  
        ${
          features.hasNose
            ? `
        <!-- Nose -->
        <ellipse
          cx="${centerX}"
          cy="${centerY + bodyHeight * 0.2}"
          rx="${size * 0.04}"
          ry="${size * 0.03}"
          fill="${palette.secondary}"
        />`
            : ''
        }
  
        ${
          features.hasMouth
            ? `
        <!-- Mouth -->
        <path
          d="M ${centerX - size * 0.06} ${centerY + bodyHeight * 0.3}
             Q ${centerX} ${centerY + bodyHeight * 0.4} ${centerX + size * 0.06} ${centerY + bodyHeight * 0.3}"
          fill="none"
          stroke="${palette.secondary}"
          stroke-width="2"
          stroke-linecap="round"
        />`
            : ''
        }

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
