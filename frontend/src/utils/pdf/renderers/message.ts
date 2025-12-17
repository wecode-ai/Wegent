// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Message Renderer Module
 * Handles rendering of chat messages with bubble styles
 */

import type { ExportMessage, ExportAttachment, ParsedLine, TableAlignment } from '../types';
import { COLORS, LINE_HEIGHTS, HEADING_SIZES, BUBBLE_STYLES, PRIMARY_COLOR } from '../constants';
import { setFontForText } from '../font';
import { sanitizeEmojisForPdf } from '../emoji';
import { parseInlineMarkdown, parseLineType } from '../markdown';
import {
  formatTimestamp,
  isImageExtension,
  getFileTypeLabel,
  formatFileSize,
  getImageFormat,
  isCodeBlockDelimiter,
  extractCodeLanguage,
  sanitizeContent,
} from '../utils';
import {
  RenderContext,
  checkNewPage,
  renderStyledText,
  renderCodeBlock,
  renderTable,
} from './base';

/**
 * Draw a chat bubble icon (user or AI)
 */
export function drawBubbleIcon(
  ctx: RenderContext,
  x: number,
  y: number,
  isUser: boolean,
  _label: string
): void {
  const { pdf } = ctx;
  const style = isUser ? BUBBLE_STYLES.user : BUBBLE_STYLES.ai;
  const iconSize = BUBBLE_STYLES.common.iconSize;
  const radius = iconSize / 2;

  // Draw circular background
  pdf.setFillColor(style.iconBgColor.r, style.iconBgColor.g, style.iconBgColor.b);
  pdf.circle(x + radius, y + radius, radius, 'F');

  // Draw icon text (first letter)
  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(255, 255, 255);
  const iconChar = isUser ? 'U' : 'A';
  const textWidth = pdf.getTextWidth(iconChar);
  pdf.text(iconChar, x + radius - textWidth / 2, y + radius + 1.5);
}

/**
 * Render an image attachment within a bubble
 */
export function renderImageAttachmentInBubble(
  ctx: RenderContext,
  attachment: ExportAttachment,
  startX: number,
  maxWidth: number
): void {
  if (!attachment.imageData) return;

  const { pdf } = ctx;

  try {
    const imageFormat = getImageFormat(attachment.file_extension);
    const imgWidth = Math.min(maxWidth - 10, 60);
    const imgHeight = Math.min(50, 45);

    pdf.addImage(
      attachment.imageData,
      imageFormat,
      startX,
      ctx.yPosition,
      imgWidth,
      imgHeight,
      undefined,
      'FAST'
    );

    ctx.yPosition += imgHeight + 2;

    pdf.setFontSize(7);
    pdf.setTextColor(120, 120, 120);
    pdf.setFont('helvetica', 'normal');
    pdf.text(attachment.filename, startX, ctx.yPosition);
    ctx.yPosition += 4;
  } catch (error) {
    console.warn('Failed to render image attachment:', error);
    renderFileAttachmentInBubble(ctx, attachment, startX, maxWidth);
  }
}

/**
 * Render a file attachment info within a bubble
 */
export function renderFileAttachmentInBubble(
  ctx: RenderContext,
  attachment: ExportAttachment,
  startX: number,
  maxWidth: number
): void {
  const { pdf } = ctx;
  const attachmentHeight = 7;

  // Draw attachment box
  pdf.setFillColor(255, 255, 255);
  pdf.setDrawColor(200, 200, 200);
  pdf.roundedRect(startX, ctx.yPosition - 3, maxWidth - 10, attachmentHeight, 1, 1, 'FD');

  // File type label
  const fileTypeLabel = getFileTypeLabel(attachment.file_extension);
  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(100, 100, 100);
  pdf.text(fileTypeLabel, startX + 2, ctx.yPosition);

  // Filename
  pdf.setFontSize(8);
  setFontForText(pdf, attachment.filename, 'normal');
  pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);
  let displayFilename = attachment.filename;
  const maxFilenameWidth = maxWidth - 50;
  if (pdf.getTextWidth(displayFilename) > maxFilenameWidth) {
    while (
      pdf.getTextWidth(displayFilename + '...') > maxFilenameWidth &&
      displayFilename.length > 0
    ) {
      displayFilename = displayFilename.slice(0, -1);
    }
    displayFilename += '...';
  }
  pdf.text(displayFilename, startX + 10, ctx.yPosition);

  // File size
  pdf.setFontSize(7);
  pdf.setTextColor(140, 140, 140);
  pdf.setFont('helvetica', 'normal');
  const sizeText = formatFileSize(attachment.file_size);
  pdf.text(sizeText, startX + maxWidth - 15, ctx.yPosition, { align: 'right' });

  ctx.yPosition += attachmentHeight + 2;
}

