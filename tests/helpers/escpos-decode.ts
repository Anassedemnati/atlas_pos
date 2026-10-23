import { CP858_HIGH } from '../../src/main/infrastructure/printing/cp858'

/**
 * The text of an ESC/POS job as it would read on paper: printable bytes decoded from CP858, LF kept,
 * every command (`ESC @`, `ESC t n`, `GS ! n`, `GS V`, `GS v 0` blocks, ...) dropped.
 */
export function paperText(buf: Buffer): string {
  let out = ''
  for (let i = 0; i < buf.length; ) {
    const b = buf[i]!
    if (b === 0x1b) {
      // ESC p m t1 t2 is the only 5-byte one we use; ESC @ is 2; the others take one parameter byte.
      i += buf[i + 1] === 0x40 ? 2 : buf[i + 1] === 0x70 ? 5 : 3
    } else if (b === 0x1d) {
      if (buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
        const bytesPerRow = buf[i + 4]! | (buf[i + 5]! << 8)
        const rows = buf[i + 6]! | (buf[i + 7]! << 8)
        i += 8 + bytesPerRow * rows
      } else if (buf[i + 1] === 0x56) i += buf[i + 2] === 0x42 ? 4 : 3
      else i += 3
    } else {
      out += b === 0x0a ? '\n' : b < 0x80 ? String.fromCharCode(b) : CP858_HIGH[b - 0x80]
      i += 1
    }
  }
  return out
}

/** The lines of `paperText`, in order. */
export const paperLines = (buf: Buffer): string[] => paperText(buf).split('\n')
