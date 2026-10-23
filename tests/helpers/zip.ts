import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer
  /** 8 (deflate, the default) or 0 (stored). */
  method?: 0 | 8
  /** How many times the central directory lists this file (it is stored once): overlapping entries. */
  listedTimes?: number
  /** Sizes and CRC left to a data descriptor after the data (flag 8), as Excel writes them: the local header says 0. */
  dataDescriptor?: boolean
  /** Extra field bytes of the local header / of the central directory entry. */
  localExtra?: Buffer
  centralExtra?: Buffer
}

/** A zip64 extended information extra field (id 1) declaring these sizes. */
export function zip64Extra(uncompressed: number, compressed: number): Buffer {
  const extra = Buffer.alloc(20)
  extra.writeUInt16LE(1, 0)
  extra.writeUInt16LE(16, 2)
  extra.writeBigUInt64LE(BigInt(uncompressed), 4)
  extra.writeBigUInt64LE(BigInt(compressed), 12)
  return extra
}

/** A zip archive built by hand: the sizes it declares are the real ones. */
export function zipOf(entries: ZipEntry[]): Buffer {
  const body: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 8
    const stored = method === 8 ? deflateRawSync(entry.data) : entry.data
    const name = Buffer.from(entry.name)
    const crc = crc32(entry.data)

    const flags = entry.dataDescriptor ? 8 : 0
    const localExtra = entry.localExtra ?? Buffer.alloc(0)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    if (!entry.dataDescriptor) {
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(stored.length, 18)
      local.writeUInt32LE(entry.data.length, 22)
    }
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(localExtra.length, 28)
    body.push(local, name, localExtra, stored)
    let size = local.length + name.length + localExtra.length + stored.length
    if (entry.dataDescriptor) {
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(stored.length, 8)
      descriptor.writeUInt32LE(entry.data.length, 12)
      body.push(descriptor)
      size += descriptor.length
    }

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0)
    central.writeUInt16LE(centralExtra.length, 30)
    central.writeUInt32LE(offset, 42)
    for (let i = 0; i < (entry.listedTimes ?? 1); i++) directory.push(central, name, centralExtra)
    offset += size
  }
  const directoryBuffer = Buffer.concat(directory)
  const listed = entries.reduce((n, entry) => n + (entry.listedTimes ?? 1), 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(listed, 8)
  end.writeUInt16LE(listed, 10)
  end.writeUInt32LE(directoryBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...body, directoryBuffer, end])
}

/**
 * A copy of `zip` whose entry number `index` declares other uncompressed sizes: in its local header
 * and/or in the central directory. What SheetJS goes by, and what a zip bomb lies about.
 */
export function declareSizes(zip: Buffer, index: number, sizes: { local?: number; central?: number }): Buffer {
  const copy = Buffer.from(zip)
  let eocd = copy.length - 4
  while (copy.readUInt32LE(eocd) !== 0x06054b50) eocd--
  let cursor = copy.readUInt32LE(eocd + 16)
  for (let i = 0; i <= index; i++) {
    if (i === index) {
      if (sizes.central !== undefined) copy.writeUInt32LE(sizes.central, cursor + 24)
      if (sizes.local !== undefined) copy.writeUInt32LE(sizes.local, copy.readUInt32LE(cursor + 42) + 22)
    }
    cursor += 46 + copy.readUInt16LE(cursor + 28) + copy.readUInt16LE(cursor + 30) + copy.readUInt16LE(cursor + 32)
  }
  return copy
}

/** The uncompressed size entry number `index` declares in its local header and in the central directory. */
export function declaredSizes(zip: Buffer, index: number): { local: number; central: number } {
  let eocd = zip.length - 4
  while (zip.readUInt32LE(eocd) !== 0x06054b50) eocd--
  let cursor = zip.readUInt32LE(eocd + 16)
  for (let i = 0; i < index; i++) {
    cursor += 46 + zip.readUInt16LE(cursor + 28) + zip.readUInt16LE(cursor + 30) + zip.readUInt16LE(cursor + 32)
  }
  return { local: zip.readUInt32LE(zip.readUInt32LE(cursor + 42) + 22), central: zip.readUInt32LE(cursor + 24) }
}
