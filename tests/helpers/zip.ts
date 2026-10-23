import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  data: Buffer
  /** 8 (deflate, the default) or 0 (stored). */
  method?: 0 | 8
  /** How many times the central directory lists this file (it is stored once): overlapping entries. */
  listedTimes?: number
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

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    body.push(local, name, stored)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(stored.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    for (let i = 0; i < (entry.listedTimes ?? 1); i++) directory.push(central, name)
    offset += local.length + name.length + stored.length
  }
  const directoryBuffer = Buffer.concat(directory)
  const listed = directory.length / 2
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(listed, 8)
  end.writeUInt16LE(listed, 10)
  end.writeUInt32LE(directoryBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...body, directoryBuffer, end])
}
