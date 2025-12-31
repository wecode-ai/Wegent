// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect, useMemo } from 'react';
import { FileText, ZoomIn, ZoomOut, RotateCw, Download, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';

interface PDFViewerProps {
  content: string; // Base64 encoded PDF content
}

export function PDFViewer({ content }: PDFViewerProps) {
  const { t } = useTranslation('knowledge');
  const [scale, setScale] = useState(100);
  const [error, setError] = useState(false);

  // Create a data URL from base64 content
  const pdfDataUrl = useMemo(() => {
    if (!content) return '';
    try {
      // Check if content is already a data URL
      if (content.startsWith('data:')) {
        return content;
      }
      // Create data URL from base64
      return `data:application/pdf;base64,${content}`;
    } catch (e) {
      console.error('Failed to create PDF data URL:', e);
      setError(true);
      return '';
    }
  }, [content]);

  // Handle zoom
  const handleZoomIn = () => {
    setScale(prev => Math.min(prev + 25, 200));
  };

  const handleZoomOut = () => {
    setScale(prev => Math.max(prev - 25, 50));
  };

  const handleResetZoom = () => {
    setScale(100);
  };

  // Handle download
  const handleDownload = () => {
    if (!content) return;

    try {
      // Convert base64 to blob
      const byteCharacters = atob(content);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/pdf' });

      // Create download link
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'document.pdf';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Failed to download PDF:', e);
    }
  };

  if (error || !content) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-12 text-text-muted">
        <AlertCircle className="w-16 h-16 mb-4 opacity-50" />
        <p className="text-sm">{t('document.viewer.load_failed')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-surface border border-border rounded-t-lg">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-red-500" />
          <span className="text-sm text-text-primary">PDF Document</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleZoomOut}
            disabled={scale <= 50}
            title="Zoom out"
          >
            <ZoomOut className="w-4 h-4" />
          </Button>
          <span className="text-xs text-text-muted px-2 min-w-[48px] text-center">{scale}%</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleZoomIn}
            disabled={scale >= 200}
            title="Zoom in"
          >
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleResetZoom} title="Reset zoom">
            <RotateCw className="w-4 h-4" />
          </Button>
          <div className="w-px h-4 bg-border mx-1" />
          <Button variant="ghost" size="sm" onClick={handleDownload} title="Download">
            <Download className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* PDF Viewer */}
      <div
        className="flex-1 bg-[#525659] border border-t-0 border-border rounded-b-lg overflow-auto"
        style={{ minHeight: '500px' }}
      >
        <div
          className="flex justify-center p-4"
          style={{
            transform: `scale(${scale / 100})`,
            transformOrigin: 'top center',
            transition: 'transform 0.2s ease',
          }}
        >
          {/* Using object tag for better PDF rendering */}
          <object
            data={pdfDataUrl}
            type="application/pdf"
            className="w-full max-w-[800px] bg-white shadow-lg rounded"
            style={{ height: '80vh', minHeight: '600px' }}
          >
            {/* Fallback for browsers that don't support object tag */}
            <div className="flex flex-col items-center justify-center h-full py-12 bg-white rounded">
              <FileText className="w-16 h-16 mb-4 text-red-500 opacity-50" />
              <p className="text-sm text-text-muted mb-4">
                Your browser does not support PDF preview
              </p>
              <Button variant="primary" size="sm" onClick={handleDownload}>
                <Download className="w-4 h-4 mr-2" />
                Download PDF
              </Button>
            </div>
          </object>
        </div>
      </div>

      {/* Info footer */}
      <div className="mt-3 px-2">
        <p className="text-xs text-text-muted">{t('document.viewer.pdf_readonly')}</p>
      </div>
    </div>
  );
}
