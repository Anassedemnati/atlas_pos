import type { ReactNode, SVGProps } from 'react'
import { cx } from './metrics'

// Inline SVG icons: 24 px grid, 2 px round strokes, `currentColor`. No icon font, no network.

const GLYPHS = {
  utensils: (
    <>
      <path d="M6 3v6a2.5 2.5 0 0 0 5 0V3M8.5 3v18" />
      <path d="M18 21V3c-2.6 1.4-4 4.2-4 7.5 0 1.9 1.3 3.5 4 3.5" />
    </>
  ),
  coffee: (
    <>
      <path d="M4 10h12v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-4z" />
      <path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16M3 21.5h14M8 3c0 1.6 1.6 1.6 1.6 3.2M12 3c0 1.6 1.6 1.6 1.6 3.2" />
    </>
  ),
  bread: (
    <>
      <path d="M4.2 16.2C2 14 2.4 10.4 5.6 7.8 8.8 5.2 14 3.6 17.3 5.8c2.6 1.8 2.9 5.2-.6 8.9-3.2 3.4-9 5.2-12.5 1.5z" />
      <path d="M9 8.4l2.4 2.4M12.4 6.6l2.2 2.2M7.2 11.6l2 2" />
    </>
  ),
  store: (
    <>
      <path d="M4.5 4h15L21 9H3l1.5-5z" />
      <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0M5 12v8h14v-8M10 20v-5h4v5" />
    </>
  ),
  printer: <path d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7zM17 11.5h.01" />,
  drawer: <path d="M3 14l2.2-7h13.6L21 14v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4zM3 14h18M10 16.5h4" />,
  display: <path d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 20h8M12 16v4" />,
  barcode: <path d="M3.5 5v14M7 5v14M11 5v14M14 5v14M17.5 5v14M20.5 5v14" />,
  usb: (
    <>
      <path d="M12 3v14.5M12 14l-4.5-3.2V8.5M12 11.5l4.5-3V7" />
      <circle cx="12" cy="19.5" r="1.6" />
      <path d="M6 5.5h3v3H6zM16.5 5.5l1.5 1.5-1.5 1.5L15 7z" />
    </>
  ),
  disk: <path d="M3 13l2.6-7.4A2 2 0 0 1 7.5 4h9a2 2 0 0 1 1.9 1.6L21 13M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5M3 13h18M7 16.5h.01M11 16.5h6" />,
  nas: <path d="M5 4h14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM5 13h14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zM8 7.5h.01M8 16.5h.01M12 7.5h4M12 16.5h4" />,
  check: <path d="M4.5 12.5l5 5L19.5 7" />,
  warning: <path d="M12 3.5l9.5 16.5h-19L12 3.5zM12 10v4.5M12 17.4h.01" />,
  lightning: <path d="M13.5 2.5L4.5 14H11l-1 7.5L19.5 10H13l.5-7.5z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c.5-4 3.6-6.5 8-6.5s7.5 2.5 8 6.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M10.4 3h3.2l.5 2.4c.6.2 1.1.5 1.6.9l2.3-.8 1.6 2.8-1.8 1.6c.1.6.1 1.2 0 1.8l1.8 1.6-1.6 2.8-2.3-.8c-.5.4-1 .7-1.6.9l-.5 2.4h-3.2l-.5-2.4c-.6-.2-1.1-.5-1.6-.9l-2.3.8-1.6-2.8 1.8-1.6a6 6 0 0 1 0-1.8L4.4 8.3l1.6-2.8 2.3.8c.5-.4 1-.7 1.6-.9L10.4 3z" />
    </>
  ),
  back: <path d="M19.5 12h-15M11 5l-7 7 7 7" />,
  next: <path d="M4.5 12h15M13 5l7 7-7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  trash: <path d="M4 7h16M9.5 3.5h5M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  percent: (
    <>
      <path d="M19 5L5 19" />
      <circle cx="7" cy="7" r="2.3" />
      <circle cx="17" cy="17" r="2.3" />
    </>
  ),
  split: <path d="M12 3.5v17M9 12H3M6 9l-3 3 3 3M15 12h6M18 9l3 3-3 3" />,
  table: <path d="M2.5 10h19M5 10v10M19 10v10M4.5 3.5v4.5M19.5 3.5v4.5M10 4v4M14 4v4" />,
  cart: (
    <>
      <path d="M3 4h2.6l2.1 10.6h10.2L20 7.5H6.4" />
      <circle cx="9" cy="19" r="1.4" />
      <circle cx="17" cy="19" r="1.4" />
    </>
  ),
  chart: <path d="M4 20.5h16M6.5 20V12.5M12 20V4.5M17.5 20v-9" />,
  lock: (
    <>
      <path d="M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V8a4 4 0 0 1 8 0v3" />
      <path d="M12 15.5v1.5" />
    </>
  ),
  logout: <path d="M9 4H5.5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1H9M15.5 8l4 4-4 4M19.5 12H9" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L21 21" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6L6 18" />,
  chevron: <path d="M6 9l6 6 6-6" />,
  backspace: <path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6.5-7L9 5zM12.5 9.5l5 5M17.5 9.5l-5 5" />,
  shift: <path d="M12 4l8 9h-5v7H9v-7H4l8-9z" />,
  enter: <path d="M20 5v7a2 2 0 0 1-2 2H5M9 9.5L4.5 14 9 18.5" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9S14.6 18.4 12 21c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z" />
    </>
  )
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof GLYPHS

export const ICON_NAMES = Object.keys(GLYPHS) as IconName[]

/** Icons that point somewhere: they are flipped when the page is right-to-left. */
const DIRECTIONAL: ReadonlySet<IconName> = new Set<IconName>(['back', 'next', 'logout', 'enter'])

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  /** Pixel size (24 by default). */
  size?: number
  /** Accessible name; without it the icon is decorative (`aria-hidden`). */
  title?: string
}

export function Icon({ name, size = 24, title, className, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      className={cx('icon', DIRECTIONAL.has(name) && 'icon--mirror', className)}
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  )
}
