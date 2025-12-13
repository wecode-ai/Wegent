// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import jsPDF from 'jspdf';

/**
 * Attachment info for PDF export
 */
export interface ExportAttachment {
  id: number;
  filename: string;
  file_size: number;
  file_extension: string;
  /** Base64 encoded image data (for images only, loaded before PDF generation) */
  imageData?: string;
}

/**
 * Message structure for PDF export
 */
export interface ExportMessage {
  type: 'user' | 'ai';
  content: string;
  timestamp: number;
  botName?: string;
  userName?: string;
  teamName?: string;
  attachments?: ExportAttachment[];
}

/**
 * PDF export options
 */
export interface PdfExportOptions {
  taskName: string;
  messages: ExportMessage[];
}

/**
 * Primary color for Wegent brand
 */
const PRIMARY_COLOR = { r: 20, g: 184, b: 166 }; // #14B8A6

/**
 * Colors for markdown rendering
 * Text color changed to #1a1a1a for better readability
 */
const COLORS = {
  text: { r: 26, g: 26, b: 26 }, // #1a1a1a - deep black for readability
  heading: { r: 26, g: 26, b: 26 }, // #1a1a1a - deep black for readability
  link: { r: 85, g: 185, b: 247 },
  code: { r: 207, g: 34, b: 46 },
  codeBlockBg: { r: 246, g: 248, b: 250 },
  codeBlockText: { r: 26, g: 26, b: 26 }, // #1a1a1a - deep black for readability
  blockquote: { r: 80, g: 80, b: 80 }, // Darker gray for better readability
  listMarker: { r: 80, g: 80, b: 80 }, // Darker gray for better readability
};

/**
 * Chat bubble styling configuration
 */
const BUBBLE_STYLES = {
  // User message bubble - light blue/green aligned right
  user: {
    bgColor: { r: 227, g: 242, b: 253 }, // #E3F2FD - light blue
    borderColor: { r: 187, g: 222, b: 251 }, // #BBDEFB - slightly darker blue
    iconText: 'User', // Will be replaced with user icon
    iconBgColor: { r: 66, g: 133, b: 244 }, // #4285F4 - Google blue
  },
  // AI message - no bubble, just plain text
  ai: {
    bgColor: { r: 255, g: 255, b: 255 }, // White - no visible background
    borderColor: { r: 255, g: 255, b: 255 }, // White - no visible border
    iconText: 'AI',
    iconBgColor: { r: 20, g: 184, b: 166 }, // #14B8A6 - Wegent teal
  },
  // Common bubble properties
  common: {
    borderRadius: 3, // mm - reduced for more compact look
    padding: 4, // mm - reduced padding for more compact bubbles
    maxWidthPercent: 0.85, // 85% of content width - wider for better readability
    iconSize: 5, // mm (diameter) - slightly smaller
    messagePadding: 8, // mm spacing between messages - reduced
  },
};

/**
 * Unicode font configuration for extended character support (CJK, etc.)
 * Using Noto Sans SC which supports Latin, CJK and other Unicode characters
 * Font file is stored locally in public/fonts/
 */
const UNICODE_FONT_PATH = '/fonts/SourceHanSansSC-VF.ttf';
const UNICODE_FONT_NAME = 'NotoSansSC';
/**
 * Font loading state
 * fontDataCache stores the loaded font data for reuse across PDF instances
 */
let fontDataCache: ArrayBuffer | null = null;
let fontLoadPromise: Promise<ArrayBuffer> | null = null;

/**
 * Load Unicode font from local assets
 * Caches the font data for reuse across multiple PDF generations
 */
async function loadUnicodeFont(): Promise<ArrayBuffer> {
  // Return cached font data if available
  if (fontDataCache) {
    return fontDataCache;
  }

  // Return existing promise if font is being loaded
  if (fontLoadPromise) {
    return fontLoadPromise;
  }

  fontLoadPromise = fetch(UNICODE_FONT_PATH)
    .then(response => {
      if (!response.ok) {
        throw new Error(`Failed to load font: ${response.status}`);
      }
      return response.arrayBuffer();
    })
    .then(data => {
      // Cache the font data for future use
      fontDataCache = data;
      return data;
    })
    .catch(error => {
      fontLoadPromise = null;
      throw error;
    });
  return fontLoadPromise;
}

/**
 * Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Track which jsPDF instances have had the font added
 * Using WeakSet to allow garbage collection of PDF instances
 */
const pdfInstancesWithFont = new WeakSet<jsPDF>();

/**
 * Add Unicode font to jsPDF instance for extended character support
 * Each jsPDF instance needs to have the font added separately
 */
async function addUnicodeFontToPdf(pdf: jsPDF): Promise<boolean> {
  // Check if this specific PDF instance already has the font
  if (pdfInstancesWithFont.has(pdf)) {
    return true;
  }

  try {
    const fontData = await loadUnicodeFont();
    const fontBase64 = arrayBufferToBase64(fontData);

    // Add font to this jsPDF instance's virtual file system
    pdf.addFileToVFS(`${UNICODE_FONT_NAME}.ttf`, fontBase64);
    pdf.addFont(`${UNICODE_FONT_NAME}.ttf`, UNICODE_FONT_NAME, 'normal');

    // Mark this instance as having the font
    pdfInstancesWithFont.add(pdf);
    return true;
  } catch (error) {
    console.warn('Failed to load Unicode font, falling back to default font:', error);
    return false;
  }
}
/**
 * Check if text contains extended Unicode characters (CJK, Box Drawing, etc.)
 * that require special font support
 */
function requiresUnicodeFont(text: string): boolean {
  // CJK Unified Ideographs and extensions, plus Box Drawing characters
  return /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u2500-\u257f\u2580-\u259f]/.test(
    text
  );
}

/**
 * Check if a jsPDF instance has Unicode font loaded
 */
function hasUnicodeFontLoaded(pdf: jsPDF): boolean {
  return pdfInstancesWithFont.has(pdf);
}

/**
 * Common emoji to text mapping for PDF export
 * Maps frequently used emojis to their text equivalents
 */
const EMOJI_TO_TEXT_MAP: Record<string, string> = {
  // Status & Indicators
  '✅': '[OK]',
  '❌': '[X]',
  '⚠️': '[!]',
  '❗': '[!]',
  '❓': '[?]',
  '💡': '[i]',
  '📌': '[*]',
  '🔴': '[R]',
  '🟢': '[G]',
  '🟡': '[Y]',
  '🔵': '[B]',
  '⭐': '[*]',
  '🌟': '[*]',
  '✨': '[*]',

  // Actions & Objects
  '📁': '[Folder]',
  '📂': '[Folder]',
  '📄': '[File]',
  '📝': '[Note]',
  '📋': '[List]',
  '📎': '[Clip]',
  '🔗': '[Link]',
  '🔒': '[Lock]',
  '🔓': '[Unlock]',
  '🔑': '[Key]',
  '⚙️': '[Settings]',
  '🛠️': '[Tools]',
  '🔧': '[Tool]',
  '🔨': '[Hammer]',
  '💻': '[PC]',
  '🖥️': '[Desktop]',
  '📱': '[Mobile]',
  '🌐': '[Web]',
  '☁️': '[Cloud]',

  // Communication
  '💬': '[Chat]',
  '💭': '[Thought]',
  '📧': '[Email]',
  '📨': '[Message]',
  '📩': '[Inbox]',
  '📤': '[Outbox]',
  '📥': '[Download]',
  '📢': '[Announce]',
  '🔔': '[Bell]',
  '🔕': '[Mute]',

  // Emotions & Reactions
  '👍': '[+1]',
  '👎': '[-1]',
  '👏': '[Clap]',
  '🎉': '[Party]',
  '🎊': '[Celebrate]',
  '😀': ':)',
  '😃': ':)',
  '😄': ':D',
  '😊': ':)',
  '😢': ':(',
  '😭': ":'(",
  '😡': '>:(',
  '🤔': '[Think]',
  '😱': '[Shock]',
  '🙏': '[Thanks]',
  '❤️': '[Heart]',
  '💔': '[Broken Heart]',
  '🔥': '[Fire]',
  '💯': '[100]',

  // Arrows & Symbols
  '➡️': '->',
  '⬅️': '<-',
  '⬆️': '^',
  '⬇️': 'v',
  '↩️': '<-',
  '↪️': '->',
  '🔄': '[Refresh]',
  '♻️': '[Recycle]',
  '➕': '+',
  '➖': '-',
  '✖️': 'x',
  '➗': '/',
  '💲': '$',
  '💰': '[$]',
  '📈': '[Up]',
  '📉': '[Down]',
  '📊': '[Chart]',

  // Time & Calendar
  '⏰': '[Clock]',
  '⏱️': '[Timer]',
  '⏳': '[Hourglass]',
  '📅': '[Calendar]',
  '📆': '[Date]',
  '🕐': '[1:00]',
  '🕑': '[2:00]',
  '🕒': '[3:00]',
  '🕓': '[4:00]',
  '🕔': '[5:00]',
  '🕕': '[6:00]',
  '🕖': '[7:00]',
  '🕗': '[8:00]',
  '🕘': '[9:00]',
  '🕙': '[10:00]',
  '🕚': '[11:00]',
  '🕛': '[12:00]',

  // Nature & Weather
  '☀️': '[Sun]',
  '🌙': '[Moon]',
  '🌈': '[Rainbow]',
  '🌧️': '[Rain]',
  '❄️': '[Snow]',
  '🌊': '[Wave]',
  '🌲': '[Tree]',
  '🌸': '[Flower]',
  '🍀': '[Clover]',

  // Numbers in circles
  '①': '(1)',
  '②': '(2)',
  '③': '(3)',
  '④': '(4)',
  '⑤': '(5)',
  '⑥': '(6)',
  '⑦': '(7)',
  '⑧': '(8)',
  '⑨': '(9)',
  '⑩': '(10)',

  // Misc
  '🚀': '[Rocket]',
  '🎯': '[Target]',
  '🏆': '[Trophy]',
  '🎁': '[Gift]',
  '🔍': '[Search]',
  '🔎': '[Search]',
  '📷': '[Camera]',
  '🎵': '[Music]',
  '🎶': '[Music]',
  '🎬': '[Video]',
  '🎮': '[Game]',
  '🏠': '[Home]',
  '🏢': '[Building]',
  '🚗': '[Car]',
  '✈️': '[Plane]',
  '🚢': '[Ship]',
  '🍕': '[Pizza]',
  '🍔': '[Burger]',
  '☕': '[Coffee]',
  '🍺': '[Beer]',
  '🍷': '[Wine]',
};

