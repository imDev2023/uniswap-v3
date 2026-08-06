import type { Address } from 'viem'
import { useClaimableFees } from '../hooks/useClaimableFees'
import { usePoolTokenOrder } from '../hooks/usePoolTokenOrder'
import { byPoolOrder } from '../lib/fees'
import { formatAge, formatEth, formatTokenAmount, shortAddress } from '../lib/format'
import type { LockRow } from '../lib/subgraph'

/**
 * What a launch's creator has actually earned from the locked LP position (#39, settled decision 1).
 *
 * The create form and the lock card both promise the creator "70% of the locked position's fees".
 * That promise has had no read side since the day it was decided, so this card is the answer to
 * "and what has that come to".
 *
 * ⚠️ **It answers two different questions and must never merge them.** Lifetime collected comes from
 * the indexer and is what has been PAID OUT. Accrued comes from simulating `collect` on-chain and is
 * what is WAITING. They are not stages of one number: `collect` is permissionless, so a position can
 * hold a year of real fees with a lifetime total of zero, and showing only the indexed side would
 * tell that creator they have earned nothing.
 *
 * ⚠️ Fees arrive in BOTH assets - the launch token and WETH - because that is what a V3 position
 * accrues. There is no single figure to quote and no exchange rate here to make one, so both are
 * shown and neither is summed into the other.
 */
