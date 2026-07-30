import { formatPriceParts } from '../lib/format'

/**
 * A curve price, rendered in compact leading-zero notation.
 *
 * Launchpad prices sit around 1e-11 to 1e-8 ETH, so the previous exponential rendering
 * ("3.125e-11 ETH") was on every card, every stat block and every chart axis. It is unreadable at a
 * glance and impossible to compare down a column. The subscript form (0.0₁₀3125) keeps the digits
 * aligned so a column of prices can be scanned.
 *
 * The visible subscript is a compression, so the accessible name and the copy tooltip both carry the
 * fully expanded number.
 */
export function Price({ priceX18, unit = 'ETH' }: { priceX18: bigint; unit?: string | null }) {
  const parts = formatPriceParts(priceX18)
  const label = `${parts.text}${unit ? ` ${unit}` : ''}`

  if (parts.kind === 'plain') {
    return (
      <span className="num price" title={label}>
        {parts.text}
        {unit ? <span className="price-unit">{unit}</span> : null}
      </span>
    )
  }

  return (
    <span className="num price" title={label}>
      {/* aria-hidden on the pieces + an accessible label on the whole thing: a screen reader
          announcing "zero point zero, ten, three one two five" would be actively misleading. */}
      <span aria-hidden="true">
        0.0<sub className="price-zeros">{parts.zeros}</sub>
        {parts.digits}
      </span>
      <span className="sr-only">{parts.text}</span>
      {unit ? <span className="price-unit">{unit}</span> : null}
    </span>
  )
}
