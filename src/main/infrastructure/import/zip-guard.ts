import { inflateRawSync } from 'node:zlib'

/** Total bytes a workbook may expand to, and the most any one of its files may. */
export const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024

/** The archive is within its compressed size but would expand past `MAX_UNZIPPED_BYTES`. */
export class ZipTooLargeError extends Error {
  constructor() {
    super('zip expands beyond the limit')
    this.name = 'ZipTooLargeError'
  }
}

const EOCD = 0x06054b50
const CENTRAL_ENTRY = 0x02014b50

/**
 * Inflates every file of a zip archive once, into nothing, to learn how large the archive really is
 * before SheetJS inflates it for good: a 5 MB `.xlsx` can hold gigabytes of XML. The sizes a zip
 * declares are never trusted. Throws `ZipTooLargeError` when the files together (or one of them)
 * expand past `maxBytes`, and a plain `Error` when the archive is malformed or uses a feature
 * SheetJS cannot read.
 *
 * It walks the archive the way SheetJS does, so that both see the same files: the last end-of-
 * directory signature, the entry count of that record, each entry's local header, and the data from
 * there to the end of its deflate stream (the sizes in the local header are what SheetJS goes by).
 */
export function assertZipWithinLimits(buf: Uint8Array, maxBytes = MAX_UNZIPPED_BYTES): void {
  const zip = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = zip.length - 4
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== EOCD) eocd--
  if (eocd < 0) throw new Error('no end of central directory')

  const entries = zip.readUInt16LE(eocd + 8)
  let cursor = zip.readUInt32LE(eocd + 16)
  let total = 0
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_ENTRY) throw new Error('bad central directory entry')
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const local = zip.readUInt32LE(cursor + 42)
    cursor += 46 + nameLength + extraLength + commentLength

    const flags = zip.readUInt16LE(local + 6)
    if (flags & 0x2041) throw new Error('encrypted entry')
    const method = zip.readUInt16LE(local + 8)
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    if (data > zip.length) throw new Error('entry starts past the end')

    let size: number
    if (method === 0) size = Math.min(zip.readUInt32LE(local + 18), zip.length - data)
    else if (method === 8) {
      try {
        size = inflateRawSync(zip.subarray(data), { maxOutputLength: Math.max(1, maxBytes - total) }).length
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipTooLargeError()
        throw error
      }
    } else throw new Error(`unsupported compression method ${method}`)
    total += size
    if (total > maxBytes) throw new ZipTooLargeError()
  }
}