export function FeeEarningsCard({
  lock,
  positionTokenId,
  token,
  pool,
  creatorFeeBps,
  graduated,
  symbol,
  nowSeconds,
}: {
  /** The indexed lock record. Null before graduation, and null when the indexer is behind. */
  lock: LockRow | null
  /**
   * `LaunchTerms.positionTokenId` - the locked position's NFT id, from the CHAIN.
   *
   * ⚠️ Deliberately NOT `lock.id`. The accrued figure below is a chain read, and taking its tokenId
   * off the indexed row would gate it on the indexer: with graph-node behind, the panel would sit on
   * "Reading the position…" forever for a value the chain can answer. That is the #37 defect exactly
   * - a panel is not on the chain until EVERY value it reads is. `null` means no position yet.
   */
  positionTokenId: bigint | null | undefined
  token: Address | undefined
  pool: Address | undefined
  /**
   * `LaunchTerms.creatorFeeBps`, from the chain.
   *
   * ⚠️ `undefined` means the read has not returned. Zero would tell a creator their share is nothing,
   * which is a specific and wrong answer rather than an honest blank.
   */
  creatorFeeBps: number | undefined
  graduated: boolean
  symbol: string
  nowSeconds: number
}) {
  const accrued = useClaimableFees(positionTokenId ?? undefined, pool, token, creatorFeeBps)
  // ⚠️ The indexed lifetime totals arrive in the POOL's token0/token1 ordering, unresolved on
  // purpose - see `usePoolTokenOrder`. Until this lands they cannot be labelled with an asset, so
  // they are shown as not-known rather than guessed onto the wrong one.
  const tokenIsToken0 = usePoolTokenOrder(pool, token)
  const lifetime =
    lock && tokenIsToken0 !== undefined
      ? {
          creator: byPoolOrder(BigInt(lock.creatorFees0), BigInt(lock.creatorFees1), tokenIsToken0),
          treasury: byPoolOrder(
            BigInt(lock.treasuryFees0),
            BigInt(lock.treasuryFees1),
            tokenIsToken0,
          ),
        }
      : undefined

  // Before graduation there is no position, so nothing can have accrued. That is a real answer, not
  // a missing one, and it is different from every state below.
  if (!graduated) return null

  const share = creatorFeeBps === undefined ? 'unknown' : `${creatorFeeBps / 100}%`
  const lastCollection = lock?.collections?.[0]

  return (
    <div className="card">
      <p className="section-title">Creator fee earnings</p>

      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        {/* ⚠️ The denominator is named. "70% of pool fees" overstates the creator's take by a third,
            because the protocol fee comes off the top before the locked position accrues anything. */}
        The creator receives {share} of the fees this locked position earns, in both {symbol} and
        ETH. The rest goes to the treasury.
      </p>

      {lock?.reclaimed ? (
        /* ⚠️ Terminal. After `reclaim` the position no longer exists, so simulating `collect` on it
           reverts - which would otherwise render as the transient "could not be read right now" and
           invite the reader to wait for something that is never coming back. */
        <Section title="Waiting to be collected">
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            The position was wound up, so nothing accrues any more.
          </p>
        </Section>
      ) : (
      <Section title="Waiting to be collected">
        {/* ⚠️ Chain-sourced, and deliberately so. The indexer cannot know this: it only sees
            collections that happened, and nobody is obliged to trigger one. */}
        <Amounts
          tokenAmount={accrued.creatorToken}
          wethAmount={accrued.creatorWeth}
          symbol={symbol}
          unknownNote={
            accrued.isError
              ? 'Could not be read from the chain right now.'
              : 'Reading the position…'
          }
        />
        {accrued.creatorToken !== undefined && (
          <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
            {/* The treasury's side of the same split, named so the 70% has a visible denominator on
                the state this card was built for: fees accrued, nothing ever collected. */}
            The treasury's share is a further {formatTokenAmount(accrued.treasuryToken!)} {symbol} and{' '}
            {formatEth(accrued.treasuryWeth!, 6)} ETH. Anyone can trigger a collection. Whoever does,
            the funds go only to the creator and the treasury, never to the caller.
          </p>
        )}
      </Section>
      )}

      <Section title="Collected so far">
        {!lock ? (
          /* ⚠️ Graduated with no indexed row. Rendering zero here would report a creator's realised
             earnings as nothing on the strength of an indexer that simply has not caught up. */
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Not indexed yet. The position and its history exist on-chain either way.
          </p>
        ) : lock.collectionCount === 0 ? (
          /* ⚠️ The distinction this whole card exists to preserve. Zero collected is NOT zero
             earned - it means nothing has been collected, which on a permissionless collector is
             the ordinary state rather than a signal about the launch. */
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Nothing has been collected yet. Any fees the position has earned are still in it, shown
            above.
          </p>
        ) : (
          <>
            <Amounts
              tokenAmount={lifetime?.creator.token}
              wethAmount={lifetime?.creator.weth}
              symbol={symbol}
              unknownNote="Collected, but the pool's token order could not be read to label the assets."
            />
            <p className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 0 }}>
              Over {lock.collectionCount === 1 ? '1 collection' : `${lock.collectionCount} collections`}
              {lastCollection && (
                <>
                  , the last {formatAge(lastCollection.collectedAtTimestamp, nowSeconds)} ago sent by{' '}
                  {/* ⚠️ "sent by", not "collected by". `FeesCollected` carries no msg.sender, so this
                      is the transaction's sender and differs from the caller when a contract sits in
                      between. */}
                  {shortAddress(lastCollection.sentBy)}
                </>
              )}
              .
              {lifetime && (
                <>
                  {' '}
                  Treasury received {formatTokenAmount(lifetime.treasury.token)} {symbol} and{' '}
                  {formatEth(lifetime.treasury.weth, 6)} ETH.
                </>
              )}
            </p>
          </>
        )}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 'var(--s-3)' }}>
      <div className="kv-label">{title}</div>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  )
}

/**
 * A pair of amounts in the two assets a V3 position accrues.
 *
 * ⚠️ Both are tri-state. `undefined` is "not read", and it renders as a note rather than as zero -
 * zero is a real and common answer here, so the two must never look the same.
 */
function Amounts({
  tokenAmount,
  wethAmount,
  symbol,
  unknownNote,
}: {
  tokenAmount: bigint | undefined
  wethAmount: bigint | undefined
  symbol: string
  unknownNote?: string
}) {
  if (tokenAmount === undefined || wethAmount === undefined) {
    return (
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        {unknownNote ?? 'Not known.'}
      </p>
    )
  }

  return (
    <div className="kv-grid">
      <div className="kv">
        <div className="kv-value">
          {/* ⚠️ 6 decimals, not the 4-decimal default. Fees are small by nature: a real 0.000105 ETH
              renders as "0.0001" at the default, which reads as a rounder and smaller number than
              the creator actually has. */}
          {formatEth(wethAmount, 6)} <span className="muted">ETH</span>
        </div>
      </div>
      <div className="kv">
        <div className="kv-value">
          {formatTokenAmount(tokenAmount)} <span className="muted">{symbol}</span>
        </div>
      </div>
    </div>
  )
}
