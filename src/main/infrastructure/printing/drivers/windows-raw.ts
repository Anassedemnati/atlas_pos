import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermanentPrintError, type DriverJob, type PrinterDriver } from '../types'

/** The characters PowerShell reads as a single quote: the ASCII one and the typographic ones. */
const QUOTES = new Set(["'", String.fromCodePoint(0x2018), String.fromCodePoint(0x2019), String.fromCodePoint(0x201a), String.fromCodePoint(0x201b)])

/** `text` as a PowerShell single-quoted literal: nothing in it is interpreted, only the quotes are doubled. */
export function psQuote(text: string): string {
  let out = "'"
  for (const char of text) out += QUOTES.has(char) ? char + char : char
  return out + "'"
}

/**
 * The PowerShell that writes a file to a Windows printer as RAW data (no driver rendering, ESC/POS goes
 * through untouched): `OpenPrinter`, `StartDocPrinter` with the `RAW` data type, `WritePrinter`, closing
 * everything. The printer name and the file path are quoted, so a hostile name cannot run anything.
 */
export function windowsRawScript(printerName: string, filePath: string): string {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AtlasRawPrinter
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DocInfo
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool ClosePrinter(IntPtr handle);
    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool StartDocPrinter(IntPtr handle, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DocInfo info);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndDocPrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool StartPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool EndPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError = true)]
    static extern bool WritePrinter(IntPtr handle, IntPtr bytes, int count, out int written);

    static void Check(bool ok, string what, string printer)
    {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), what + " failed for " + printer);
    }

    public static void Send(string printerName, byte[] data)
    {
        IntPtr handle;
        Check(OpenPrinter(printerName, out handle, IntPtr.Zero), "OpenPrinter", printerName);
        try
        {
            DocInfo info = new DocInfo();
            info.pDocName = "Atlas POS";
            info.pOutputFile = null;
            info.pDataType = "RAW";
            Check(StartDocPrinter(handle, 1, info), "StartDocPrinter", printerName);
            try
            {
                Check(StartPagePrinter(handle), "StartPagePrinter", printerName);
                IntPtr buffer = Marshal.AllocCoTaskMem(data.Length);
                try
                {
                    Marshal.Copy(data, 0, buffer, data.Length);
                    int written;
                    Check(WritePrinter(handle, buffer, data.Length, out written) && written == data.Length, "WritePrinter", printerName);
                }
                finally
                {
                    Marshal.FreeCoTaskMem(buffer);
                }
                EndPagePrinter(handle);
            }
            finally
            {
                EndDocPrinter(handle);
            }
        }
        finally
        {
            ClosePrinter(handle);
        }
    }
}
'@
[AtlasRawPrinter]::Send(${psQuote(printerName)}, [System.IO.File]::ReadAllBytes(${psQuote(filePath)}))
`
}

/** The command line that runs `script` without profile, prompt or execution policy (so no `.ps1` on disk). */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

/** What the driver needs from the machine (replaced in tests). */
export interface WindowsRawIo {
  /** Writes the job to a temporary file; `cleanup` removes it. */
  writeTemp(data: Buffer): Promise<{ path: string; cleanup(): Promise<void> }>
  run(command: string, args: string[]): Promise<{ code: number | null; stderr: string }>
}

const RUN_TIMEOUT_MS = 30_000

export const windowsRawIo: WindowsRawIo = {
  async writeTemp(data) {
    const path = join(tmpdir(), `atlas-print-${randomUUID()}.bin`)
    await writeFile(path, data)
    return { path, cleanup: () => rm(path, { force: true }) }
  },
  run: (command, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(Object.assign(new Error(`PowerShell did not finish within ${RUN_TIMEOUT_MS} ms`), { code: 'ETIMEDOUT' }))
      }, RUN_TIMEOUT_MS)
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stderr })
      })
    })
}

/**
 * A printer installed in Windows, written to as RAW data through the spooler (`winspool.drv`). `printerName` is
 * the name Windows knows it by (what Electron's `getPrintersAsync` lists); the bytes reach PowerShell through a
 * temporary file, removed afterwards.
 */
export function createWindowsRawDriver(printerName: string, io: WindowsRawIo = windowsRawIo): PrinterDriver {
  return {
    kind: 'windows-raw',
    async send(job: DriverJob): Promise<void> {
      if (!Buffer.isBuffer(job)) throw new PermanentPrintError('html_not_supported', 'a raw printer takes ESC/POS bytes')
      const file = await io.writeTemp(job)
      try {
        const { code, stderr } = await io.run('powershell.exe', powershellArgs(windowsRawScript(printerName, file.path)))
        if (code !== 0) throw new Error(stderr.trim() || `PowerShell exited with code ${code}`)
      } finally {
        await file.cleanup().catch(() => undefined)
      }
    }
  }
}