/**
 * Regex pattern to match emoji characters
 * Covers most common emoji ranges including:
 * - Emoticons
 * - Dingbats
 * - Symbols
 * - Transport and map symbols
 * - Miscellaneous symbols
 * - Emoji modifiers and sequences
 */
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2300}-\u{23FF}]|[\u{2B50}-\u{2B55}]|[\u{200D}]|[\u{FE0F}]|[\u{20E3}]|[\u{E0020}-\u{E007F}]|[\u{1FA00}-\u{1FAFF}]|[\u{1F900}-\u{1F9FF}]/gu;

/**
 * Remove or replace emoji characters in text for PDF compatibility
 * Emojis are replaced with text equivalents where available, otherwise removed
 *
 * @param text - Input text that may contain emojis
 * @returns Text with emojis replaced or removed
 */
function sanitizeEmojisForPdf(text: string): string {
  if (!text) return text;

  let result = text;

  // First, replace known emojis with their text equivalents
  for (const [emoji, replacement] of Object.entries(EMOJI_TO_TEXT_MAP)) {
    result = result.split(emoji).join(replacement);
  }

  // Then remove any remaining emojis that weren't in our map
  result = result.replace(EMOJI_REGEX, '');

  // Clean up any double spaces that might have been created
  result = result.replace(/  +/g, ' ');

  return result;
}

/**
 * Set appropriate font based on text content
 * Uses Unicode font if text contains extended characters
 */
function setFontForText(
  pdf: jsPDF,
  text: string,
  style: 'normal' | 'bold' | 'italic' | 'bolditalic' = 'normal'
): void {
  if (hasUnicodeFontLoaded(pdf) && requiresUnicodeFont(text)) {
    // Unicode font only supports normal style
    pdf.setFont(UNICODE_FONT_NAME, 'normal');
  } else {
    pdf.setFont('helvetica', style);
  }
}

/**
 * Sanitize filename by removing or replacing invalid characters
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();
}

/**
 * Format date for filename
 */
function formatDateForFilename(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: number): string {
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) return '';
  return new Date(timestamp).toLocaleString(navigator.language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Get file type label based on file extension
 * Uses simple text labels instead of emoji for PDF compatibility
 */
function getFileTypeLabel(extension: string): string {
  const ext = extension.toLowerCase().replace('.', '');
  const labelMap: Record<string, string> = {
    // Documents
    pdf: '[PDF]',
    doc: '[DOC]',
    docx: '[DOC]',
    txt: '[TXT]',
    md: '[MD]',
    // Code
    js: '[JS]',
    ts: '[TS]',
    py: '[PY]',
    java: '[JAVA]',
    cpp: '[CPP]',
    c: '[C]',
    // Archives
    zip: '[ZIP]',
    rar: '[RAR]',
    '7z': '[7Z]',
    tar: '[TAR]',
    gz: '[GZ]',
    // Spreadsheets
    xls: '[XLS]',
    xlsx: '[XLSX]',
    csv: '[CSV]',
    // Presentations
    ppt: '[PPT]',
    pptx: '[PPT]',
    // Images
    jpg: '[IMG]',
    jpeg: '[IMG]',
    png: '[IMG]',
    gif: '[IMG]',
    bmp: '[IMG]',
    webp: '[IMG]',
  };
  return labelMap[ext] || '[FILE]';
}

/**
 * Image file extensions
 */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

/**
 * Check if a file extension is an image type
 */
function isImageExtension(extension: string): boolean {
  const ext = extension.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if a line is a code block delimiter
 */
function isCodeBlockDelimiter(line: string): boolean {
  return line.trim().startsWith('```');
}

/**
 * Extract language from code block delimiter
 */
function extractCodeLanguage(line: string): string {
  const match = line.trim().match(/^```(\w*)/);
  return match?.[1] || '';
}

/**
 * Parsed text segment with style information
 */
interface TextSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
  strikethrough?: boolean;
}

/**
 * Parse inline markdown formatting and return styled segments
 * Supports: **bold**, *italic*, `code`, [link](url), ~~strikethrough~~
 */
function parseInlineMarkdown(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let remaining = text;

  // Regex patterns for inline markdown
  const patterns: Array<{
    regex: RegExp;
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
    strikethrough?: boolean;
    isLink?: boolean;
  }> = [
    // Bold + Italic (must come before bold and italic)
    { regex: /\*\*\*(.+?)\*\*\*/, bold: true, italic: true },
    { regex: /___(.+?)___/, bold: true, italic: true },
    // Bold
    { regex: /\*\*(.+?)\*\*/, bold: true },
    { regex: /__(.+?)__/, bold: true },
    // Italic
    { regex: /\*([^*]+)\*/, italic: true },
    { regex: /_([^_]+)_/, italic: true },
    // Strikethrough
    { regex: /~~(.+?)~~/, strikethrough: true },
    // Inline code
    { regex: /`([^`]+)`/, code: true },
    // Link
    { regex: /\[([^\]]+)\]\(([^)]+)\)/, isLink: true },
  ];

  while (remaining.length > 0) {
    let earliestMatch: { index: number; length: number; segment: TextSegment } | null = null;

    for (const pattern of patterns) {
      const match = remaining.match(pattern.regex);
      if (match && match.index !== undefined) {
        const matchIndex = match.index;
        if (!earliestMatch || matchIndex < earliestMatch.index) {
          let segment: TextSegment;
          if (pattern.isLink) {
            segment = { text: match[1], link: match[2] };
          } else {
            segment = {
              text: match[1],
              bold: pattern.bold,
              italic: pattern.italic,
              code: pattern.code,
              strikethrough: pattern.strikethrough,
            };
          }
          earliestMatch = {
            index: matchIndex,
            length: match[0].length,
            segment,
          };
        }
      }
    }

    if (earliestMatch) {
      // Add plain text before the match
      if (earliestMatch.index > 0) {
        segments.push({ text: remaining.substring(0, earliestMatch.index) });
      }
      // Add the styled segment
      segments.push(earliestMatch.segment);
      // Continue with remaining text
      remaining = remaining.substring(earliestMatch.index + earliestMatch.length);
    } else {
      // No more matches, add remaining as plain text
      if (remaining.length > 0) {
        segments.push({ text: remaining });
      }
      break;
    }
  }

  return segments.length > 0 ? segments : [{ text }];
}

/**
 * Detect markdown line type
 */
type LineType =
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'unorderedList'
  | 'orderedList'
  | 'blockquote'
  | 'horizontalRule'
  | 'tableSeparator'
  | 'tableRow'
  | 'paragraph'
  | 'empty';

interface ParsedLine {
  type: LineType;
  content: string;
  level?: number; // For headings and lists
  listNumber?: number; // For ordered lists
  tableCells?: string[]; // For table rows
  tableAlignments?: ('left' | 'center' | 'right')[]; // For table separator
}

/**
 * Parse table row cells from a markdown table line
 */
function parseTableCells(line: string): string[] {
  // Remove leading and trailing pipes and split by pipe
  const trimmed = line.trim();
  const withoutPipes = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutEndPipe = withoutPipes.endsWith('|') ? withoutPipes.slice(0, -1) : withoutPipes;
  return withoutEndPipe.split('|').map(cell => cell.trim());
}

/**
 * Check if a line is a table separator (e.g., |---|---|---|)
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  // Table separator pattern: |:?-+:?|:?-+:?|... or :?-+:?|:?-+:?|...
  return /^\|?[\s]*:?-+:?[\s]*(\|[\s]*:?-+:?[\s]*)+\|?$/.test(trimmed);
}

/**
 * Check if a line looks like a table row
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  // Table row must contain at least one pipe character
  // and should have content (not just pipes)
  if (!trimmed.includes('|')) return false;
  // Check if it has actual content between pipes
  const cells = parseTableCells(trimmed);
  return cells.length >= 1 && cells.some(cell => cell.length > 0);
}

/**
 * Parse table alignments from separator line
 */
function parseTableAlignments(line: string): ('left' | 'center' | 'right')[] {
  const cells = parseTableCells(line);
  return cells.map(cell => {
    const trimmed = cell.trim();
    const hasLeftColon = trimmed.startsWith(':');
    const hasRightColon = trimmed.endsWith(':');
    if (hasLeftColon && hasRightColon) return 'center';
    if (hasRightColon) return 'right';
    return 'left';
  });
}

/**
 * Parse a single line to determine its markdown type
 */
function parseLineType(line: string, context?: { inTable?: boolean }): ParsedLine {
  const trimmed = line.trim();

  if (trimmed === '') {
    return { type: 'empty', content: '' };
  }

  // Table separator (must check before horizontal rule)
  if (isTableSeparator(trimmed)) {
    return {
      type: 'tableSeparator',
      content: trimmed,
      tableAlignments: parseTableAlignments(trimmed),
    };
  }

  // Table row (check if in table context or looks like a table row)
  if (context?.inTable || isTableRow(trimmed)) {
    const cells = parseTableCells(trimmed);
    if (cells.length >= 1) {
      return {
        type: 'tableRow',
        content: trimmed,
        tableCells: cells,
      };
    }
  }

  // Horizontal rule
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
    return { type: 'horizontalRule', content: '' };
  }

  // Headings
  const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
    const typeMap: Record<number, LineType> = {
      1: 'heading1',
      2: 'heading2',
      3: 'heading3',
      4: 'heading4',
      5: 'heading5',
      6: 'heading6',
    };
    return { type: typeMap[level], content: headingMatch[2], level };
  }

  // Unordered list
  const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)$/);
  if (unorderedMatch) {
    // Calculate indentation level
    const indent = line.length - line.trimStart().length;
    const level = Math.floor(indent / 2);
    return { type: 'unorderedList', content: unorderedMatch[1], level };
  }

  // Ordered list
  const orderedMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
  if (orderedMatch) {
    const indent = line.length - line.trimStart().length;
    const level = Math.floor(indent / 2);
    return {
      type: 'orderedList',
      content: orderedMatch[2],
      level,
      listNumber: parseInt(orderedMatch[1]),
    };
  }

  // Blockquote
  const blockquoteMatch = trimmed.match(/^>\s*(.*)$/);
  if (blockquoteMatch) {
    return { type: 'blockquote', content: blockquoteMatch[1] };
  }

  // Regular paragraph
  return { type: 'paragraph', content: trimmed };
}

