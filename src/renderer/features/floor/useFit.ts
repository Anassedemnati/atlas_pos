import { useEffect, useRef, useState } from 'react'

/**
 * Scales the room's drawing (its coordinates are in design pixels) to the space there is, once `reserve` pixels of
 * height are kept for what sits above it (the title; in the editor also its toolbar).
 */
export function useFit(width: number, height: number, reserve = 96) {
  const ref = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setScale(Math.min((node.clientWidth - 32) / width, (node.clientHeight - reserve) / height, 1.6) || 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [width, height, reserve])
  return { ref, scale }
}
