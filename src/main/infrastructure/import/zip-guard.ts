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
const LOCAL_ENTRY = 0x04034b50
const DATA_DESCRIPTOR_FLAG = 0x0008
const ENCRYPTION_FLAGS = 0x2041
const ZIP64_EXTRA = 0x0001

interface Entry {
  method: number
  /** Where the file's data starts, and its compressed size by the local header (what SheetJS slices). */
  data: number
  compressed: number
  /** The uncompressed size the central directory and the local header declare. */
  central: number
  local: number
  /** The local header leaves its sizes to a data descriptor after the data. */
  descriptor: boolean
}

/**
 * Throws when the extra fields of a header contain a zip64 record. Walks the block the way SheetJS
 * does (the same records, the same end), since a record SheetJS can reach and this cannot would be
 * trusted by one and not the other.
 */
function assertNoZip64(zip: Buffer, start: number, length: number): void {
  const end = start + length
  if (end > zip.length) throw new Error('extra field past the end')
  for (let at = start; at <= end - 4; at += 4 + zip.readUInt16LE(at + 2)) {
    if (zip.readUInt16LE(at) === ZIP64_EXTRA) throw new Error('zip64 is not accepted')
  }
}

/**
 * Checks what a zip archive really expands to before SheetJS reads it: a 5 MB `.xlsx` can hold
 * gigabytes of XML. SheetJS goes by the sizes the archive *declares* (its pure-JS inflate allocates the
 * local header's uncompressed size up front, whatever the data is), so those are not trusted but
 * checked against the data. Per file:
 * - a declared size (local header or central directory) over `maxBytes` is `ZipTooLargeError`, before
 *   anything is inflated;
 * - the file is inflated once, into nothing, with `maxOutputLength`; files together over `maxBytes`
 *   (or one over it) is `ZipTooLargeError`;
 * - both declared sizes must equal the real size (a local size of 0 is left to the data descriptor
 *   when the file has one: the central directory is then the declaration);
 * - a zip64 extra field is refused: its sizes would override these, and a catalogue never needs zip64.
 * Any other problem (malformed archive, encryption, a method SheetJS cannot read) is a plain `Error`.
 *
 * It walks the archive the way SheetJS does, so that both see the same files: the last end-of-
 * directory signature, the entry count of that record, each entry's local header, and the data from
 * there to the end of its deflate stream.
 */
export function assertZipWithinLimits(buf: Uint8Array, maxBytes = MAX_UNZIPPED_BYTES): void {
  const zip = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  let eocd = zip.length - 4
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== EOCD) eocd--
  if (eocd < 0) throw new Error('no end of central directory')

  const entries: Entry[] = []
  const count = zip.readUInt16LE(eocd + 8)
  let cursor = zip.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_ENTRY) throw new Error('bad central directory entry')
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const central = zip.readUInt32LE(cursor + 24)
    const at = zip.readUInt32LE(cursor + 42)
    assertNoZip64(zip, cursor + 46 + nameLength, extraLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (zip.readUInt32LE(at) !== LOCAL_ENTRY) throw new Error('bad local file header')
    const flags = zip.readUInt16LE(at + 6)
    if (flags & ENCRYPTION_FLAGS) throw new Error('encrypted entry')
    const localNameLength = zip.readUInt16LE(at + 26)
    const localExtraLength = zip.readUInt16LE(at + 28)
    assertNoZip64(zip, at + 30 + localNameLength, localExtraLength)
    const data = at + 30 + localNameLength + localExtraLength
    if (data > zip.length) throw new Error('entry starts past the end')

    const local = zip.readUInt32LE(at + 22)
    if (central > maxBytes || local > maxBytes) throw new ZipTooLargeError()
    entries.push({
      method: zip.readUInt16LE(at + 8),
      data,
      compressed: zip.readUInt32LE(at + 18),
      central,
      local,
      descriptor: (flags & DATA_DESCRIPTOR_FLAG) !== 0
    })
  }

  let total = 0
  for (const entry of entries) {
    let size: number
    if (entry.method === 0) {
      if (entry.data + entry.compressed > zip.length) throw new Error('stored entry past the end')
      size = entry.compressed
    } else if (entry.method === 8) {
      try {
        size = inflateRawSync(zip.subarray(entry.data), { maxOutputLength: Math.max(1, maxBytes - total) }).length
      } catch (error) {
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new ZipTooLargeError()
        throw error
      }
    } else throw new Error(`unsupported compression method ${entry.method}`)

    if (entry.central !== size) throw new Error('declared size differs from the real one')
    if (!(entry.descriptor && entry.local === 0) && entry.local !== size) {
      throw new Error('declared size differs from the real one')
    }
    total += size
    if (total > maxBytes) throw new ZipTooLargeError()
  }
}
