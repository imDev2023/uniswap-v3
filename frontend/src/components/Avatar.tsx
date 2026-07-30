import { useState } from 'react'
import { avatarInitials, avatarStyle } from '../lib/identicon'

/**
 * Token avatar with a deterministic colour fallback.
 *
 * @dev The previous implementation hid the <img> on error, which left a hole in the layout - a
 *      404'd image rendered as nothing at all. Since `metadataURI` is immutable, a mistyped or
 *      unpinned URI is permanent, so the broken case is not rare and must degrade to the identity
 *      tile rather than to empty space.
 */
export function Avatar({
  image,
  symbol,
  address,
  size = 'md',
}: {
  image?: string
  symbol: string
  address?: string
  size?: 'md' | 'sm'
}) {
  const [broken, setBroken] = useState(false)
  const cls = `token-avatar${size === 'sm' ? ' token-avatar-sm' : ''}`

  if (image && !broken) {
    return (
      <img
        className={cls}
        src={image}
        alt={symbol}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    )
  }

  // `address` is optional so existing callers keep working; without it the tile is still legible,
  // just not individually coloured.
  const style = address ? avatarStyle(address) : undefined
  return (
    <div className={cls} style={style} aria-label={symbol}>
      {avatarInitials(symbol)}
    </div>
  )
}
