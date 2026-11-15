import { readdir } from 'node:fs/promises'
import type { HardwareDto } from '@shared/dto'
import type { ListSystemPrinters } from '../printing/types'

export interface DetectDeps {
  listSystemPrinters: ListSystemPrinters
  listDisplays(): HardwareDto['displays']
  platform?: NodeJS.Platform
}

/** Serial ports, through `serialport` (loaded on first use: it carries a native binding). None if it fails. */
async function serialPorts(): Promise<HardwareDto['serialPorts']> {
  try {
    const { SerialPort } = await import('serialport')
    return (await SerialPort.list()).map((port) => ({ path: port.path, manufacturer: port.manufacturer ?? null }))
  } catch {
    return []
  }
}

/** USB printers seen as device files (Linux `usblp`: `/dev/usb/lp0`...). */
async function deviceFiles(platform: NodeJS.Platform): Promise<string[]> {
  if (platform !== 'linux') return []
  try {
    return (await readdir('/dev/usb')).filter((name) => /^lp\d+$/.test(name)).map((name) => `/dev/usb/${name}`)
  } catch {
    return []
  }
}

/** What is plugged in, for the hardware step of the wizard and the technician menu. A source that fails lists nothing. */
export async function detectHardware(deps: DetectDeps): Promise<HardwareDto> {
  const [osPrinters, ports, files] = await Promise.all([
    deps.listSystemPrinters().catch(() => []),
    serialPorts(),
    deviceFiles(deps.platform ?? process.platform)
  ])
  return {
    osPrinters: osPrinters.map((printer) => ({ name: printer.name, isDefault: printer.isDefault })),
    serialPorts: ports,
    deviceFiles: files,
    displays: deps.listDisplays()
  }
}
