/**
 * Code page 858 (PC850 with the euro sign at 0xD5), ESC/POS code page 19: the upper half, 0x80 to 0xFF.
 * It covers every French letter and the Western European ones; the Epson-compatible printers all have it.
 */
export const CP858_HIGH: readonly string[] = [
  ...'ÇüéâäàåçêëèïîìÄÅ',
  ...'ÉæÆôöòûùÿÖÜø£Ø×ƒ',
  ...'áíóúñÑªº¿®¬½¼¡«»',
  ...'░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐',
  ...'└┴┬├─┼ãÃ╚╔╩╦╠═╬¤',
  ...'ðÐÊËÈ€ÍÎÏ┘┌█▄¦Ì▀',
  ...'ÓßÔÒõÕµþÞÚÛÙýÝ¯´',
  ...'­±‗¾¶§÷¸°¨·¹³²■ '
]

const BYTE_OF = new Map<string, number>(CP858_HIGH.map((char, i) => [char, 0x80 + i]))

/** The ESC/POS `ESC t n` value of this code page. */
export const CP858_PAGE = 19

/**
 * Replacements for what the code page lacks, by code point: spaces of every width (the narrow no-break
 * space is the thousands separator `formatMoney` writes), typographic quotes and dashes, and two ligatures.
 */
const FOLD = new Map<number, string>([
  [0x202f, ' '],
  [0x2009, ' '],
  [0x2002, ' '],
  [0x2003, ' '],
  [0x0009, ' '],
  [0x2018, "'"],
  [0x2019, "'"],
  [0x201a, ','],
  [0x201c, '"'],
  [0x201d, '"'],
  [0x2013, '-'],
  [0x2014, '-'],
  [0x2212, '-'],
  [0x2026, '...'],
  [0x0153, 'oe'],
  [0x0152, 'OE']
])

/** The no-break space is in the table (0xFF) but is a blank on paper: an ordinary space keeps columns honest. */
const NO_BREAK_SPACE = 0x00a0

const printable = (code: number): boolean => code >= 0x20 && code < 0x7f

/**
 * The text as the printer can print it: every character of the result is one byte of CP858 (so its length
 * is its width on paper). Unknown letters lose their accent when that leaves ASCII, anything else becomes `?`.
 */
export function foldForPrinter(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (code === 0x0a) out += char
    else if (code === NO_BREAK_SPACE) out += ' '
    else if (printable(code) || BYTE_OF.has(char)) out += char
    else {
      const folded = FOLD.get(code)
      if (folded !== undefined) out += folded
      else {
        const base = char.normalize('NFD')[0]!
        out += printable(base.codePointAt(0)!) ? base : '?'
      }
    }
  }
  return out
}

/** CP858 bytes of `text`, folded first (see `foldForPrinter`). Newlines are kept as LF. */
export function encodeCp858(text: string): Buffer {
  const folded = foldForPrinter(text.replace(/\r\n?/g, '\n'))
  const bytes = new Uint8Array(folded.length)
  let n = 0
  for (const char of folded) {
    bytes[n++] = char === '\n' ? 0x0a : (BYTE_OF.get(char) ?? char.charCodeAt(0))
  }
  return Buffer.from(bytes.subarray(0, n))
}
