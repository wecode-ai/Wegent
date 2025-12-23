// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { Button } from '@/components/ui/button';

interface AddContextButtonProps {
  hasSelection: boolean;
  onClick: () => void;
}

export default function AddContextButton({ hasSelection, onClick }: AddContextButtonProps) {
  if (hasSelection) {
    // Small icon button when knowledge bases are selected
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={onClick}
        className="h-8 w-8 text-text-secondary hover:text-text-primary"
        title="Add knowledge base"
      >
        <span className="text-base">@</span>
      </Button>
    );
  }

  // Large prominent button when no knowledge bases selected
  return (
    <Button
      variant="ghost"
      size="default"
      onClick={onClick}
      className="gap-2 bg-muted text-text-secondary hover:bg-hover"
    >
      <span className="text-lg">@</span>
      <span>Add Context</span>
    </Button>
  );
}