/**
 * Generate PDF from selected messages with full markdown support
 * Uses native jsPDF text rendering to preserve text selectability
 */
export async function generateChatPdf(options: PdfExportOptions): Promise<void> {
  const { taskName, messages } = options;

  if (messages.length === 0) {
    throw new Error('No messages to export');
  }

  // Create PDF document (A4 size)
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  // Load Unicode font for extended character support (CJK, etc.)
  await addUnicodeFontToPdf(pdf);

  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let yPosition = margin;

  // Font sizes for different heading levels
  const headingSizes: Record<string, number> = {
    heading1: 16,
    heading2: 14,
    heading3: 12,
    heading4: 11,
    heading5: 10,
    heading6: 10,
  };
  // Line heights for different elements
  const lineHeights: Record<string, number> = {
    heading1: 8,
    heading2: 7,
    heading3: 6,
    heading4: 5.5,
    heading5: 5,
    heading6: 5,
    paragraph: 5,
    list: 5,
    code: 4.5,
    blockquote: 5,
    table: 6,
  };

  /**
   * Add header with logo and title
   */
  const addHeader = () => {
    // Logo text (Wegent)
    pdf.setFontSize(24);
    pdf.setTextColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Wegent AI', pageWidth / 2, yPosition, { align: 'center' });
    yPosition += 10;

    // Task title
    pdf.setFontSize(16);
    pdf.setTextColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b);
    setFontForText(pdf, taskName, 'bold');
    const titleLines = pdf.splitTextToSize(taskName, contentWidth);
    pdf.text(titleLines, pageWidth / 2, yPosition, { align: 'center' });
    yPosition += titleLines.length * 7 + 5;

    // Divider line
    pdf.setDrawColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b);
    pdf.setLineWidth(0.5);
    pdf.line(margin, yPosition, pageWidth - margin, yPosition);
    yPosition += 10;
  };

  /**
   * Add footer with watermark
   */
  const addFooter = (pageNum: number) => {
    pdf.setFontSize(8);
    pdf.setTextColor(160, 160, 160);
    pdf.setFont('helvetica', 'normal');
    pdf.text('Exported from Wegent', pageWidth / 2, pageHeight - 10, { align: 'center' });
    pdf.text(`Page ${pageNum}`, pageWidth - margin, pageHeight - 10, { align: 'right' });
  };

  /**
   * Check if we need a new page
   * Note: After adding a new page, jsPDF resets font state to default.
   * The caller is responsible for re-setting the appropriate font/style after this returns true.
   */
  const checkNewPage = (requiredHeight: number, pageNum: { value: number }) => {
    if (yPosition + requiredHeight > pageHeight - 20) {
      addFooter(pageNum.value);
      pdf.addPage();
      pageNum.value++;
      yPosition = margin;
      return true;
    }
    return false;
  };

  /**
   * Render inline styled text segments with proper word wrapping
   * @param segments - Text segments with style information
   * @param startX - Starting X position
   * @param maxWidth - Maximum width for text
   * @param pageNum - Page number reference (for page break handling)
   * @param baseFontSize - Base font size (default: 10)
   * @param enablePageBreak - Whether to check for page breaks (default: true, set false for bubble content)
   */
  const renderStyledText = (
    segments: TextSegment[],
    startX: number,
    maxWidth: number,
    pageNum: { value: number },
    baseFontSize: number = 10,
    enablePageBreak: boolean = true
  ) => {
    let currentX = startX;
    // Use slightly smaller line height when page breaks are disabled (bubble mode)
    const lineHeight = enablePageBreak ? lineHeights.paragraph : lineHeights.paragraph - 0.5;

    /**
     * Helper function to set font style for a segment
     */
    const setSegmentStyle = (segment: TextSegment) => {
      let fontStyle: 'normal' | 'bold' | 'italic' | 'bolditalic' = 'normal';
      if (segment.bold && segment.italic) {
        fontStyle = 'bolditalic';
      } else if (segment.bold) {
        fontStyle = 'bold';
      } else if (segment.italic) {
        fontStyle = 'italic';
      }

      pdf.setFontSize(baseFontSize);

      if (segment.code) {
        pdf.setTextColor(COLORS.code.r, COLORS.code.g, COLORS.code.b);
        pdf.setFont('courier', 'normal');
      } else if (segment.link) {
        pdf.setTextColor(COLORS.link.r, COLORS.link.g, COLORS.link.b);
        setFontForText(pdf, segment.text, fontStyle);
      } else {
        pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);
        setFontForText(pdf, segment.text, fontStyle);
      }
    };

    /**
     * Helper function to draw text with optional decorations
     */
    const drawTextWithDecorations = (text: string, x: number, y: number, segment: TextSegment) => {
      pdf.text(text, x, y);
      const textWidth = pdf.getTextWidth(text);

      if (segment.link) {
        pdf.setDrawColor(COLORS.link.r, COLORS.link.g, COLORS.link.b);
        pdf.setLineWidth(0.2);
        pdf.line(x, y + 0.5, x + textWidth, y + 0.5);
        pdf.link(x, y - 3, textWidth, 4, { url: segment.link });
      }

      if (segment.strikethrough) {
        pdf.setDrawColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);
        pdf.setLineWidth(0.3);
        pdf.line(x, y - 1.5, x + textWidth, y - 1.5);
      }

      return textWidth;
    };

    /**
     * Helper function to handle line break with optional page break check
     */
    const handleLineBreak = (segment: TextSegment) => {
      yPosition += lineHeight;
      if (enablePageBreak && checkNewPage(lineHeight, pageNum)) {
        // Re-apply segment style after page break
        setSegmentStyle(segment);
      }
      currentX = startX;
    };

    for (const segment of segments) {
      setSegmentStyle(segment);

      const text = segment.text;
      const availableWidth = startX + maxWidth - currentX;

      // Check if the entire segment fits on the current line
      const fullTextWidth = pdf.getTextWidth(text);

      if (fullTextWidth <= availableWidth) {
        // Segment fits on current line
        const drawnWidth = drawTextWithDecorations(text, currentX, yPosition, segment);
        currentX += drawnWidth;
      } else {
        // Need to wrap the text
        // Split text into words for better wrapping (handles both CJK and Latin text)
        const words = splitTextIntoWrappableUnits(text);
        let currentLineText = '';

        for (let i = 0; i < words.length; i++) {
          const word = words[i];
          const testText = currentLineText + word;
          const testWidth = pdf.getTextWidth(testText);
          const currentAvailableWidth = startX + maxWidth - currentX;

          if (testWidth <= currentAvailableWidth) {
            // Word fits on current line
            currentLineText = testText;
          } else {
            // Word doesn't fit, need to handle wrapping
            if (currentLineText.length > 0) {
              // Draw accumulated text first
              const drawnWidth = drawTextWithDecorations(
                currentLineText,
                currentX,
                yPosition,
                segment
              );
              currentX += drawnWidth;
            }

            // Check if we need to move to next line
            const wordWidth = pdf.getTextWidth(word);
            if (currentX > startX && wordWidth > startX + maxWidth - currentX) {
              // Move to next line
              handleLineBreak(segment);
            }

            // Check if single word is wider than maxWidth (need character-level wrapping)
            if (wordWidth > maxWidth) {
              // Character-level wrapping for very long words
              let charIndex = 0;
              while (charIndex < word.length) {
                let charText = '';
                while (charIndex < word.length) {
                  const nextChar = word[charIndex];
                  const nextWidth = pdf.getTextWidth(charText + nextChar);
                  if (nextWidth > maxWidth && charText.length > 0) {
                    break;
                  }
                  charText += nextChar;
                  charIndex++;
                }

                if (charText.length > 0) {
                  drawTextWithDecorations(charText, currentX, yPosition, segment);
                  if (charIndex < word.length) {
                    handleLineBreak(segment);
                  } else {
                    currentX = startX + pdf.getTextWidth(charText);
                  }
                }
              }
              currentLineText = '';
            } else {
              // Word fits on a new line
              currentLineText = word;
            }
          }
        }

        // Draw any remaining text
        if (currentLineText.length > 0) {
          const drawnWidth = drawTextWithDecorations(currentLineText, currentX, yPosition, segment);
          currentX += drawnWidth;
        }
      }
    }
  };

  /**
   * Split text into wrappable units (words for Latin, characters for CJK)
   */
  const splitTextIntoWrappableUnits = (text: string): string[] => {
    const units: string[] = [];
    let currentUnit = '';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // Check if character is CJK (can break at any character)
      if (isCJKCharacter(char)) {
        // Push any accumulated Latin text first
        if (currentUnit.length > 0) {
          units.push(currentUnit);
          currentUnit = '';
        }
        // CJK characters are individual units
        units.push(char);
      } else if (char === ' ') {
        // Space is a word boundary for Latin text
        if (currentUnit.length > 0) {
          units.push(currentUnit + ' ');
          currentUnit = '';
        } else {
          units.push(' ');
        }
      } else {
        // Accumulate Latin characters
        currentUnit += char;
      }
    }

    // Push any remaining text
    if (currentUnit.length > 0) {
      units.push(currentUnit);
    }

    return units;
  };

  /**
   * Check if a character is CJK (Chinese, Japanese, Korean)
   */
  const isCJKCharacter = (char: string): boolean => {
    const code = char.charCodeAt(0);
    return (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
      (code >= 0xff00 && code <= 0xffef) || // Halfwidth and Fullwidth Forms
      (code >= 0x3040 && code <= 0x309f) || // Hiragana
      (code >= 0x30a0 && code <= 0x30ff) || // Katakana
      (code >= 0xac00 && code <= 0xd7af) // Hangul Syllables
    );
  };

  /**
   * Render a code block with background
   */
  const _renderCodeBlock = (code: string, language: string, pageNum: { value: number }) => {
    const codeLines = code.split('\n');
    const lineHeight = lineHeights.code;
    const padding = 3;
    const codeBlockHeight = codeLines.length * lineHeight + padding * 2;

    // Check if we need a new page
    checkNewPage(codeBlockHeight + 5, pageNum);

    // Draw background
    pdf.setFillColor(COLORS.codeBlockBg.r, COLORS.codeBlockBg.g, COLORS.codeBlockBg.b);
    pdf.setDrawColor(220, 220, 220);
    pdf.roundedRect(margin, yPosition - 3, contentWidth, codeBlockHeight, 2, 2, 'FD');

    // Draw language label if provided
    if (language) {
      pdf.setFontSize(8);
      pdf.setTextColor(150, 150, 150);
      pdf.setFont('helvetica', 'normal');
      pdf.text(language, margin + contentWidth - 5, yPosition, { align: 'right' });
    }

    yPosition += padding;

    // Draw code lines - use Unicode font for CJK characters in code
    pdf.setFontSize(9);
    pdf.setTextColor(COLORS.codeBlockText.r, COLORS.codeBlockText.g, COLORS.codeBlockText.b);

    for (const codeLine of codeLines) {
      checkNewPage(lineHeight, pageNum);
      // Check if line contains CJK characters and use appropriate font
      if (hasUnicodeFontLoaded(pdf) && requiresUnicodeFont(codeLine)) {
        pdf.setFont(UNICODE_FONT_NAME, 'normal');
      } else {
        pdf.setFont('courier', 'normal');
      }
      // Wrap long lines
      const wrappedLines = pdf.splitTextToSize(codeLine || ' ', contentWidth - padding * 2);
      for (const wrappedLine of wrappedLines) {
        pdf.text(wrappedLine, margin + padding, yPosition);
        yPosition += lineHeight;
      }
    }

    yPosition += padding + 2;
  };

  /**
   * Render a table with headers and rows
   * Supports text wrapping within cells
   */
  const _renderTable = (
    headers: string[],
    alignments: ('left' | 'center' | 'right')[],
    rows: string[][],
    pageNum: { value: number }
  ) => {
    if (headers.length === 0) return;

    const cellPadding = 2;
    const cellLineHeight = 4; // Line height for text within cells
    const numCols = headers.length;

    // Calculate column widths - distribute evenly with minimum width
    const minColWidth = 20;
    const evenWidth = contentWidth / numCols;
    const colWidths: number[] = [];

    for (let col = 0; col < numCols; col++) {
      colWidths.push(Math.max(minColWidth, evenWidth));
    }

    // Adjust column widths to fit content width exactly
    const totalWidth = colWidths.reduce((sum, w) => sum + w, 0);
    if (totalWidth !== contentWidth) {
      const scale = contentWidth / totalWidth;
      for (let i = 0; i < colWidths.length; i++) {
        colWidths[i] *= scale;
      }
    }

    const tableWidth = colWidths.reduce((sum, w) => sum + w, 0);

    /**
     * Calculate wrapped lines for a cell
     */
    const getCellLines = (text: string, colWidth: number, isBold: boolean): string[] => {
      pdf.setFontSize(9);
      setFontForText(pdf, text, isBold ? 'bold' : 'normal');
      const maxTextWidth = colWidth - cellPadding * 2;
      return pdf.splitTextToSize(text || '', maxTextWidth);
    };

    /**
     * Calculate row height based on content (max lines in any cell)
     */
    const calculateRowHeight = (
      rowData: string[],
      isBold: boolean
    ): { height: number; cellLines: string[][] } => {
      const cellLines: string[][] = [];
      let maxLines = 1;

      for (let col = 0; col < numCols; col++) {
        const lines = getCellLines(rowData[col] || '', colWidths[col], isBold);
        cellLines.push(lines);
        maxLines = Math.max(maxLines, lines.length);
      }

      const height = maxLines * cellLineHeight + cellPadding * 2;
      return { height, cellLines };
    };

    /**
     * Draw a single row with wrapped text
     */
    const drawRow = (
      rowData: string[],
      rowY: number,
      rowHeight: number,
      cellLines: string[][],
      isBold: boolean,
      isHeader: boolean,
      isAlternate: boolean
    ) => {
      let xPos = margin;

      // Draw row background
      if (isHeader) {
        pdf.setFillColor(246, 248, 250);
        pdf.setDrawColor(220, 220, 220);
        pdf.rect(margin, rowY, tableWidth, rowHeight, 'FD');
      } else if (isAlternate) {
        pdf.setFillColor(250, 250, 250);
        pdf.rect(margin, rowY, tableWidth, rowHeight, 'F');
      }

      // Draw bottom border
      pdf.setDrawColor(220, 220, 220);
      pdf.line(margin, rowY + rowHeight, margin + tableWidth, rowY + rowHeight);

      // Draw cell contents
      for (let col = 0; col < numCols; col++) {
        const cellWidth = colWidths[col];
        const lines = cellLines[col];
        const alignment = alignments[col] || 'left';

        pdf.setFontSize(9);
        if (isHeader) {
          pdf.setTextColor(COLORS.heading.r, COLORS.heading.g, COLORS.heading.b);
        } else {
          pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);
        }
        setFontForText(pdf, rowData[col] || '', isBold ? 'bold' : 'normal');

        // Draw each line of text
        const textStartY = rowY + cellPadding + cellLineHeight;
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const lineText = lines[lineIdx];
          const lineY = textStartY + lineIdx * cellLineHeight;

          // Calculate text position based on alignment
          let textX = xPos + cellPadding;
          if (alignment === 'center') {
            textX = xPos + cellWidth / 2;
          } else if (alignment === 'right') {
            textX = xPos + cellWidth - cellPadding;
          }

          const alignOption =
            alignment === 'left' ? undefined : { align: alignment as 'center' | 'right' };
          pdf.text(lineText, textX, lineY, alignOption);
        }

        // Draw vertical line (right border of cell)
        pdf.setDrawColor(220, 220, 220);
        pdf.line(xPos + cellWidth, rowY, xPos + cellWidth, rowY + rowHeight);

        xPos += cellWidth;
      }

      // Draw left border
      pdf.setDrawColor(220, 220, 220);
      pdf.line(margin, rowY, margin, rowY + rowHeight);
    };

    // Calculate header height
    const headerInfo = calculateRowHeight(headers, true);

    // Calculate all row heights first to check if table fits on page
    const rowInfos: { height: number; cellLines: string[][] }[] = [];
    for (const row of rows) {
      rowInfos.push(calculateRowHeight(row, false));
    }

    const totalTableHeight =
      headerInfo.height + rowInfos.reduce((sum, info) => sum + info.height, 0);

    // Check if we need a new page for the table
    checkNewPage(Math.min(totalTableHeight, headerInfo.height + 20), pageNum);

    // Draw header
    const headerY = yPosition;
    drawRow(headers, headerY, headerInfo.height, headerInfo.cellLines, true, true, false);
    yPosition += headerInfo.height;

    // Draw data rows
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      const rowInfo = rowInfos[rowIdx];

      // Check if we need a new page for this row
      if (checkNewPage(rowInfo.height, pageNum)) {
        // After page break, we might want to redraw header (optional)
        // For now, just continue with the row
      }

      const rowY = yPosition;
      drawRow(row, rowY, rowInfo.height, rowInfo.cellLines, false, false, rowIdx % 2 === 1);
      yPosition += rowInfo.height;
    }

    // Draw top border
    pdf.setDrawColor(220, 220, 220);
    pdf.line(margin, headerY, margin + tableWidth, headerY);

    yPosition += 3; // Space after table
  };

  /**
   * Render a markdown line based on its type
   */
  const _renderMarkdownLine = (parsedLine: ParsedLine, pageNum: { value: number }) => {
    const { type, content, level, listNumber } = parsedLine;

    switch (type) {
      case 'empty':
        yPosition += 3;
        break;

      case 'tableSeparator':
      case 'tableRow':
        // Tables are handled separately in renderMessage
        break;

      case 'horizontalRule':
        checkNewPage(5, pageNum);
        pdf.setDrawColor(200, 200, 200);
        pdf.setLineWidth(0.5);
        pdf.line(margin, yPosition, pageWidth - margin, yPosition);
        yPosition += 5;
        break;

      case 'heading1':
      case 'heading2':
      case 'heading3':
      case 'heading4':
      case 'heading5':
      case 'heading6': {
        const fontSize = headingSizes[type];
        const lineHeight = lineHeights[type];
        checkNewPage(lineHeight + 3, pageNum);

        // Add some space before heading
        yPosition += 2;

        pdf.setFontSize(fontSize);
        pdf.setTextColor(COLORS.heading.r, COLORS.heading.g, COLORS.heading.b);
        setFontForText(pdf, content, 'bold');

        const headingLines = pdf.splitTextToSize(content, contentWidth);
        for (const headingLine of headingLines) {
          pdf.text(headingLine, margin, yPosition);
          yPosition += lineHeight;
        }

        // Add underline for h1 and h2
        if (type === 'heading1' || type === 'heading2') {
          pdf.setDrawColor(220, 220, 220);
          pdf.setLineWidth(type === 'heading1' ? 0.5 : 0.3);
          pdf.line(margin, yPosition - 2, pageWidth - margin, yPosition - 2);
        }

        yPosition += 2;
        break;
      }

      case 'unorderedList': {
        const indent = (level || 0) * 5;
        checkNewPage(lineHeights.list, pageNum);

        // Draw bullet
        pdf.setFillColor(COLORS.listMarker.r, COLORS.listMarker.g, COLORS.listMarker.b);
        const bulletX = margin + indent + 2;
        const bulletY = yPosition - 1.5;
        pdf.circle(bulletX, bulletY, 0.8, 'F');

        // Draw content with inline formatting
        const segments = parseInlineMarkdown(content);
        const textStartX = margin + indent + 6;
        renderStyledText(segments, textStartX, contentWidth - indent - 6, pageNum);
        yPosition += lineHeights.list;
        break;
      }

      case 'orderedList': {
        const indent = (level || 0) * 5;
        checkNewPage(lineHeights.list, pageNum);

        // Draw number
        pdf.setFontSize(10);
        pdf.setTextColor(COLORS.listMarker.r, COLORS.listMarker.g, COLORS.listMarker.b);
        pdf.setFont('helvetica', 'normal');
        const numberText = `${listNumber}.`;
        pdf.text(numberText, margin + indent, yPosition);

        // Draw content with inline formatting
        const segments = parseInlineMarkdown(content);
        const textStartX = margin + indent + 8;
        renderStyledText(segments, textStartX, contentWidth - indent - 8, pageNum);
        yPosition += lineHeights.list;
        break;
      }

      case 'blockquote': {
        checkNewPage(lineHeights.blockquote + 2, pageNum);

        // Draw left border
        pdf.setDrawColor(200, 200, 200);
        pdf.setLineWidth(1);
        pdf.line(margin + 2, yPosition - 3, margin + 2, yPosition + 2);

        // Draw content
        pdf.setFontSize(10);
        pdf.setTextColor(COLORS.blockquote.r, COLORS.blockquote.g, COLORS.blockquote.b);
        setFontForText(pdf, content, 'italic');

        const quoteLines = pdf.splitTextToSize(content, contentWidth - 10);
        for (const quoteLine of quoteLines) {
          pdf.text(quoteLine, margin + 8, yPosition);
          yPosition += lineHeights.blockquote;
        }
        break;
      }

      case 'paragraph':
      default: {
        checkNewPage(lineHeights.paragraph, pageNum);

        // Parse and render inline markdown
        const segments = parseInlineMarkdown(content);
        renderStyledText(segments, margin, contentWidth, pageNum);
        yPosition += lineHeights.paragraph;
        break;
      }
    }
  };

  /**
   * Draw a chat bubble icon (user or AI)
   */
  const drawBubbleIcon = (x: number, y: number, isUser: boolean, _label: string) => {
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
  };

  /**
   * Calculate the height of message content for bubble sizing
   */
  const _calculateContentHeight = (content: string, bubbleContentWidth: number): number => {
    let height = 0;
    const lines = content.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (isCodeBlockDelimiter(line)) {
        if (!inCodeBlock) {
          inCodeBlock = true;
        } else {
          inCodeBlock = false;
          height += 6; // Code block padding - reduced
        }
        continue;
      }

      if (inCodeBlock) {
        pdf.setFontSize(8);
        pdf.setFont('courier', 'normal');
        const wrappedLines = pdf.splitTextToSize(line || ' ', bubbleContentWidth - 4);
        height += wrappedLines.length * lineHeights.code;
      } else {
        const parsedLine = parseLineType(line);
        if (parsedLine.type === 'empty') {
          height += 2; // Reduced empty line height
        } else if (parsedLine.type === 'heading1' || parsedLine.type === 'heading2') {
          pdf.setFontSize(headingSizes[parsedLine.type] - 2);
          const headingLines = pdf.splitTextToSize(parsedLine.content, bubbleContentWidth);
          height += headingLines.length * (lineHeights[parsedLine.type] - 1) + 2;
        } else {
          pdf.setFontSize(9);
          const textLines = pdf.splitTextToSize(parsedLine.content || ' ', bubbleContentWidth);
          height += textLines.length * (lineHeights.paragraph - 0.5);
        }
      }
    }

    return Math.max(height, 4); // Minimum height reduced to 4mm
  };

  /**
   * Process and render message content with chat bubble style layout
   * User messages appear on the right with light blue background
   * AI messages appear on the left with light gray background
   */
  const renderMessage = (msg: ExportMessage, pageNum: { value: number }) => {
    const isUser = msg.type === 'user';
    const label = isUser ? msg.userName || 'User' : msg.teamName || msg.botName || 'AI';
    const timestamp = formatTimestamp(msg.timestamp);
    const style = isUser ? BUBBLE_STYLES.user : BUBBLE_STYLES.ai;
    const { padding, iconSize, messagePadding, maxWidthPercent, borderRadius } =
      BUBBLE_STYLES.common;

    // Sanitize and prepare content
    let content = sanitizeEmojisForPdf(msg.content);
    content = content.replace(/\$\{\$\$\}\$/g, '\n');
    content = content.replace(/__PROGRESS_BAR__:.*?:\d+/g, '');
    content = content.replace(/__PROMPT_TRUNCATED__:.*?::(.*?)(?=\n|$)/g, '$1');

    if (isUser) {
      // User message: render with compact bubble style
      const bubbleMaxWidth = contentWidth * maxWidthPercent;
      const bubbleContentWidth = bubbleMaxWidth - padding * 2;
      const iconSpacing = iconSize + 2;

      // Check if we need a new page (estimate minimum height)
      checkNewPage(20 + messagePadding, pageNum);

      // Save starting position for bubble
      const bubbleStartY = yPosition;
      const bubbleX = pageWidth - margin - bubbleMaxWidth;
      const iconX = bubbleX - iconSpacing;

      // Draw icon first
      drawBubbleIcon(iconX, bubbleStartY, isUser, label);

      // Set content area boundaries
      const contentStartX = bubbleX + padding;
      const contentMaxWidth = bubbleContentWidth;

      // Move yPosition inside bubble for content
      yPosition = bubbleStartY + padding;

      // Draw message header (label and timestamp) - compact
      pdf.setFontSize(8);
      setFontForText(pdf, label, 'bold');
      pdf.setTextColor(66, 133, 244); // Blue for user
      pdf.text(label, contentStartX, yPosition);

      // Timestamp (smaller, gray, right-aligned within bubble)
      pdf.setFontSize(6);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(140, 140, 140);
      pdf.text(timestamp, bubbleX + bubbleMaxWidth - padding, yPosition, { align: 'right' });
      yPosition += 4;

      // Render attachments if present (for user messages)
      if (msg.attachments && msg.attachments.length > 0) {
        renderAttachmentsInBubble(msg.attachments, pageNum, contentStartX, contentMaxWidth);
      }

      // Render message content within bubble
      renderMessageContentInBubble(content, pageNum, contentStartX, contentMaxWidth);

      // Calculate actual bubble height based on rendered content
      const bubbleEndY = yPosition + padding;
      const actualBubbleHeight = bubbleEndY - bubbleStartY;

      // Draw bubble background with rounded corners (draw after content to know exact height)
      pdf.setFillColor(style.bgColor.r, style.bgColor.g, style.bgColor.b);
      pdf.setDrawColor(style.borderColor.r, style.borderColor.g, style.borderColor.b);
      pdf.setLineWidth(0.2);

      // User bubble: simple rounded rectangle - draw behind content
      // Note: We need to draw this first, but we calculated height after rendering
      // So we'll redraw the bubble now with correct height
      pdf.setFillColor(style.bgColor.r, style.bgColor.g, style.bgColor.b);
      pdf.roundedRect(
        bubbleX,
        bubbleStartY,
        bubbleMaxWidth,
        actualBubbleHeight,
        borderRadius,
        borderRadius,
        'FD'
      );

      // Re-render content on top of bubble background
      yPosition = bubbleStartY + padding;

      // Re-draw header
      pdf.setFontSize(8);
      setFontForText(pdf, label, 'bold');
      pdf.setTextColor(66, 133, 244);
      pdf.text(label, contentStartX, yPosition);

      pdf.setFontSize(6);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(140, 140, 140);
      pdf.text(timestamp, bubbleX + bubbleMaxWidth - padding, yPosition, { align: 'right' });
      yPosition += 4;

      // Re-render attachments
      if (msg.attachments && msg.attachments.length > 0) {
        renderAttachmentsInBubble(msg.attachments, pageNum, contentStartX, contentMaxWidth);
      }

      // Re-render content
      renderMessageContentInBubble(content, pageNum, contentStartX, contentMaxWidth);

      // Move to position after bubble
      yPosition = bubbleEndY + messagePadding;
    } else {
      // AI message: render without bubble, just plain text with label
      const aiContentWidth = contentWidth;

      // Check if we need a new page
      checkNewPage(15 + messagePadding, pageNum);

      // Draw AI label with icon
      const iconX = margin;
      const iconY = yPosition;
      drawBubbleIcon(iconX, iconY, false, label);

      // Draw label next to icon
      pdf.setFontSize(8);
      setFontForText(pdf, label, 'bold');
      pdf.setTextColor(PRIMARY_COLOR.r, PRIMARY_COLOR.g, PRIMARY_COLOR.b);
      pdf.text(label, margin + iconSize + 2, yPosition + 3);

      // Timestamp
      pdf.setFontSize(6);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(140, 140, 140);
      pdf.text(timestamp, pageWidth - margin, yPosition + 3, { align: 'right' });
      yPosition += iconSize + 2;

      // Render message content directly (no bubble)
      renderMessageContentInBubble(content, pageNum, margin, aiContentWidth);

      // Add spacing after AI message
      yPosition += messagePadding;
    }
  };

  /**
   * Render attachments within a chat bubble
   */
  const renderAttachmentsInBubble = (
    attachments: ExportAttachment[],
    pageNum: { value: number },
    startX: number,
    maxWidth: number
  ) => {
    for (const attachment of attachments) {
      const isImage = isImageExtension(attachment.file_extension);

      if (isImage && attachment.imageData) {
        renderImageAttachmentInBubble(attachment, pageNum, startX, maxWidth);
      } else {
        renderFileAttachmentInBubble(attachment, pageNum, startX, maxWidth);
      }
    }
    yPosition += 2;
  };

  /**
   * Render an image attachment within a bubble
   */
  const renderImageAttachmentInBubble = (
    attachment: ExportAttachment,
    pageNum: { value: number },
    startX: number,
    maxWidth: number
  ) => {
    if (!attachment.imageData) return;

    try {
      const imageFormat = getImageFormat(attachment.file_extension);
      const imgWidth = Math.min(maxWidth - 10, 60);
      const imgHeight = Math.min(50, 45);

      pdf.addImage(
        attachment.imageData,
        imageFormat,
        startX,
        yPosition,
        imgWidth,
        imgHeight,
        undefined,
        'FAST'
      );

      yPosition += imgHeight + 2;

      pdf.setFontSize(7);
      pdf.setTextColor(120, 120, 120);
      pdf.setFont('helvetica', 'normal');
      pdf.text(attachment.filename, startX, yPosition);
      yPosition += 4;
    } catch (error) {
      console.warn('Failed to render image attachment:', error);
      renderFileAttachmentInBubble(attachment, pageNum, startX, maxWidth);
    }
  };

  /**
   * Render a file attachment info within a bubble
   */
  const renderFileAttachmentInBubble = (
    attachment: ExportAttachment,
    pageNum: { value: number },
    startX: number,
    maxWidth: number
  ) => {
    const attachmentHeight = 7;

    // Draw attachment box
    pdf.setFillColor(255, 255, 255);
    pdf.setDrawColor(200, 200, 200);
    pdf.roundedRect(startX, yPosition - 3, maxWidth - 10, attachmentHeight, 1, 1, 'FD');

    // File type label
    const fileTypeLabel = getFileTypeLabel(attachment.file_extension);
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(100, 100, 100);
    pdf.text(fileTypeLabel, startX + 2, yPosition);

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
    pdf.text(displayFilename, startX + 10, yPosition);

    // File size
    pdf.setFontSize(7);
    pdf.setTextColor(140, 140, 140);
    pdf.setFont('helvetica', 'normal');
    const sizeText = formatFileSize(attachment.file_size);
    pdf.text(sizeText, startX + maxWidth - 15, yPosition, { align: 'right' });

    yPosition += attachmentHeight + 2;
  };

  /**
   * Render message content within a chat bubble
   */
  const renderMessageContentInBubble = (
    content: string,
    pageNum: { value: number },
    startX: number,
    maxWidth: number
  ) => {
    const lines = content.split('\n');
    let inCodeBlock = false;
    let codeBlockContent = '';
    let codeLanguage = '';

    // Table state
    let inTable = false;
    let tableHeaders: string[] = [];
    let tableAlignments: ('left' | 'center' | 'right')[] = [];
    let tableRows: string[][] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (isCodeBlockDelimiter(line)) {
        // Flush any pending table before code block
        if (inTable && tableHeaders.length > 0) {
          renderTableInBubble(tableHeaders, tableAlignments, tableRows, pageNum, startX, maxWidth);
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
            renderCodeBlockInBubble(codeBlockContent, codeLanguage, pageNum, startX, maxWidth);
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
            renderTableInBubble(
              tableHeaders,
              tableAlignments,
              tableRows,
              pageNum,
              startX,
              maxWidth
            );
            inTable = false;
            tableHeaders = [];
            tableAlignments = [];
            tableRows = [];
          }
          renderMarkdownLineInBubble(parsedLine, pageNum, startX, maxWidth);
        }
      }
    }

    // Flush remaining table
    if (inTable && tableHeaders.length > 0) {
      renderTableInBubble(tableHeaders, tableAlignments, tableRows, pageNum, startX, maxWidth);
    }

    // Handle unclosed code block
    if (inCodeBlock && codeBlockContent.trim()) {
      renderCodeBlockInBubble(codeBlockContent, codeLanguage, pageNum, startX, maxWidth);
    }
  };

  /**
   * Render a code block within a bubble
   */
  const renderCodeBlockInBubble = (
    code: string,
    language: string,
    pageNum: { value: number },
    startX: number,
    maxWidth: number
  ) => {
    const codeLines = code.split('\n');
    const lineHeight = lineHeights.code;
    const codePadding = 2;

    // Check if we need a new page before starting the code block
    checkNewPage(lineHeight * 3 + codePadding * 2, pageNum);

    // Calculate the height of this code block segment (may span multiple pages)
    const codeBlockStartY = yPosition - 2;
    let currentBlockStartY = codeBlockStartY;

    // Draw initial code background header with language label
    pdf.setFillColor(COLORS.codeBlockBg.r, COLORS.codeBlockBg.g, COLORS.codeBlockBg.b);
    pdf.setDrawColor(200, 200, 200);

    // Language label
    if (language) {
      pdf.setFontSize(7);
      pdf.setTextColor(140, 140, 140);
      pdf.setFont('helvetica', 'normal');
      pdf.text(language, startX + maxWidth - 3, yPosition, { align: 'right' });
    }

    yPosition += codePadding;

    // Draw code lines - use Unicode font for CJK characters in code
    pdf.setFontSize(8);
    pdf.setTextColor(COLORS.codeBlockText.r, COLORS.codeBlockText.g, COLORS.codeBlockText.b);

    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 20;

    for (const codeLine of codeLines) {
      // Check if line contains CJK characters and use appropriate font
      if (hasUnicodeFontLoaded(pdf) && requiresUnicodeFont(codeLine)) {
        pdf.setFont(UNICODE_FONT_NAME, 'normal');
      } else {
        pdf.setFont('courier', 'normal');
      }
      const wrappedLines = pdf.splitTextToSize(codeLine || ' ', maxWidth - codePadding * 2);
      for (const wrappedLine of wrappedLines) {
        // Check if we need a new page
        if (yPosition + lineHeight > pageHeight - 20) {
          // Draw background for current page segment
          const segmentHeight = yPosition - currentBlockStartY + codePadding;
          pdf.setFillColor(COLORS.codeBlockBg.r, COLORS.codeBlockBg.g, COLORS.codeBlockBg.b);
          pdf.setDrawColor(200, 200, 200);
          pdf.roundedRect(startX, currentBlockStartY, maxWidth, segmentHeight, 1.5, 1.5, 'FD');

          // Re-render the text on this page (since we drew the background after)
          // This is handled by the fact that we're drawing line by line

          // Add new page
          addFooter(pageNum.value);
          pdf.addPage();
          pageNum.value++;
          yPosition = margin;
          currentBlockStartY = yPosition - 2;

          // Reset font after page break
          pdf.setFontSize(8);
          pdf.setTextColor(COLORS.codeBlockText.r, COLORS.codeBlockText.g, COLORS.codeBlockText.b);
          if (hasUnicodeFontLoaded(pdf) && requiresUnicodeFont(codeLine)) {
            pdf.setFont(UNICODE_FONT_NAME, 'normal');
          } else {
            pdf.setFont('courier', 'normal');
          }
        }
        pdf.text(wrappedLine, startX + codePadding, yPosition);
        yPosition += lineHeight;
      }
    }

    // Draw final code block background
    const finalSegmentHeight = yPosition - currentBlockStartY + codePadding;
    pdf.setFillColor(COLORS.codeBlockBg.r, COLORS.codeBlockBg.g, COLORS.codeBlockBg.b);
    pdf.setDrawColor(200, 200, 200);
    pdf.roundedRect(startX, currentBlockStartY, maxWidth, finalSegmentHeight, 1.5, 1.5, 'FD');

    // Re-render code lines on top of background for the last segment
    // We need to track which lines belong to the current page segment
    yPosition = currentBlockStartY + 2 + codePadding;
    pdf.setFontSize(8);
    pdf.setTextColor(COLORS.codeBlockText.r, COLORS.codeBlockText.g, COLORS.codeBlockText.b);

    // Re-render all code lines (simplified approach - works for most cases)
    for (const codeLine of codeLines) {
      if (hasUnicodeFontLoaded(pdf) && requiresUnicodeFont(codeLine)) {
        pdf.setFont(UNICODE_FONT_NAME, 'normal');
      } else {
        pdf.setFont('courier', 'normal');
      }
      const wrappedLines = pdf.splitTextToSize(codeLine || ' ', maxWidth - codePadding * 2);
      for (const wrappedLine of wrappedLines) {
        if (yPosition > currentBlockStartY && yPosition < pageHeight - 20) {
          pdf.text(wrappedLine, startX + codePadding, yPosition);
        }
        yPosition += lineHeight;
      }
    }

    yPosition += codePadding + 1;
  };

  /**
   * Render a table within a bubble
   */
  const renderTableInBubble = (
    headers: string[],
    alignments: ('left' | 'center' | 'right')[],
    rows: string[][],
    pageNum: { value: number },
    startX: number,
    maxWidth: number
  ) => {
    if (headers.length === 0) return;

    const cellPadding = 1.5;
    const cellLineHeight = 4;
    const numCols = headers.length;
    const colWidth = maxWidth / numCols;
    const rowHeight = cellLineHeight + cellPadding * 2;

    // Check if we need a new page for the header
    checkNewPage(rowHeight + 5, pageNum);

    // Draw header row background
    const headerY = yPosition;
    pdf.setFillColor(240, 240, 240);
    pdf.setDrawColor(200, 200, 200);
    pdf.rect(startX, headerY, maxWidth, rowHeight, 'FD');

    // Draw header text
    pdf.setFontSize(8);
    pdf.setTextColor(COLORS.heading.r, COLORS.heading.g, COLORS.heading.b);

    let xPos = startX;
    const textY = headerY + cellPadding + cellLineHeight * 0.7; // Vertically center text
    for (let col = 0; col < numCols; col++) {
      setFontForText(pdf, headers[col] || '', 'bold');
      const cellText = pdf.splitTextToSize(headers[col] || '', colWidth - cellPadding * 2)[0] || '';
      pdf.text(cellText, xPos + cellPadding, textY);
      xPos += colWidth;
    }

    // Draw top border
    pdf.setDrawColor(200, 200, 200);
    pdf.line(startX, headerY, startX + maxWidth, headerY);

    yPosition = headerY + rowHeight;

    // Draw data rows
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];

      // Check if we need a new page for this row
      checkNewPage(rowHeight, pageNum);

      const rowStartY = yPosition;

      // Draw row background for alternating rows
      if (rowIdx % 2 === 1) {
        pdf.setFillColor(248, 248, 248);
        pdf.rect(startX, rowStartY, maxWidth, rowHeight, 'F');
      }

      // Draw bottom border
      pdf.setDrawColor(200, 200, 200);
      pdf.line(startX, rowStartY + rowHeight, startX + maxWidth, rowStartY + rowHeight);

      // Draw cell text
      pdf.setFontSize(8);
      pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);

      xPos = startX;
      const rowTextY = rowStartY + cellPadding + cellLineHeight * 0.7; // Vertically center text
      for (let col = 0; col < numCols; col++) {
        setFontForText(pdf, row[col] || '', 'normal');
        const cellText = pdf.splitTextToSize(row[col] || '', colWidth - cellPadding * 2)[0] || '';
        pdf.text(cellText, xPos + cellPadding, rowTextY);
        xPos += colWidth;
      }

      yPosition += rowHeight;
    }

    yPosition += 2;
  };

  /**
   * Render a markdown line within a bubble
   */
  const renderMarkdownLineInBubble = (
    parsedLine: ParsedLine,
    pageNum: { value: number },
    startX: number,
    maxWidth: number
  ) => {
    const { type, content, level, listNumber } = parsedLine;

    switch (type) {
      case 'empty':
        yPosition += 2;
        break;

      case 'tableSeparator':
      case 'tableRow':
        break;

      case 'horizontalRule':
        checkNewPage(5, pageNum);
        pdf.setDrawColor(180, 180, 180);
        pdf.setLineWidth(0.3);
        pdf.line(startX, yPosition, startX + maxWidth, yPosition);
        yPosition += 3;
        break;

      case 'heading1':
      case 'heading2':
      case 'heading3':
      case 'heading4':
      case 'heading5':
      case 'heading6': {
        const fontSize = Math.max(headingSizes[type] - 2, 9);
        const lineHeight = lineHeights[type] - 1;
        checkNewPage(lineHeight + 3, pageNum);
        yPosition += 1;

        pdf.setFontSize(fontSize);
        pdf.setTextColor(COLORS.heading.r, COLORS.heading.g, COLORS.heading.b);
        setFontForText(pdf, content, 'bold');

        const headingLines = pdf.splitTextToSize(content, maxWidth);
        for (const headingLine of headingLines) {
          checkNewPage(lineHeight, pageNum);
          pdf.text(headingLine, startX, yPosition);
          yPosition += lineHeight;
        }
        yPosition += 1;
        break;
      }

      case 'unorderedList': {
        const indent = (level || 0) * 4;
        checkNewPage(lineHeights.list, pageNum);
        pdf.setFillColor(COLORS.listMarker.r, COLORS.listMarker.g, COLORS.listMarker.b);
        const bulletX = startX + indent + 1.5;
        const bulletY = yPosition - 1.2;
        pdf.circle(bulletX, bulletY, 0.6, 'F');

        pdf.setFontSize(9);
        pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);
        setFontForText(pdf, content, 'normal');

        const listLines = pdf.splitTextToSize(content, maxWidth - indent - 5);
        for (let i = 0; i < listLines.length; i++) {
          checkNewPage(lineHeights.list, pageNum);
          pdf.text(listLines[i], startX + indent + 4, yPosition);
          if (i < listLines.length - 1) yPosition += lineHeights.list - 0.5;
        }
        yPosition += lineHeights.list - 0.5;
        break;
      }

      case 'orderedList': {
        const indent = (level || 0) * 4;
        checkNewPage(lineHeights.list, pageNum);
        pdf.setFontSize(9);
        pdf.setTextColor(COLORS.listMarker.r, COLORS.listMarker.g, COLORS.listMarker.b);
        pdf.setFont('helvetica', 'normal');
        const numberText = `${listNumber}.`;
        pdf.text(numberText, startX + indent, yPosition);

        pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);
        setFontForText(pdf, content, 'normal');

        const listLines = pdf.splitTextToSize(content, maxWidth - indent - 6);
        for (let i = 0; i < listLines.length; i++) {
          checkNewPage(lineHeights.list, pageNum);
          pdf.text(listLines[i], startX + indent + 5, yPosition);
          if (i < listLines.length - 1) yPosition += lineHeights.list - 0.5;
        }
        yPosition += lineHeights.list - 0.5;
        break;
      }

      case 'blockquote': {
        checkNewPage(lineHeights.blockquote + 2, pageNum);
        pdf.setDrawColor(180, 180, 180);
        pdf.setLineWidth(0.8);
        pdf.line(startX + 1, yPosition - 2.5, startX + 1, yPosition + 1);

        pdf.setFontSize(9);
        pdf.setTextColor(COLORS.blockquote.r, COLORS.blockquote.g, COLORS.blockquote.b);
        setFontForText(pdf, content, 'italic');

        const quoteLines = pdf.splitTextToSize(content, maxWidth - 6);
        for (const quoteLine of quoteLines) {
          checkNewPage(lineHeights.blockquote, pageNum);
          pdf.text(quoteLine, startX + 5, yPosition);
          yPosition += lineHeights.blockquote - 0.5;
        }
        break;
      }

      case 'paragraph':
      default: {
        checkNewPage(lineHeights.paragraph, pageNum);
        // Parse and render inline markdown (bold, italic, code, links, etc.)
        const segments = parseInlineMarkdown(content);
        // Enable page break for proper pagination
        renderStyledText(segments, startX, maxWidth, pageNum, 9, true);
        yPosition += lineHeights.paragraph - 0.5;
        break;
      }
    }
  };

  /**
   * Render attachments section - images are displayed inline, other files show as file info
   */
  const _renderAttachments = (attachments: ExportAttachment[], pageNum: { value: number }) => {
    for (const attachment of attachments) {
      const isImage = isImageExtension(attachment.file_extension);

      if (isImage && attachment.imageData) {
        // Render image inline
        renderImageAttachment(attachment, pageNum);
      } else {
        // Render file info for non-image attachments
        renderFileAttachment(attachment, pageNum);
      }
    }

    yPosition += 2; // Extra space after attachments
  };

  /**
   * Render an image attachment inline in the PDF
   */
  const renderImageAttachment = (attachment: ExportAttachment, pageNum: { value: number }) => {
    if (!attachment.imageData) return;

    try {
      // Calculate image dimensions to fit within content width
      // Max width is contentWidth, max height is 100mm
      const maxWidth = contentWidth;
      const maxHeight = 100;

      // Create a temporary image to get dimensions
      // We'll use a fixed aspect ratio estimation since we can't load the image synchronously
      // The imageData should be base64 encoded
      const imageFormat = getImageFormat(attachment.file_extension);

      // Add image to PDF
      // jsPDF addImage accepts base64 data
      const imgWidth = Math.min(maxWidth, 80); // Default width
      const imgHeight = Math.min(maxHeight, 60); // Default height, will be adjusted by jsPDF

      // Check if we need a new page
      checkNewPage(imgHeight + 10, pageNum);

      // Add the image
      pdf.addImage(
        attachment.imageData,
        imageFormat,
        margin,
        yPosition,
        imgWidth,
        imgHeight,
        undefined,
        'FAST'
      );

      yPosition += imgHeight + 3;

      // Add filename caption below image
      pdf.setFontSize(8);
      pdf.setTextColor(150, 150, 150);
      pdf.setFont('helvetica', 'normal');
      pdf.text(attachment.filename, margin, yPosition);
      yPosition += 5;
    } catch (error) {
      console.warn('Failed to render image attachment:', error);
      // Fallback to file info display
      renderFileAttachment(attachment, pageNum);
    }
  };

  /**
   * Get image format for jsPDF from file extension
   */
  const getImageFormat = (extension: string): string => {
    const ext = extension.toLowerCase().replace('.', '');
    switch (ext) {
      case 'jpg':
      case 'jpeg':
        return 'JPEG';
      case 'png':
        return 'PNG';
      case 'gif':
        return 'GIF';
      case 'webp':
        return 'WEBP';
      default:
        return 'JPEG';
    }
  };

  /**
   * Render a non-image file attachment as file info
   */
  const renderFileAttachment = (attachment: ExportAttachment, pageNum: { value: number }) => {
    const attachmentHeight = 8;
    const padding = 2;

    checkNewPage(attachmentHeight + padding, pageNum);

    // Draw attachment box background
    pdf.setFillColor(246, 248, 250); // Light gray background
    pdf.setDrawColor(220, 220, 220);
    pdf.roundedRect(margin, yPosition - 4, contentWidth, attachmentHeight, 1.5, 1.5, 'FD');

    // Draw file type label (using text instead of emoji for PDF compatibility)
    const fileTypeLabel = getFileTypeLabel(attachment.file_extension);
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(100, 100, 100);
    pdf.text(fileTypeLabel, margin + 3, yPosition);

    // Draw filename
    pdf.setFontSize(9);
    setFontForText(pdf, attachment.filename, 'normal');
    pdf.setTextColor(COLORS.text.r, COLORS.text.g, COLORS.text.b);
    const maxFilenameWidth = contentWidth - 50;
    let displayFilename = attachment.filename;
    if (pdf.getTextWidth(displayFilename) > maxFilenameWidth) {
      // Truncate filename if too long
      while (
        pdf.getTextWidth(displayFilename + '...') > maxFilenameWidth &&
        displayFilename.length > 0
      ) {
        displayFilename = displayFilename.slice(0, -1);
      }
      displayFilename += '...';
    }
    pdf.text(displayFilename, margin + 12, yPosition);

    // Draw file size
    pdf.setFontSize(8);
    pdf.setTextColor(150, 150, 150);
    pdf.setFont('helvetica', 'normal');
    const sizeText = formatFileSize(attachment.file_size);
    pdf.text(sizeText, pageWidth - margin - 3, yPosition, { align: 'right' });

    yPosition += attachmentHeight + padding;
  };

  // Generate PDF content
  const pageNum = { value: 1 };
  addHeader();

  for (const msg of messages) {
    renderMessage(msg, pageNum);
  }

  addFooter(pageNum.value);

  // Generate filename
  const sanitizedName = sanitizeFilename(taskName);
  const date = formatDateForFilename();
  const filename = `${sanitizedName}_${date}.pdf`;

  // Save PDF
  pdf.save(filename);
}

/**
 * Export type for the generator function
 */
export type { PdfExportOptions as ChatPdfExportOptions };