/**
 * Render attachments within a chat bubble
 */
export function renderAttachmentsInBubble(
  ctx: RenderContext,
  attachments: ExportAttachment[],
  startX: number,
  maxWidth: number
): void {
  for (const attachment of attachments) {
    const isImage = isImageExtension(attachment.file_extension);

    if (isImage && attachment.imageData) {
      renderImageAttachmentInBubble(ctx, attachment, startX, maxWidth);
    } else {
      renderFileAttachmentInBubble(ctx, attachment, startX, maxWidth);
    }
  }
  ctx.yPosition += 2;
}

/**
 * Render a markdown line within a bubble
 */
export function renderMarkdownLineInBubble(
  ctx: RenderContext,
  parsedLine: ParsedLine,
  startX: number,
  maxWidth: number
): void {
  const { pdf } = ctx;
  const { type, content, level, listNumber } = parsedLine;

  switch (type) {
    case 'empty':
      ctx.yPosition += 2;
      break;

    case 'tableSeparator':
    case 'tableRow':
      break;

    case 'horizontalRule':
      checkNewPage(ctx, 5);
      pdf.setDrawColor(180, 180, 180);
      pdf.setLineWidth(0.3);
      pdf.line(startX, ctx.yPosition, startX + maxWidth, ctx.yPosition);
      ctx.yPosition += 3;
      break;

    case 'heading1':
    case 'heading2':
    case 'heading3':
    case 'heading4':
    case 'heading5':
    case 'heading6': {
      const fontSize = Math.max(HEADING_SIZES[type] - 2, 9);
      const lineHeight = LINE_HEIGHTS[type] - 1;
      checkNewPage(ctx, lineHeight + 3);
      ctx.yPosition += 1;

      pdf.setFontSize(fontSize);
      pdf.setTextColor(COLORS.heading.r, COLORS.heading.g, COLORS.heading.b);
      setFontForText(pdf, content, 'bold');

      const headingLines = pdf.splitTextToSize(content, maxWidth);
      for (const headingLine of headingLines) {
        checkNewPage(ctx, lineHeight);
        pdf.text(headingLine, startX, ctx.yPosition);
        ctx.yPosition += lineHeight;
      }
      ctx.yPosition += 1;
      break;
    }

    case 'unorderedList': {
      const indent = (level || 0) * 4;
      checkNewPage(ctx, LINE_HEIGHTS.list);
      pdf.setFillColor(COLORS.listMarker.r, COLORS.listMarker.g, COLORS.listMarker.b);
      const bulletX = startX + indent + 1.5;
      const bulletY = ctx.yPosition - 1.2;
      pdf.circle(bulletX, bulletY, 0.6, 'F');

      pdf.setFontSize(9);
      pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);
      setFontForText(pdf, content, 'normal');

      const listLines = pdf.splitTextToSize(content, maxWidth - indent - 5);
      for (let i = 0; i < listLines.length; i++) {
        checkNewPage(ctx, LINE_HEIGHTS.list);
        pdf.text(listLines[i], startX + indent + 4, ctx.yPosition);
        if (i < listLines.length - 1) ctx.yPosition += LINE_HEIGHTS.list - 0.5;
      }
      ctx.yPosition += LINE_HEIGHTS.list - 0.5;
      break;
    }

    case 'orderedList': {
      const indent = (level || 0) * 4;
      checkNewPage(ctx, LINE_HEIGHTS.list);
      pdf.setFontSize(9);
      pdf.setTextColor(COLORS.listMarker.r, COLORS.listMarker.g, COLORS.listMarker.b);
      pdf.setFont('helvetica', 'normal');
      const numberText = `${listNumber}.`;
      pdf.text(numberText, startX + indent, ctx.yPosition);

      pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);
      setFontForText(pdf, content, 'normal');

      const listLines = pdf.splitTextToSize(content, maxWidth - indent - 6);
      for (let i = 0; i < listLines.length; i++) {
        checkNewPage(ctx, LINE_HEIGHTS.list);
        pdf.text(listLines[i], startX + indent + 5, ctx.yPosition);
        if (i < listLines.length - 1) ctx.yPosition += LINE_HEIGHTS.list - 0.5;
      }
      ctx.yPosition += LINE_HEIGHTS.list - 0.5;
      break;
    }

    case 'blockquote': {
      checkNewPage(ctx, LINE_HEIGHTS.blockquote + 2);
      pdf.setDrawColor(180, 180, 180);
      pdf.setLineWidth(0.8);
      pdf.line(startX + 1, ctx.yPosition - 2.5, startX + 1, ctx.yPosition + 1);

      pdf.setFontSize(9);
      pdf.setTextColor(COLORS.blockquote.r, COLORS.blockquote.g, COLORS.blockquote.b);
      setFontForText(pdf, content, 'italic');

      const quoteLines = pdf.splitTextToSize(content, maxWidth - 6);
      for (const quoteLine of quoteLines) {
        checkNewPage(ctx, LINE_HEIGHTS.blockquote);
        pdf.text(quoteLine, startX + 5, ctx.yPosition);
        ctx.yPosition += LINE_HEIGHTS.blockquote - 0.5;
      }
      break;
    }

    case 'paragraph':
    default: {
      checkNewPage(ctx, LINE_HEIGHTS.paragraph);
      const segments = parseInlineMarkdown(content);
      renderStyledText(ctx, segments, startX, maxWidth, 9, true);
      ctx.yPosition += LINE_HEIGHTS.paragraph - 0.5;
      break;
    }
  }
}

