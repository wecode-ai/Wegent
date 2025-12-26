// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { Download, X, ZoomIn, ZoomOut, RotateCw, ExternalLink, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/**
 * Full screen image preview modal component
 */
function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);

  const handleZoomIn = useCallback(() => {
    setScale(prev => Math.min(prev + 0.25, 3));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale(prev => Math.max(prev - 0.25, 0.5));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation(prev => (prev + 90) % 360);
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleOpenOriginal = useCallback(() => {
    window.open(src, '_blank', 'noopener,noreferrer');
  }, [src]);

  const handleDownload = useCallback(async () => {
    try {
      const response = await fetch(src);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Extract filename from URL or use default
      const urlPath = new URL(src).pathname;
      const filename = urlPath.split('/').pop() || 'image';
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      // Fallback: open in new tab
      window.open(src, '_blank', 'noopener,noreferrer');
    }
  }, [src]);

  // Handle keyboard events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case '+':
        case '=':
          handleZoomIn();
          break;
        case '-':
          handleZoomOut();
          break;
        case 'r':
        case 'R':
          handleRotate();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    // Prevent body scroll when lightbox is open
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose, handleZoomIn, handleZoomOut, handleRotate]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      {/* Toolbar */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleZoomOut}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Zoom Out (-)"
        >
          <ZoomOut className="h-5 w-5" />
        </Button>
        <span className="text-white text-sm bg-black/50 px-2 py-1 rounded">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleZoomIn}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Zoom In (+)"
        >
          <ZoomIn className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRotate}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Rotate (R)"
        >
          <RotateCw className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDownload}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Download"
        >
          <Download className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleOpenOriginal}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Open Original"
        >
          <ExternalLink className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-10 w-10 bg-black/50 hover:bg-black/70 text-white"
          title="Close (Esc)"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* Image container */}
      <div className="max-w-[90vw] max-h-[90vh] overflow-auto">
        <img
          src={src}
          alt={alt}
          className="transition-transform duration-200 ease-out"
          style={{
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            maxWidth: scale === 1 ? '90vw' : 'none',
            maxHeight: scale === 1 ? '90vh' : 'none',
          }}
          draggable={false}
        />
      </div>

      {/* Filename at bottom */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white text-sm bg-black/50 px-4 py-2 rounded-lg max-w-[80vw] truncate">
        {alt || src}
      </div>
    </div>
  );
}

interface ImagePreviewProps {
  /** Image URL */
  src: string;
  /** Alt text for the image */
  alt?: string;
  /** Maximum width of the thumbnail */
  maxWidth?: number;
  /** Maximum height of the thumbnail */
  maxHeight?: number;
  /** Additional class names */
  className?: string;
}

/**
 * Image preview component with inline thumbnail and lightbox functionality
 * Used for rendering image URLs detected in chat messages
 */
export default function ImagePreview({
  src,
  alt = '',
  maxWidth = 300,
  maxHeight = 200,
  className = '',
}: ImagePreviewProps) {
  const [showLightbox, setShowLightbox] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const handleImageClick = useCallback(() => {
    setShowLightbox(true);
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setShowLightbox(false);
  }, []);

  const handleImageLoad = useCallback(() => {
    setIsLoading(false);
    setHasError(false);
  }, []);

  const handleImageError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
  }, []);

  // Reset states when src changes
  useEffect(() => {
    setIsLoading(true);
    setHasError(false);
  }, [src]);

  // If image failed to load, render as a fallback link
  if (hasError) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-2 text-sm text-link hover:underline ${className}`}
      >
        <AlertCircle className="h-4 w-4 text-text-muted" />
        <span className="truncate max-w-[200px]">{alt || src}</span>
        <ExternalLink className="h-3 w-3" />
      </a>
    );
  }

  return (
    <>
      <div
        className={`relative inline-block cursor-pointer rounded-lg overflow-hidden border border-border hover:border-primary transition-colors ${className}`}
        onClick={handleImageClick}
        style={{ maxWidth, maxHeight }}
      >
        {/* Loading skeleton */}
        {isLoading && (
          <div
            className="absolute inset-0 bg-muted animate-pulse flex items-center justify-center"
            style={{ minWidth: 100, minHeight: 80 }}
          >
            <div className="text-text-muted text-xs">Loading...</div>
          </div>
        )}

        {/* Image */}
        <img
          src={src}
          alt={alt}
          className={`object-contain bg-muted transition-opacity duration-200 ${isLoading ? 'opacity-0' : 'opacity-100'}`}
          style={{ maxWidth, maxHeight }}
          onLoad={handleImageLoad}
          onError={handleImageError}
          draggable={false}
        />

        {/* Hover overlay */}
        {!isLoading && (
          <div className="absolute inset-0 bg-black/0 hover:bg-black/10 transition-colors flex items-center justify-center opacity-0 hover:opacity-100">
            <ZoomIn className="h-6 w-6 text-white drop-shadow-md" />
          </div>
        )}
      </div>

      {/* Lightbox */}
      {showLightbox && <ImageLightbox src={src} alt={alt} onClose={handleCloseLightbox} />}
    </>
  );
}
