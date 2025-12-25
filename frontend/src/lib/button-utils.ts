// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { type VariantProps } from 'class-variance-authority';
import { buttonVariants } from '@/components/ui/button';

/**
 * Button variant types derived from buttonVariants
 */
export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;
export type ButtonShape = NonNullable<VariantProps<typeof buttonVariants>['shape']>;

/**
 * Complete button props type for convenience
 */
export interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
}

/**
 * Predefined button style combinations for common use cases
 */
export const BUTTON_PRESETS = {
  // User menu button style (pill shape with muted background)
  userMenu: {
    variant: 'ghost' as ButtonVariant,
    size: 'sm' as ButtonSize,
    shape: 'pill' as ButtonShape,
  },
  // Primary action button
  primaryAction: {
    variant: 'primary' as ButtonVariant,
    size: 'default' as ButtonSize,
    shape: 'default' as ButtonShape,
  },
  // Icon only button
  iconOnly: {
    variant: 'ghost' as ButtonVariant,
    size: 'icon' as ButtonSize,
    shape: 'circle' as ButtonShape,
  },
  // Menu item button
  menuItem: {
    variant: 'ghost' as ButtonVariant,
    size: 'sm' as ButtonSize,
    shape: 'default' as ButtonShape,
  },
  // Destructive action button
  destructive: {
    variant: 'destructive' as ButtonVariant,
    size: 'default' as ButtonSize,
    shape: 'default' as ButtonShape,
  },
} as const;

/**
 * Helper function to combine button class names with custom classes
 */
export function getButtonClasses(
  props: ButtonStyleProps,
  customClasses?: string
): { variant: ButtonVariant; size: ButtonSize; shape: ButtonShape; className?: string } {
  return {
    variant: props.variant ?? 'default',
    size: props.size ?? 'default',
    shape: props.shape ?? 'default',
    ...(customClasses && { className: customClasses }),
  };
}
