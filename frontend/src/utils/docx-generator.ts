// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  ImageRun,
  ExternalHyperlink,
  Packer,
  VerticalAlign,
} from 'docx';
import { saveAs } from 'file-saver';

/**
 * Attachment info for DOCX export (reuse from PDF generator)
 */
export interface ExportAttachment {
  id: number;
  filename: string;
  file_size: number;
  file_extension: string;
  /** Base64 encoded image data (for images only, loaded before DOCX generation) */
  imageData?: string;
}

/**
 * Message structure for DOCX export (reuse from PDF generator)
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
 * DOCX export options
 */
export interface DocxExportOptions {
  taskName: string;
  messages: ExportMessage[];
}

/**
 * Primary color for Wegent brand (hex format for docx)
 */
const PRIMARY_COLOR = '14B8A6'; // #14B8A6 (mint blue)
const TEXT_COLOR = '24292E'; // Dark gray
const CODE_BG_COLOR = 'F6F8FA'; // Light gray
const LINK_COLOR = '55B9F7'; // Blue
const BLOCKQUOTE_COLOR = '6A737D'; // Gray

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
 * Line type detection
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
  level?: number;
  listNumber?: number;
  tableCells?: string[];
  tableAlignments?: ('left' | 'center' | 'right')[];
}

/**
 * Parse table row cells
 */
function parseTableCells(line: string): string[] {
  const trimmed = line.trim();
  const withoutPipes = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutEndPipe = withoutPipes.endsWith('|') ? withoutPipes.slice(0, -1) : withoutPipes;
  return withoutEndPipe.split('|').map(cell => cell.trim());
}

/**
 * Check if a line is a table separator
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?[\s]*:?-+:?[\s]*(\|[\s]*:?-+:?[\s]*)+\|?$/.test(trimmed);
}

/**
 * Check if a line looks like a table row
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
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

  // Table separator
  if (isTableSeparator(trimmed)) {
    return {
      type: 'tableSeparator',
      content: trimmed,
      tableAlignments: parseTableAlignments(trimmed),
    };
  }

  // Table row
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
 * Convert text segments to TextRun array for docx
 */
function segmentsToTextRuns(segments: TextSegment[]): (TextRun | ExternalHyperlink)[] {
  return segments.map(segment => {
    if (segment.link) {
      return new ExternalHyperlink({
        children: [
          new TextRun({
            text: segment.text,
            color: LINK_COLOR,
            underline: {},
          }),
        ],
        link: segment.link,
      });
    }

    return new TextRun({
      text: segment.text,
      bold: segment.bold,
      italics: segment.italic,
      strike: segment.strikethrough,
      font: segment.code ? 'Courier New' : 'Calibri',
      color: segment.code ? 'CF222E' : TEXT_COLOR,
      shading: segment.code
        ? {
            type: 'solid',
            color: CODE_BG_COLOR,
          }
        : undefined,
    });
  });
}

/**
 * Generate DOCX document from messages
 */
