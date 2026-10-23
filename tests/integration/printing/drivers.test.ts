import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeviceFileDriver } from '../../../src/main/infrastructure/printing/drivers/device-file'
import { createNetworkDriver } from '../../../src/main/infrastructure/printing/drivers/network'
import { createVirtualDriver, slugOf } from '../../../src/main/infrastructure/printing/drivers/virtual'
import { EscPos } from '../../../src/main/infrastructure/printing/escpos'
import { toMonochrome } from '../../../src/main/infrastructure/printing/raster'
import { PermanentPrintError } from '../../../src/main/infrastructure/printing/types'
import { manualClock } from '../../helpers/backup'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-drivers-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('network driver', () => {
  let server: Server | undefined
  let received: Buffer[]
  let sockets: Socket[]

  const listen = async (onConnection?: (socket: Socket) => void): Promise<number> => {
    received = []
    sockets = []
    server = createServer((socket) => {
      sockets.push(socket)
      onConnection?.(socket)
      socket.on('data', (chunk) => received.push(chunk))
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return (server.address() as { port: number }).port
  }

  afterEach(async () => {
    for (const socket of sockets ?? []) socket.destroy()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  it('sends the exact bytes to host:port', async () => {
    const port = await listen()
    const job = new EscPos().init().codepage().text('Tajine poulet').drawerPulse().cut().build()
    const driver = createNetworkDriver(`127.0.0.1:${port}`)
    await driver.send(job)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(driver.kind).toBe('network')
    expect(Buffer.concat(received)).toEqual(job)
  })

  it('sends a large raster job intact', async () => {
    const port = await listen()
    const job = Buffer.alloc(600_000, 0xa5)
    await createNetworkDriver(`127.0.0.1:${port}`).send(job)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(Buffer.concat(received).equals(job)).toBe(true)
  })

  it('rejects with the system error when nothing listens', async () => {
    const port = await listen()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    for (const s of sockets) s.destroy()
    await expect(createNetworkDriver(`127.0.0.1:${port}`).send(Buffer.from('x'))).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('gives up after the timeout when the printer does not take the data', async () => {
    const port = await listen((socket) => socket.pause())
    const started = Date.now()
    await expect(createNetworkDriver(`127.0.0.1:${port}`, { timeoutMs: 150 }).send(Buffer.alloc(16 * 1024 * 1024))).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('only gives up when nothing moves: a long job that keeps flowing on a slow printer is not cut off', async () => {
    // The printer takes 64 KB every 20 ms (about 3 MB/s, the network stack hides up to a couple of MB): the job needs
    // longer than the 1 s limit, but nothing stands still for a second.
    const port = await listen((socket) => {
      socket.on('data', () => {
        socket.pause()
        setTimeout(() => socket.resume(), 20)
      })
    })
    const job = Buffer.alloc(8 * 1024 * 1024, 0x5a)
    const started = Date.now()
    await createNetworkDriver(`127.0.0.1:${port}`, { timeoutMs: 1000 }).send(job)
    expect(Date.now() - started).toBeGreaterThan(1000)
  })

  it('refuses an HTML job for good', async () => {
    await expect(createNetworkDriver('127.0.0.1:9100').send({ html: 'x' })).rejects.toBeInstanceOf(PermanentPrintError)
  })

  it('has a 5 second timeout by default', async () => {
    const { DEFAULT_NETWORK_TIMEOUT_MS } = await import('../../../src/main/infrastructure/printing/drivers/network')
    expect(DEFAULT_NETWORK_TIMEOUT_MS).toBe(5000)
  })
})

describe('device-file driver', () => {
  it('appends to the device file', async () => {
    const file = join(dir, 'lp0')
    writeFileSync(file, 'before:')
    const driver = createDeviceFileDriver(file)
    await driver.send(Buffer.from('1b4041', 'hex'))
    await driver.send(Buffer.from('0a', 'hex'))
    expect(driver.kind).toBe('device-file')
    expect(readFileSync(file).toString('hex')).toBe(Buffer.concat([Buffer.from('before:'), Buffer.from('1b40410a', 'hex')]).toString('hex'))
  })

  it('rejects with the system error when the device is missing', async () => {
    await expect(createDeviceFileDriver(join(dir, 'no', 'such', 'lp0')).send(Buffer.from('x'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an HTML job for good', async () => {
    await expect(createDeviceFileDriver(join(dir, 'lp0')).send({ html: 'x' })).rejects.toBeInstanceOf(PermanentPrintError)
  })
})

describe('virtual driver', () => {
  const make = (over: Partial<Parameters<typeof createVirtualDriver>[0]> = {}) => {
    const clock = manualClock('2026-10-22T10:15:30.123Z')
    const driver = createVirtualDriver({ dir: join(dir, 'prints'), printerName: 'Caisse', clock, ...over })
    return { clock, driver }
  }
  const files = (): string[] => readdirSync(join(dir, 'prints')).sort()

  it('writes the bytes to prints/<timestamp>-<printer>.bin', async () => {
    const { driver } = make()
    const job = new EscPos().init().text('Hello').cut().build()
    await driver.send(job)
    expect(driver.kind).toBe('virtual')
    expect(files()).toEqual(['2026-10-22T10-15-30.123Z-caisse.bin'])
    expect(readFileSync(join(dir, 'prints', files()[0]!))).toEqual(job)
  })

  it('writes a PNG preview when the job holds a raster image', async () => {
    const { driver } = make()
    const rgba = new Uint8Array(16 * 4 * 4)
    for (let i = 0; i < rgba.length; i += 4) rgba.set(i % 8 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255], i)
    const job = new EscPos().init().raster(toMonochrome(rgba, 16, 4)).cut().build()
    await driver.send(job)
    expect(files()).toEqual(['2026-10-22T10-15-30.123Z-caisse.bin', '2026-10-22T10-15-30.123Z-caisse.png'])
    const png = readFileSync(join(dir, 'prints', files()[1]!))
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(16)
    expect(png.readUInt32BE(20)).toBe(4)
  })

  it('writes no PNG for a text job', async () => {
    const { driver } = make()
    await driver.send(new EscPos().init().text('Hello').build())
    expect(files().filter((f) => f.endsWith('.png'))).toEqual([])
  })

  it('keeps the HTML of a document job, and a PNG of it when it can render one', async () => {
    const withRenderer = make({ renderHtml: async () => ({ width: 8, height: 2, data: Uint8Array.from([0xff, 0x00]) }) })
    await withRenderer.driver.send({ html: '<p>Facture</p>' })
    expect(files()).toEqual(['2026-10-22T10-15-30.123Z-caisse.html', '2026-10-22T10-15-30.123Z-caisse.png'])
    expect(readFileSync(join(dir, 'prints', files()[0]!), 'utf8')).toBe('<p>Facture</p>')
    const png = readFileSync(join(dir, 'prints', files()[1]!))
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([8, 2])
  })

  it('writes only the HTML when it has no way to render it', async () => {
    const { driver } = make()
    await driver.send({ html: '<p>x</p>' })
    expect(files()).toEqual(['2026-10-22T10-15-30.123Z-caisse.html'])
  })

  it('never overwrites: jobs in the same millisecond get the next free timestamp, so names sort in print order', async () => {
    const { driver } = make()
    await driver.send(Buffer.from('a'))
    await driver.send(Buffer.from('b'))
    await driver.send(Buffer.from('c'))
    expect(files()).toEqual(['2026-10-22T10-15-30.123Z-caisse.bin', '2026-10-22T10-15-30.124Z-caisse.bin', '2026-10-22T10-15-30.125Z-caisse.bin'])
    expect(files().map((f) => readFileSync(join(dir, 'prints', f), 'utf8'))).toEqual(['a', 'b', 'c'])
  })

  it('makes the printer name safe for a file name', () => {
    expect(slugOf('Caisse n°1 / Bar')).toBe('caisse-n-1-bar')
    expect(slugOf('Cuisine Été')).toBe('cuisine-ete')
    expect(slugOf('???')).toBe('printer')
    expect(slugOf('../../etc/passwd')).toBe('etc-passwd')
  })
})
