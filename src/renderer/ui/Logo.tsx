import { cx } from './metrics'

export interface LogoProps {
  /** Mark only (no wordmark). */
  compact?: boolean
  className?: string
}

/** The Atlas mark (two peaks, teal over blue) and the "Atlas POS" wordmark, white on the navy bar. */
export function Logo({ compact, className }: LogoProps) {
  return (
    <span className={cx('logo', className)}>
      <svg viewBox="0 0 40 32" width="40" height="32" aria-hidden="true" focusable="false">
        <path d="M2 30L16 4l9 15-5 11H2z" fill="#0fa3a3" />
        <path d="M18 30l8-14 12 14H18z" fill="#2d6fd0" />
        <path d="M16 4l5 8.4L25 19l-3-5-6-10z" fill="#5fd0d0" opacity="0.7" />
      </svg>
      {!compact && (
        <span className="logo__word">
          Atlas <span className="logo__pos">POS</span>
        </span>
      )}
    </span>
  )
}