export async function generateChatDocx(options: DocxExportOptions): Promise<void> {
  const { taskName, messages } = options;

  if (messages.length === 0) {
    throw new Error('No messages to export');
  }

  const children: (Paragraph | Table)[] = [];

  // Add header
  children.push(
    new Paragraph({
      text: 'Wegent AI',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      style: 'Heading1',
    })
  );

  children.push(
    new Paragraph({
      text: taskName,
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      style: 'Heading1',
    })
  );

  // Add separator
  children.push(
    new Paragraph({
      border: {
        bottom: {
          color: PRIMARY_COLOR,
          space: 1,
          style: BorderStyle.SINGLE,
          size: 6,
        },
      },
      spacing: { after: 400 },
    })
  );

  // Process each message
  for (const msg of messages) {
    const label =
      msg.type === 'user' ? msg.userName || 'User' : msg.teamName || msg.botName || 'AI';
    const timestamp = formatTimestamp(msg.timestamp);

    // Message header (sender + timestamp)
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `${label}:`,
            bold: true,
            color: msg.type === 'user' ? '3C3C3C' : PRIMARY_COLOR,
            size: 22,
          }),
          new TextRun({
            text: `    ${timestamp}`,
            color: 'A0A0A0',
            size: 18,
          }),
        ],
        spacing: { before: 200, after: 100 },
      })
    );

    // Render attachments if present
    if (msg.attachments && msg.attachments.length > 0) {
      for (const attachment of msg.attachments) {
        const isImage = isImageExtension(attachment.file_extension);

        if (isImage && attachment.imageData) {
          // Render image inline
          try {
            const imageBuffer = base64ToArrayBuffer(attachment.imageData);
            const imageExtension = attachment.file_extension.toLowerCase().replace('.', '');

            children.push(
              new Paragraph({
                children: [
                  new ImageRun({
                    data: imageBuffer,
                    transformation: {
                      width: 400,
                      height: 300,
                    },
                    type: imageExtension === 'png' ? 'png' : 'jpg',
                  }),
                ],
                spacing: { after: 100 },
              })
            );

            // Add filename caption
            children.push(
              new Paragraph({
                text: attachment.filename,
                style: 'Normal',
                spacing: { after: 200 },
                run: {
                  size: 16,
                  color: '969696',
                  italics: true,
                },
              })
            );
          } catch (error) {
            console.warn('Failed to embed image:', error);
            // Fallback to file info
            children.push(createFileAttachmentParagraph(attachment));
          }
        } else {
          // Render file info for non-image attachments
          children.push(createFileAttachmentParagraph(attachment));
        }
      }
    }

    // Process message content
    let content = msg.content;

    // Remove special markers
    content = content.replace(/\$\{\$\$\}\$/g, '\n');
    content = content.replace(/__PROGRESS_BAR__:.*?:\d+/g, '');
    content = content.replace(/__PROMPT_TRUNCATED__:.*?::(.*?)(?=\n|$)/g, '$1');

    const lines = content.split('\n');
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];
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
          children.push(createTable(tableHeaders, tableAlignments, tableRows));
          inTable = false;
          tableHeaders = [];
          tableAlignments = [];
          tableRows = [];
        }

        if (!inCodeBlock) {
          // Start of code block
          inCodeBlock = true;
          codeLanguage = extractCodeLanguage(line);
          codeBlockContent = [];
        } else {
          // End of code block
          inCodeBlock = false;
          if (codeBlockContent.length > 0) {
            children.push(createCodeBlock(codeBlockContent.join('\n'), codeLanguage));
          }
          codeBlockContent = [];
          codeLanguage = '';
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent.push(line);
      } else {
        // Parse and render markdown line
        const parsedLine = parseLineType(line, { inTable });

        // Handle table parsing
        if (parsedLine.type === 'tableRow' || parsedLine.type === 'tableSeparator') {
          if (parsedLine.type === 'tableSeparator') {
            // This is the separator line
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
            if (!inTable) {
              // This might be a header row, wait for separator
            } else {
              // This is a data row
              tableRows.push(parsedLine.tableCells);
            }
          }
        } else {
          // Not a table line, flush any pending table
          if (inTable && tableHeaders.length > 0) {
            children.push(createTable(tableHeaders, tableAlignments, tableRows));
            inTable = false;
            tableHeaders = [];
            tableAlignments = [];
            tableRows = [];
          }
          children.push(...renderMarkdownLine(parsedLine));
        }
      }
    }

    // Flush any remaining table at end of content
    if (inTable && tableHeaders.length > 0) {
      children.push(createTable(tableHeaders, tableAlignments, tableRows));
    }

    // Handle unclosed code block
    if (inCodeBlock && codeBlockContent.length > 0) {
      children.push(createCodeBlock(codeBlockContent.join('\n'), codeLanguage));
    }

    // Add spacing after message
    children.push(
      new Paragraph({
        spacing: { after: 300 },
      })
    );
  }

  // Add footer
  children.push(
    new Paragraph({
      text: 'Exported from Wegent',
      alignment: AlignmentType.CENTER,
      spacing: { before: 400 },
      style: 'Normal',
      run: {
        size: 16,
        color: 'A0A0A0',
      },
    })
  );

  // Create document
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440, // 1 inch = 1440 twips
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children,
      },
    ],
  });

  // Generate and save file
  const blob = await Packer.toBlob(doc);
  const sanitizedName = sanitizeFilename(taskName);
  const date = formatDateForFilename();
  const filename = `${sanitizedName}_${date}.docx`;

  saveAs(blob, filename);
}

/**
 * Convert base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Create file attachment paragraph
 */
function createFileAttachmentParagraph(attachment: ExportAttachment): Paragraph {
  const fileTypeLabel = getFileTypeLabel(attachment.file_extension);
  const sizeText = formatFileSize(attachment.file_size);

  return new Paragraph({
    children: [
      new TextRun({
        text: `${fileTypeLabel} `,
        bold: true,
        color: '646464',
        size: 16,
      }),
      new TextRun({
        text: attachment.filename,
        color: TEXT_COLOR,
        size: 18,
      }),
      new TextRun({
        text: ` (${sizeText})`,
        color: '969696',
        size: 16,
      }),
    ],
    shading: {
      type: 'solid',
      color: CODE_BG_COLOR,
    },
    spacing: { after: 200 },
    indent: { left: 200 },
  });
}

/**
 * Create code block paragraph
 */
function createCodeBlock(code: string, language: string): Paragraph {
  const children: TextRun[] = [];

  if (language) {
    children.push(
      new TextRun({
        text: `[${language}]`,
        color: '969696',
        size: 16,
        italics: true,
      }),
      new TextRun({
        text: '\n',
      })
    );
  }

  children.push(
    new TextRun({
      text: code,
      font: 'Courier New',
      size: 18,
      color: TEXT_COLOR,
    })
  );

  return new Paragraph({
    children,
    shading: {
      type: 'solid',
      color: CODE_BG_COLOR,
    },
    spacing: { before: 200, after: 200 },
    indent: { left: 200, right: 200 },
  });
}

/**
 * Create table
 */
