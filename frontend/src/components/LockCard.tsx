import type { Address } from 'viem'
import { useReclaimStatus } from '../hooks/useReclaimStatus'
import { formatDuration, formatEth, formatTokenAmount } from '../lib/format'
import { lockState, reclaimBlockerCopy, ReclaimBlocker } from '../lib/lock'
import type { LockRow } from '../lib/subgraph'

/**
 * The LP lock on a launch's graduation position (#33 / ADR-0005).
 *
 * ⚠️ **The lock is CONDITIONAL, not permanent, and this card is where that has to be legible.** It
 * is one year by default. The creator may extend it and may never shorten it, and a permanent lock
 * is a separate choice made at creation. Seven surfaces in this app once said "locked forever";
 * every one of them was wrong for the default case, which is the case almost every launch is in.
 *
 * Before graduation there is no position and no lock record, so what is shown are the TERMS - frozen
 * at `createLaunch` and binding from the moment the curve opens, which is exactly why they are worth
 * showing to someone deciding whether to buy on that curve.
 */
export function LockCard({
  lock,
  lockDuration,
  permanentLockChoice,
  creatorFeeBps,
  graduated,
  pool,
  nowSeconds,
  symbol,
}: {
  /** The indexed lock record. Null before graduation, and null if the indexer has not caught up. */
  lock: LockRow | null
  /**
   * `LaunchTerms.lockDuration` - seconds from graduation. Meaningless when permanent.
   *
   * ⚠️ `undefined` means THE CHAIN READ HAS NOT RETURNED, and must not collapse to zero anywhere
   * below. Zero renders as "Term: none" on the one panel a buyer reads to decide whether the
   * liquidity is locked at all - a confident, specific, wrong answer in place of an honest blank.
   */
  lockDuration: bigint | undefined
  /**
   * `LaunchTerms.permanentLock` - the creator's CHOICE at creation.
   *
   * ⚠️ A different fact from `lock.permanent`, which is the realised state, and the two may
   * legitimately diverge: `extend` can turn the second true on a launch whose creator originally
   * chose a term. Neither is mirrored onto the other here.
   */
  permanentLockChoice: boolean | undefined
  /** ⚠️ `undefined` means the chain read has not returned. Zero would tell a creator they earn nothing. */
  creatorFeeBps: number | undefined
  graduated: boolean
  pool: Address | undefined
  nowSeconds: number
  symbol: string
}) {
  const tokenId = lock ? BigInt(lock.id) : undefined
  const reclaim = useReclaimStatus(tokenId, pool)

  // ⚠️ "Not known" is a distinct state from every real term, and it is checked first. The terms are
  // frozen on-chain either way; what is missing is our view of them, and saying "none" or "0%"
  // would misreport a lock that certainly exists.
  //
  // ⚠️ These three arrive over RPC from `useLaunchTerms`, NOT from the indexer, so nothing on this
  // path may tell the reader to wait for indexing. That advice would send a buyer to wait on a
  // subsystem which is not involved and whose recovery cannot help them.
  const termsKnown = lockDuration !== undefined && permanentLockChoice !== undefined

  return (
    <div className="card">
      <p className="section-title">Liquidity lock</p>

      <div className="kv-grid">
        <Kv
          label="Term"
          value={!termsKnown ? 'unknown' : permanentLockChoice ? 'Permanent' : formatDuration(lockDuration)}
        />
        {/* ⚠️ "of the locked position's fees", NOT "of pool fees". The pool's fee splits before this
            share is taken: the protocol fee comes off the top and only the remainder accrues to the
            locked LP position, of which this is the creator's cut. Labelling it "of pool fees"
            overstated the creator's actual take by a third on the number they decide to launch on.
            The volume-denominated figure is deliberately not quoted here because it is not a
            constant - `setProtocolFee` is owner-tunable. See docs/tokenomics.md section 4. */}
        <Kv
          label="Creator fee share"
          value={
            creatorFeeBps === undefined
              ? 'unknown'
              : `${creatorFeeBps / 100}% of the locked position's fees`
          }
        />
      </div>

      {!termsKnown ? (
        <p className="muted" style={{ marginTop: 'var(--s-3)', marginBottom: 0, fontSize: 13 }}>
          The lock terms could not be read for this launch. They are still frozen on-chain and still
          binding - this page just cannot reach them right now.
        </p>
      ) : !graduated ? (
        <p className="muted" style={{ marginTop: 'var(--s-3)', marginBottom: 0, fontSize: 13 }}>
          {permanentLockChoice
            ? 'At graduation the entire liquidity position is locked permanently. It can never be withdrawn or reclaimed.'
            : `At graduation the entire liquidity position is locked for ${formatDuration(
                lockDuration,
              )}. The creator can extend that, but can never shorten it.`}{' '}
          These terms were frozen when the curve was created and cannot change.
        </p>
      ) : !lock ? (
        /* ⚠️ Graduated but no lock record. This is an indexer gap, not an absence of a lock - the
           position exists on-chain either way. Saying "not locked" here would be the worst possible
           lie on this particular card. */
        <p className="muted" style={{ marginTop: 'var(--s-3)', marginBottom: 0, fontSize: 13 }}>
          The position is locked on-chain, but its record has not been indexed yet. Terms above are
          the ones frozen at creation.
        </p>
      ) : (
        <LockState lock={lock} nowSeconds={nowSeconds} reclaim={reclaim} symbol={symbol} />
      )}
    </div>
  )
}

