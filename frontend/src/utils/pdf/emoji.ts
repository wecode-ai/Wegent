// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * PDF Emoji Handling Module
 * Handles emoji to text conversion for PDF compatibility
 */

/**
 * Common emoji to text mapping for PDF export
 * Maps frequently used emojis to their text equivalents
 */
export const EMOJI_TO_TEXT_MAP: Record<string, string> = {
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
}

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
export const EMOJI_REGEX =
  /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2300}-\u{23FF}]|[\u{2B50}-\u{2B55}]|[\u{200D}]|[\u{FE0F}]|[\u{20E3}]|[\u{E0020}-\u{E007F}]|[\u{1FA00}-\u{1FAFF}]|[\u{1F900}-\u{1F9FF}]/gu

/**
 * Remove or replace emoji characters in text for PDF compatibility
 * Emojis are replaced with text equivalents where available, otherwise removed
 *
 * @param text - Input text that may contain emojis
 * @returns Text with emojis replaced or removed
 */
export function sanitizeEmojisForPdf(text: string): string {
  if (!text) return text

  let result = text

  // First, replace known emojis with their text equivalents
  for (const [emoji, replacement] of Object.entries(EMOJI_TO_TEXT_MAP)) {
    result = result.split(emoji).join(replacement)
  }

  // Then remove any remaining emojis that weren't in our map
  result = result.replace(EMOJI_REGEX, '')

  // Clean up any double spaces that might have been created
  result = result.replace(/  +/g, ' ')

  return result
}