function createTable(
  headers: string[],
  alignments: ('left' | 'center' | 'right')[],
  rows: string[][]
): Table {
  const tableRows: TableRow[] = [];

  // Add header row
  const headerCells = headers.map((header, index) => {
    const alignment = alignments[index] || 'left';
    const segments = parseInlineMarkdown(header);

    return new TableCell({
      children: [
        new Paragraph({
          children: segmentsToTextRuns(segments) as TextRun[],
          alignment:
            alignment === 'center'
              ? AlignmentType.CENTER
              : alignment === 'right'
                ? AlignmentType.RIGHT
                : AlignmentType.LEFT,
        }),
      ],
      shading: {
        type: 'solid',
        color: CODE_BG_COLOR,
      },
      verticalAlign: VerticalAlign.CENTER,
    });
  });

  tableRows.push(new TableRow({ children: headerCells, tableHeader: true }));

  // Add data rows
  rows.forEach((row, rowIndex) => {
    const cells = row.map((cell, cellIndex) => {
      const alignment = alignments[cellIndex] || 'left';
      const segments = parseInlineMarkdown(cell);

      return new TableCell({
        children: [
          new Paragraph({
            children: segmentsToTextRuns(segments) as TextRun[],
            alignment:
              alignment === 'center'
                ? AlignmentType.CENTER
                : alignment === 'right'
                  ? AlignmentType.RIGHT
                  : AlignmentType.LEFT,
          }),
        ],
        shading:
          rowIndex % 2 === 1
            ? {
                type: 'solid',
                color: 'FAFAFA',
              }
            : undefined,
        verticalAlign: VerticalAlign.CENTER,
      });
    });

    tableRows.push(new TableRow({ children: cells }));
  });

  return new Table({
    rows: tableRows,
    width: {
      size: 100,
      type: WidthType.PERCENTAGE,
    },
    margins: {
      top: 100,
      bottom: 100,
      left: 100,
      right: 100,
    },
  });
}

/**
 * Render markdown line as paragraph(s)
 */
function renderMarkdownLine(parsedLine: ParsedLine): Paragraph[] {
  const { type, content, level } = parsedLine;

  switch (type) {
    case 'empty':
      return [
        new Paragraph({
          spacing: { after: 100 },
        }),
      ];

    case 'horizontalRule':
      return [
        new Paragraph({
          border: {
            bottom: {
              color: 'C8C8C8',
              space: 1,
              style: BorderStyle.SINGLE,
              size: 6,
            },
          },
          spacing: { before: 200, after: 200 },
        }),
      ];

    case 'heading1':
      return [
        new Paragraph({
          text: content,
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 200, after: 200 },
          border: {
            bottom: {
              color: 'DCDCDC',
              space: 1,
              style: BorderStyle.SINGLE,
              size: 6,
            },
          },
        }),
      ];

    case 'heading2':
      return [
        new Paragraph({
          text: content,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 150 },
          border: {
            bottom: {
              color: 'E8E8E8',
              space: 1,
              style: BorderStyle.SINGLE,
              size: 3,
            },
          },
        }),
      ];

    case 'heading3':
      return [
        new Paragraph({
          text: content,
          heading: HeadingLevel.HEADING_3,
          spacing: { before: 150, after: 100 },
        }),
      ];

    case 'heading4':
    case 'heading5':
    case 'heading6': {
      const headingLevel =
        type === 'heading4'
          ? HeadingLevel.HEADING_4
          : type === 'heading5'
            ? HeadingLevel.HEADING_5
            : HeadingLevel.HEADING_6;
      return [
        new Paragraph({
          text: content,
          heading: headingLevel,
          spacing: { before: 100, after: 100 },
        }),
      ];
    }

    case 'unorderedList': {
      const segments = parseInlineMarkdown(content);
      return [
        new Paragraph({
          children: segmentsToTextRuns(segments) as TextRun[],
          bullet: {
            level: level || 0,
          },
          spacing: { after: 100 },
        }),
      ];
    }

    case 'orderedList': {
      const segments = parseInlineMarkdown(content);
      return [
        new Paragraph({
          children: segmentsToTextRuns(segments) as TextRun[],
          numbering: {
            reference: 'default-numbering',
            level: level || 0,
          },
          spacing: { after: 100 },
        }),
      ];
    }

    case 'blockquote': {
      const segments = parseInlineMarkdown(content);
      return [
        new Paragraph({
          children: segmentsToTextRuns(segments).map(run => {
            if (run instanceof TextRun) {
              return new TextRun({
                ...run,
                italics: true,
                color: BLOCKQUOTE_COLOR,
              });
            }
            return run;
          }) as TextRun[],
          border: {
            left: {
              color: 'C8C8C8',
              space: 1,
              style: BorderStyle.SINGLE,
              size: 12,
            },
          },
          indent: { left: 400 },
          spacing: { after: 200 },
        }),
      ];
    }

    case 'paragraph':
    default: {
      const segments = parseInlineMarkdown(content);
      return [
        new Paragraph({
          children: segmentsToTextRuns(segments) as TextRun[],
          spacing: { after: 200 },
        }),
      ];
    }
  }
}
