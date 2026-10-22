import { contextBridge } from 'electron'

// Minimal bridge so the boot check can prove the preload script ran.
// The typed IPC surface replaces this in Task 15.
contextBridge.exposeInMainWorld('atlas', { platform: process.platform })