function LockState({
  lock,
  nowSeconds,
  reclaim,
  symbol,
}: {
  lock: LockRow
  nowSeconds: number
  reclaim: ReturnType<typeof useReclaimStatus>
  symbol: string
}) {
  const state = lockState(
    {
      lockUntil: BigInt(lock.lockUntil),
      permanent: lock.permanent,
      reclaimed: lock.reclaimed,
      extendCount: lock.extendCount,
    },
    BigInt(nowSeconds),
  )

  return (
    <>
      <div className="kv-grid" style={{ marginTop: 'var(--s-3)' }}>
        {state.kind === 'permanent' ? (
          <Kv label="Status" value="Locked permanently" />
        ) : state.kind === 'reclaimed' ? (
          <Kv label="Status" value="Reclaimed" />
        ) : (
          <Kv
            label={state.kind === 'locked' ? 'Unlocks in' : 'Expired'}
            value={
              state.kind === 'locked'
                ? formatDuration(state.secondsRemaining)
                : `${formatDuration(state.secondsSinceExpiry)} ago`
            }
          />
        )}
        {lock.extendCount > 0 && (
          <Kv
            label="Extended"
            value={lock.extendCount === 1 ? 'once' : `${lock.extendCount} times`}
          />
        )}
      </div>

      {state.kind === 'reclaimed' ? (
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          This position was wound up
          {lock.reclaimedTokensBurned && (
            <> - {formatTokenAmount(BigInt(lock.reclaimedTokensBurned))} {symbol} burned</>
          )}
          {lock.reclaimedEth && <> and {formatEth(BigInt(lock.reclaimedEth))} ETH sent to the treasury</>}.
        </p>
      ) : (
        <ReclaimNote reclaim={reclaim} />
      )}
    </>
  )
}

/**
 * Why the position can or cannot be reclaimed right now.
 *
 * ⚠️ `LPLock` returns a NAMED blocker enum rather than a boolean precisely so this can say WHICH
 * condition is outstanding. "Not yet reclaimable" is the answer being deliberately avoided: it
 * conflates a permanent lock with a term that has three days left, and it hides the case that
 * actually surprises people - an expired lock held open indefinitely by the pool's own trading.
 */
function ReclaimNote({ reclaim }: { reclaim: ReturnType<typeof useReclaimStatus> }) {
  if (reclaim.unknownBlocker) {
    return (
      <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
        The lock reported a status this page does not recognise. Read it on the explorer.
      </p>
    )
  }
  if (reclaim.blocker === undefined) {
    // ⚠️ An unread verdict is not a verdict. Rendering the optimistic case here would tell a reader
    // liquidity is safely locked on the strength of a call that never returned.
    return (
      <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
        {reclaim.isError ? 'Reclaim status unavailable.' : 'Checking reclaim status…'}
      </p>
    )
  }

  const copy = reclaimBlockerCopy(reclaim.blocker)
  const showQuiet =
    reclaim.blocker === ReclaimBlocker.PoolActive &&
    reclaim.secondsSinceActivity !== undefined &&
    reclaim.inactivityPeriod !== undefined

  return (
    <div style={{ marginTop: 'var(--s-2)' }}>
      <div className="kv-label">{copy.label}</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4, marginBottom: 0 }}>
        {copy.detail}
        {showQuiet && (
          <>
            {' '}
            Last traded {formatDuration(BigInt(reclaim.secondsSinceActivity!))} ago; it must be quiet
            for {formatDuration(BigInt(reclaim.inactivityPeriod!))}.
          </>
        )}
      </p>
    </div>
  )
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="kv">
      <div className="kv-label">{label}</div>
      <div className="kv-value">{value}</div>
    </div>
  )
}
