/**
 * Deterministic fallback identity for a token with no resolvable image.
 *
 * v1 is bring-your-own-URI, and `metadataURI` is immutable with no setter, so "no image" and
 * "permanently broken image" are both common and permanent states - not edge cases to paper over.
 * A grid of identical grey letter tiles is unscannable, so the fallback derives a stable hue from
 * the token address: every launch still looks like itself, and the same address always produces the
 * same colour in every browser and every session.
 *
 * Address-derived, NOT symbol-derived: symbols are attacker-chosen and duplicable, so two launches
 * calling themselves DOGE would otherwise be visually identical. The address is unique.
 */
export interface AvatarStyle {
  background: string
  color: string
  borderColor: string
}

export function avatarHue(address: string): number {
  // FNV-1a over the lowercased address. Cheap, dependency-free, and well-distributed enough that
  // adjacent addresses do not land on adjacent hues.
  let hash = 0x811c9dc5
  const s = address.toLowerCase()
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 360
}

export function avatarStyle(address: string): AvatarStyle {
  const hue = avatarHue(address)
  // Low saturation and lightness keep these as identity cues rather than competing with the heat
  // ramp, which is the colour channel that actually carries information on this board.
  return {
    background: `hsl(${hue} 42% 17%)`,
    color: `hsl(${hue} 65% 72%)`,
    borderColor: `hsl(${hue} 40% 26%)`,
  }
}

/** Up to three characters, uppercased - what the tile shows when there is no image. */
export function avatarInitials(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toUpperCase() || '?'
}