/**
 * Render message content within a chat bubble
 */
export function renderMessageContentInBubble(
  ctx: RenderContext,
  content: string,
  startX: number,
  maxWidth: number
): void {
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeBlockContent = '';
  let codeLanguage = '';

  // Table state
  let inTable = false;
  let tableHeaders: string[] = [];
  let tableAlignments: TableAlignment[] = [];
  let tableRows: string[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isCodeBlockDelimiter(line)) {
      // Flush any pending table before code block
      if (inTable && tableHeaders.length > 0) {
        renderTable(ctx, tableHeaders, tableAlignments, tableRows, startX, maxWidth);
        inTable = false;
        tableHeaders = [];
        tableAlignments = [];
        tableRows = [];
      }

      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = extractCodeLanguage(line);
        codeBlockContent = '';
      } else {
        inCodeBlock = false;
        if (codeBlockContent.trim()) {
          renderCodeBlock(ctx, codeBlockContent, codeLanguage, startX, maxWidth);
        }
        codeBlockContent = '';
        codeLanguage = '';
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent += (codeBlockContent ? '\n' : '') + line;
    } else {
      const parsedLine = parseLineType(line, { inTable });

      if (parsedLine.type === 'tableRow' || parsedLine.type === 'tableSeparator') {
        if (parsedLine.type === 'tableSeparator') {
          if (!inTable && tableRows.length === 0 && i > 0) {
            const prevLine = lines[i - 1];
            const prevParsed = parseLineType(prevLine, { inTable: true });
            if (prevParsed.type === 'tableRow' && prevParsed.tableCells) {
              tableHeaders = prevParsed.tableCells;
            }
          }
          tableAlignments = parsedLine.tableAlignments || [];
          inTable = true;
        } else if (parsedLine.type === 'tableRow' && parsedLine.tableCells) {
          if (inTable) {
            tableRows.push(parsedLine.tableCells);
          }
        }
      } else {
        if (inTable && tableHeaders.length > 0) {
          renderTable(ctx, tableHeaders, tableAlignments, tableRows, startX, maxWidth);
          inTable = false;
          tableHeaders = [];
          tableAlignments = [];
          tableRows = [];
        }
        renderMarkdownLineInBubble(ctx, parsedLine, startX, maxWidth);
      }
    }
  }

  // Flush remaining table
  if (inTable && tableHeaders.length > 0) {
    renderTable(ctx, tableHeaders, tableAlignments, tableRows, startX, maxWidth);
  }

  // Handle unclosed code block
  if (inCodeBlock && codeBlockContent.trim()) {
    renderCodeBlock(ctx, codeBlockContent, codeLanguage, startX, maxWidth);
  }
}

/**
 * Render a complete message with bubble style
 */
