/// <reference path="../atlas.d.ts" />
import { useEffect, useRef } from 'react'
import type { AtlasEvent, AtlasEventType } from '@shared/dto'

/**
 * Listens to one type of event pushed by the main process (`window.atlas.on`) while the component is
 * mounted. The callback may change between renders without resubscribing.
 */
export function useEvent<T extends AtlasEventType>(type: T, callback: (event: Extract<AtlasEvent, { type: T }>) => void): void {
  const latest = useRef(callback)
  useEffect(() => {
    latest.current = callback
  })
  useEffect(() => {
    if (typeof window === 'undefined' || !window.atlas) return
    return window.atlas.on(type, (event) => latest.current(event))
  }, [type])
}
