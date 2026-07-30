import type { ReactNode } from 'react'

/**
 * A designed empty/degraded state.
 *
 * Empty and degraded states are product states, not error pages, and they are the states a new
 * visitor is most likely to hit first - an unseeded board, an indexer restart. Rendering them as
 * bare centred paragraphs inside an otherwise designed board makes working software look broken, so
 * they get the same care as the happy path.
 *
 * `role="status"` rather than `role="alert"`: these are informational, and an alert would interrupt
 * a screen-reader user mid-sentence every time a poll failed.
 */
export function Notice({
  icon,
  title,
  children,
  inline = false,
}: {
  icon?: string
  title?: string
  children: ReactNode
  /** Tighter padding, for a notice sitting inside a panel rather than replacing a whole section. */
  inline?: boolean
}) {
  return (
    <div className={`notice${inline ? ' notice-inline' : ''}`} role="status">
      {icon ? (
        <span className="notice-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {title ? <span className="notice-title">{title}</span> : null}
      <span className="notice-body">{children}</span>
    </div>
  )
}
