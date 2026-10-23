import { describe, expect, it } from 'vitest'
import { createDriver } from '../../../src/main/infrastructure/printing/drivers/factory'
import { createOsHtmlDriver } from '../../../src/main/infrastructure/printing/drivers/os-html'
import { createSerialDriver, parseSerialAddress, type SerialConnection } from '../../../src/main/infrastructure/printing/drivers/serial'
import { parseHostPort } from '../../../src/main/infrastructure/printing/drivers/network'
import {
  createWindowsRawDriver,
  powershellArgs,
  psQuote,
  windowsRawScript,
  type WindowsRawIo
} from '../../../src/main/infrastructure/printing/drivers/windows-raw'
import { PermanentPrintError } from '../../../src/main/infrastructure/printing/types'
import { fixedClock } from '../../helpers/clock'
import { printer } from '../../helpers/printing'

const JOB = Buffer.from('1b40410a', 'hex')

describe('parseHostPort', () => {
  it('defaults to port 9100', () => {
    expect(parseHostPort('192.168.1.50')).toEqual({ host: '192.168.1.50', port: 9100 })
    expect(parseHostPort(' printer.lan ')).toEqual({ host: 'printer.lan', port: 9100 })
  })

  it('reads an explicit port', () => {
    expect(parseHostPort('192.168.1.50:9101')).toEqual({ host: '192.168.1.50', port: 9101 })
  })

  it('refuses an address that is not host[:port]', () => {
    for (const bad of ['', ':9100', 'host:0', 'host:70000', 'host:abc', 'a:b:c']) {
      expect(() => parseHostPort(bad), bad).toThrow(PermanentPrintError)
    }
  })
})

describe('serial driver', () => {
  it('reads the path and the baud rate (9600 by default)', () => {
    expect(parseSerialAddress('COM3')).toEqual({ path: 'COM3', baudRate: 9600 })
    expect(parseSerialAddress('COM3@19200')).toEqual({ path: 'COM3', baudRate: 19200 })
    expect(parseSerialAddress('/dev/ttyUSB0@115200')).toEqual({ path: '/dev/ttyUSB0', baudRate: 115200 })
  })

  it('refuses an empty path or a nonsense baud rate', () => {
    expect(() => parseSerialAddress('')).toThrow(PermanentPrintError)
    expect(() => parseSerialAddress('COM3@fast')).toThrow(PermanentPrintError)
  })

  const fakePort = (log: string[], over: Partial<SerialConnection> = {}): SerialConnection => ({
    write: async (data) => void log.push(`write ${data.toString('hex')}`),
    close: async () => void log.push('close'),
    ...over
  })

  it('opens the port, writes the bytes, closes it', async () => {
    const log: string[] = []
    const driver = createSerialDriver('COM3@19200', {
      open: async (path, baudRate) => {
        log.push(`open ${path} ${baudRate}`)
        return fakePort(log)
      }
    })
    await driver.send(JOB)
    expect(driver.kind).toBe('serial')
    expect(log).toEqual(['open COM3 19200', 'write 1b40410a', 'close'])
  })

  it('closes the port when the write fails, and rejects with the reason', async () => {
    const log: string[] = []
    const driver = createSerialDriver('COM3', {
      open: async () =>
        fakePort(log, {
          write: async () => {
            throw new Error('device removed')
          }
        })
    })
    await expect(driver.send(JOB)).rejects.toThrow('device removed')
    expect(log).toEqual(['close'])
  })

  it('rejects when the port cannot be opened', async () => {
    const driver = createSerialDriver('COM9', {
      open: async () => {
        throw Object.assign(new Error('File not found'), { code: 'ENOENT' })
      }
    })
    await expect(driver.send(JOB)).rejects.toThrow('File not found')
  })

  it('refuses an HTML job for good', async () => {
    const driver = createSerialDriver('COM3', { open: async () => fakePort([]) })
    await expect(driver.send({ html: '<p>x</p>' })).rejects.toBeInstanceOf(PermanentPrintError)
  })
})