export function renderMessage(ctx: RenderContext, msg: ExportMessage): void {
  const { pdf, pageWidth, margin, contentWidth } = ctx;
  const isUser = msg.type === 'user';
  const label = isUser ? msg.userName || 'User' : msg.teamName || msg.botName || 'AI';
  const timestamp = formatTimestamp(msg.timestamp);
  const style = isUser ? BUBBLE_STYLES.user : BUBBLE_STYLES.ai;
  const { padding, iconSize, messagePadding, maxWidthPercent, borderRadius } = BUBBLE_STYLES.common;

  // Sanitize and prepare content
  let content = sanitizeEmojisForPdf(msg.content);
  content = sanitizeContent(content);

  if (isUser) {
    // User message: render with compact bubble style
    const bubbleMaxWidth = contentWidth * maxWidthPercent;
    const bubbleContentWidth = bubbleMaxWidth - padding * 2;
    const iconSpacing = iconSize + 2;

    checkNewPage(ctx, 20 + messagePadding);

    const bubbleStartY = ctx.yPosition;
    const bubbleX = pageWidth - margin - bubbleMaxWidth;
    const iconX = bubbleX - iconSpacing;

    drawBubbleIcon(ctx, iconX, bubbleStartY, isUser, label);

    const contentStartX = bubbleX + padding;
    const contentMaxWidth = bubbleContentWidth;

    ctx.yPosition = bubbleStartY + padding;

    // Draw message header
    pdf.setFontSize(8);
    setFontForText(pdf, label, 'bold');
    pdf.setTextColor(66, 133, 244);
    pdf.text(label, contentStartX, ctx.yPosition);

    pdf.setFontSize(6);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(140, 140, 140);
    pdf.text(timestamp, bubbleX + bubbleMaxWidth - padding, ctx.yPosition, { align: 'right' });
    ctx.yPosition += 4;

    if (msg.attachments && msg.attachments.length > 0) {
      renderAttachmentsInBubble(ctx, msg.attachments, contentStartX, contentMaxWidth);
    }

    renderMessageContentInBubble(ctx, content, contentStartX, contentMaxWidth);

    const bubbleEndY = ctx.yPosition + padding;
    const actualBubbleHeight = bubbleEndY - bubbleStartY;

    // Draw bubble background
    pdf.setFillColor(style.bgColor.r, style.bgColor.g, style.bgColor.b);
    pdf.setDrawColor(style.borderColor.r, style.borderColor.g, style.borderColor.b);
    pdf.setLineWidth(0.2);
    pdf.roundedRect(
      bubbleX,
      bubbleStartY,
      bubbleMaxWidth,
      actualBubbleHeight,
      borderRadius,
      borderRadius,
      'FD'
    );

    // Re-render content on top of bubble
    ctx.yPosition = bubbleStartY + padding;

    pdf.setFontSize(8);
    setFontForText(pdf, label, 'bold');
    pdf.setTextColor(66, 133, 244);
    pdf.text(label, contentStartX, ctx.yPosition);

    pdf.setFontSize(6);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(140, 140, 140);
    pdf.text(timestamp, bubbleX + bubbleMaxWidth - padding, ctx.yPosition, { align: 'right' });
    ctx.yPosition += 4;

    if (msg.attachments && msg.attachments.length > 0) {
      renderAttachmentsInBubble(ctx, msg.attachments, contentStartX, contentMaxWidth);
    }

    renderMessageContentInBubble(ctx, content, contentStartX, contentMaxWidth);

    ctx.yPosition = bubbleEndY + messagePadding;
  } else {
    // AI message: render without bubble
    const aiContentWidth = contentWidth;

    checkNewPage(ctx, 15 + messagePadding);

    const iconX = margin;
    const iconY = ctx.yPosition;
    drawBubbleIcon(ctx, iconX, iconY, false, label);

    pdf.setFontSize(8);
    setFontForText(pdf, label, 'bold');
    pdf.setTextColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b);
    pdf.text(label, margin + iconSize + 2, ctx.yPosition + 3);

    pdf.setFontSize(6);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(140, 140, 140);
    pdf.text(timestamp, pageWidth - margin, ctx.yPosition + 3, { align: 'right' });
    ctx.yPosition += iconSize + 6; // Increased spacing between header and content

    renderMessageContentInBubble(ctx, content, margin, aiContentWidth);

    ctx.yPosition += messagePadding;
  }
}
