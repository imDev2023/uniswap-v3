import { isHidden } from '../lib/denylist'
import type { TokenMetadata } from '../lib/tokenMetadata'

/**
 * The creator-supplied part of a token's identity: description and links.
 *
 * Renders nothing at all when there is no metadata, which is the common case - v1 is
 * bring-your-own-URI and most launches carry no URI. An empty labelled section would imply the
 * creator wrote a description and we failed to load it, which is a different and worse claim than
 * simply not showing one.
 *
 * Everything here is third-party text fetched from a gateway, so it is rendered as text and never
 * as markup, and every link has already been narrowed to `https:` by the parser. `rel="noreferrer
 * nofollow"` keeps a launch from passing our referrer or any ranking signal to a URL that anyone
 * could put on-chain for the price of a launch.
 */
export function TokenIdentity({
  address,
  meta,
}: {
  address: string
  meta: TokenMetadata | null
}) {
  // A hidden token stays fully tradeable and reachable by direct link - see config/denylist.ts for
  // why refusing to render it would strand its holders. What it does not get is a page that carries
  // the creator's description and outbound links as though we were vouching for them.
  if (isHidden(address)) {
    return (
      <p className="token-blurb token-blurb-muted">
        This launch has been hidden from the board. Trading is unaffected.
      </p>
    )
  }

  if (!meta) return null
  const hasDescription = !!meta.description
  const hasLinks = meta.links.length > 0
  if (!hasDescription && !hasLinks) return null

  return (
    <div className="token-identity">
      {hasDescription && <p className="token-blurb">{meta.description}</p>}
      {hasLinks && (
        <div className="token-links">
          {meta.links.map((l) => (
            <a
              key={l.url}
              className="token-link"
              href={l.url}
              target="_blank"
              rel="noreferrer nofollow"
            >
              {l.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
