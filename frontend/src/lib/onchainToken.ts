import { zeroAddress, type Address } from 'viem'

// Stage 2: the trade path resolves entirely from RPC, never from the indexer.
//
// Everything the app needs in order to let someone spend money on a token is derivable from plain
// contract reads rooted at the one address baked into the build (VITE_FACTORY_ADDRESS):
//
//   launchpad.curveOf(token)                     -> the bonding curve (zero => not our launch)
//   curve.graduated()                            -> is the curve closed?
//   launchpad.v3Factory()                        -> the platform's V3 factory (immutable)
//   v3Factory.getPool(token, WETH, 10000)        -> the graduated pool
//   token.name() / token.symbol()                -> labels
//
// The subgraph is still the read model for feeds, charts and holders - but an indexer outage now
// degrades those to "unavailable" instead of taking trading down with them.
//
// The launchpad address is deliberately the ROOT OF TRUST rather than `LaunchToken.launchpad()`.
// A token can name any factory it likes; trusting that would let a hostile ERC-20 at /token/0x…
// point the UI at a fake curve and collect real ETH. Asking OUR launchpad "is this yours?" cannot
// be spoofed, and `curveOf(token) != 0` is exactly that question.

export interface OnchainTokenReads {
  /** Whether VITE_FACTORY_ADDRESS is set for this build. */
  configured: boolean
  /** `launchpad.curveOf(token)` - undefined while in flight. */
  curve: Address | undefined
  /** The curveOf read failed (RPC unreachable / reverted). */
  curveError: boolean
  /** `curve.graduated()` - undefined while in flight. */
  graduated: boolean | undefined
  /** The graduated read failed. */
  graduatedError: boolean
  /** `v3Factory.getPool(token, WETH, POOL_FEE_TIER)` - undefined while in flight. */
  pool: Address | undefined
  /**
   * The pool lookup could not be performed - either getPool failed, or the v3Factory address it
   * depends on failed to load. Distinct from `pool: undefined`, which means "still in flight":
   * without it a graduated token would sit in `loading` forever instead of admitting it can't
   * resolve a pool.
   */
  poolError: boolean
  name: string | undefined
  symbol: string | undefined
}

export type OnchainToken =
  /** Contracts aren't configured for this build (preview mode). */
  | { status: 'not-configured' }
  /** Reads still in flight. */
  | { status: 'loading' }
  /** RPC could not answer. This is the only genuine outage state for trading. */
  | { status: 'unreachable' }
  /** The launchpad has no curve for this address - not one of our launches. */
  | { status: 'not-a-launch' }
  /** Live bonding curve: trade against `curve`. */
  | { status: 'on-curve'; curve: Address; name: string; symbol: string }
  /** Graduated: trade against `pool` via the SwapRouter. */
  | { status: 'graduated'; curve: Address; pool: Address; name: string; symbol: string }
  /**
   * Graduated, but the V3 factory reports no pool for TOKEN/WETH at the graduated fee tier. Should
   * be unreachable in practice - graduation creates the pool atomically - so it is surfaced rather
   * than silently rendered as a broken swap box.
   */
  | { status: 'graduated-pool-missing'; curve: Address; name: string; symbol: string }

/** The states that carry a resolved curve, i.e. the page has something real to render. */
export type TradeableToken = Extract<OnchainToken, { curve: Address }>

/**
 * Narrow to the states that resolved to a real launch. Everything else is a notice, not a page -
 * see components/OnchainTokenGate. Written as a type guard so the pages cannot reach a trade panel
 * without having passed the check.
 */
export function isTradeable(t: OnchainToken): t is TradeableToken {
  return 'curve' in t
}

/** True for a zero / absent address. */
function isEmpty(a: Address | undefined): boolean {
  return a === undefined || a === zeroAddress
}

/**
 * Fold the raw contract reads into one state. Pure, so the trade path's decision table is unit
 * tested without a chain, an RPC or a mocked wagmi.
 */
export function resolveOnchainToken(r: OnchainTokenReads): OnchainToken {
  if (!r.configured) return { status: 'not-configured' }

  // Membership first: without a curve there is nothing to trade and nothing to look up.
  if (r.curveError) return { status: 'unreachable' }
  if (r.curve === undefined) return { status: 'loading' }
  if (r.curve === zeroAddress) return { status: 'not-a-launch' }

  if (r.graduatedError) return { status: 'unreachable' }
  if (r.graduated === undefined) return { status: 'loading' }

  // Labels are cosmetic - a token that doesn't answer name()/symbol() still trades fine, so their
  // absence must not block the panel. Fall back to the symbol, then to nothing.
  const symbol = r.symbol ?? ''
  const name = r.name ?? symbol

  // A live curve trades against the curve contract, so a failed pool lookup is irrelevant here -
  // don't let it degrade a page that is perfectly able to trade.
  if (!r.graduated) return { status: 'on-curve', curve: r.curve, name, symbol }

  if (r.poolError) return { status: 'unreachable' }
  if (r.pool === undefined) return { status: 'loading' }
  if (isEmpty(r.pool)) return { status: 'graduated-pool-missing', curve: r.curve, name, symbol }

  return { status: 'graduated', curve: r.curve, pool: r.pool, name, symbol }
}