describe('windows-raw driver', () => {
  it('quotes a name as a PowerShell single-quoted literal', () => {
    expect(psQuote('Imprimante d\'accueil')).toBe("'Imprimante d''accueil'")
    expect(psQuote('EPSON TM-T20')).toBe("'EPSON TM-T20'")
    // PowerShell also treats the typographic single quotes as quotes
    expect(psQuote(String.fromCodePoint(0x2018, 0x2019, 0x201a, 0x201b))).toBe(
      "'" + String.fromCodePoint(0x2018, 0x2018, 0x2019, 0x2019, 0x201a, 0x201a, 0x201b, 0x201b) + "'"
    )
  })

  it('cannot be broken out of by a hostile name', () => {
    const script = windowsRawScript("x'; Remove-Item C:\\* -Recurse; '", 'C:\\Temp\\job.bin')
    expect(script).toContain("'x''; Remove-Item C:\\* -Recurse; '''")
    expect(script.split('\n').filter((l) => l.startsWith('Remove-Item'))).toEqual([])
  })

  it('generates the winspool RAW script for the printer and the temp file', () => {
    const script = windowsRawScript("Imprimante d'accueil", 'C:\\Users\\Caisse\\AppData\\Local\\Temp\\atlas-1.bin')
    for (const needle of ['Add-Type', 'winspool.drv', 'OpenPrinter', 'StartDocPrinter', 'StartPagePrinter', 'WritePrinter', 'EndDocPrinter', 'ClosePrinter', '"RAW"']) {
      expect(script, needle).toContain(needle)
    }
    expect(script).toContain("[AtlasRawPrinter]::Send('Imprimante d''accueil', [System.IO.File]::ReadAllBytes('C:\\Users\\Caisse\\AppData\\Local\\Temp\\atlas-1.bin'))")
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toContain("$ProgressPreference = 'SilentlyContinue'")
  })

  it('runs PowerShell without profile, prompt or execution policy, with the script encoded', () => {
    const script = windowsRawScript('P', 'C:\\t.bin')
    const args = powershellArgs(script)
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(Buffer.from(args[5]!, 'base64').toString('utf16le')).toBe(script)
  })

  const ioLog = (log: string[], exit: { code: number | null; stderr: string } = { code: 0, stderr: '' }): WindowsRawIo => ({
    writeTemp: async (data) => {
      log.push(`temp ${data.toString('hex')}`)
      return { path: 'C:\\t\\job.bin', cleanup: async () => void log.push('cleanup') }
    },
    run: async (command, args) => {
      log.push(`run ${command} ${Buffer.from(args.at(-1)!, 'base64').toString('utf16le').includes("Send('Caisse'")}`)
      return exit
    }
  })

  it('passes the bytes through a temp file, runs PowerShell, and removes the file', async () => {
    const log: string[] = []
    const driver = createWindowsRawDriver('Caisse', ioLog(log))
    await driver.send(JOB)
    expect(driver.kind).toBe('windows-raw')
    expect(log).toEqual(['temp 1b40410a', 'run powershell.exe true', 'cleanup'])
  })

  it('rejects with PowerShell\'s message when it fails, and still removes the file', async () => {
    const log: string[] = []
    const driver = createWindowsRawDriver('Caisse', ioLog(log, { code: 1, stderr: 'OpenPrinter failed for Caisse' }))
    await expect(driver.send(JOB)).rejects.toThrow('OpenPrinter failed for Caisse')
    expect(log.at(-1)).toBe('cleanup')
  })

  it('refuses an HTML job for good', async () => {
    await expect(createWindowsRawDriver('Caisse', ioLog([])).send({ html: 'x' })).rejects.toBeInstanceOf(PermanentPrintError)
  })
})

describe('os-html driver', () => {
  it('prints the HTML on the named system printer', async () => {
    const calls: [string, string][] = []
    const driver = createOsHtmlDriver('HP LaserJet', { print: async (html, device) => void calls.push([html, device]) })
    await driver.send({ html: '<p>facture</p>' })
    expect(driver.kind).toBe('os-html')
    expect(calls).toEqual([['<p>facture</p>', 'HP LaserJet']])
  })

  it('refuses bytes for good: a system printer takes documents, not ESC/POS', async () => {
    const driver = createOsHtmlDriver('HP', { print: async () => undefined })
    await expect(driver.send(JOB)).rejects.toBeInstanceOf(PermanentPrintError)
  })

  it('passes the failure of the system on', async () => {
    const driver = createOsHtmlDriver('HP', {
      print: async () => {
        throw new Error('Print job failed')
      }
    })
    await expect(driver.send({ html: 'x' })).rejects.toThrow('Print job failed')
  })
})

describe('createDriver', () => {
  const env = { printsDir: '/tmp/atlas-prints', clock: fixedClock() }

  it('builds the driver of each kind', () => {
    expect(createDriver(printer({ kind: 'network', address: '10.0.0.5' }), env).kind).toBe('network')
    expect(createDriver(printer({ kind: 'serial', address: 'COM3' }), env).kind).toBe('serial')
    expect(createDriver(printer({ kind: 'device-file', address: '/dev/usb/lp0' }), env).kind).toBe('device-file')
    expect(createDriver(printer({ kind: 'windows-raw', address: 'Caisse' }), env).kind).toBe('windows-raw')
    expect(createDriver(printer({ kind: 'os-html', address: 'HP' }), { ...env, htmlPrinter: { print: async () => undefined } }).kind).toBe('os-html')
    expect(createDriver(printer({ kind: 'virtual' }), env).kind).toBe('virtual')
  })

  it('refuses for good an unknown kind, a bad address, and a system printer without the Electron port', () => {
    expect(() => createDriver(printer({ kind: 'laser-pointer' }), env)).toThrow(PermanentPrintError)
    expect(() => createDriver(printer({ kind: 'network', address: '' }), env)).toThrow(PermanentPrintError)
    expect(() => createDriver(printer({ kind: 'serial', address: '' }), env)).toThrow(PermanentPrintError)
    expect(() => createDriver(printer({ kind: 'device-file', address: '' }), env)).toThrow(PermanentPrintError)
    expect(() => createDriver(printer({ kind: 'windows-raw', address: '' }), env)).toThrow(PermanentPrintError)
    expect(() => createDriver(printer({ kind: 'os-html', address: 'HP' }), env)).toThrow(PermanentPrintError)
  })
})
