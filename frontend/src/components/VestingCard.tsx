import type { Address } from 'viem'
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { devVestingAbi } from '../abi/devVesting'
import { usePeriphery } from '../hooks/usePeriphery'
import { useWrongChain } from '../hooks/useWrongChain'
import { shortReason } from '../lib/errors'
import { formatDuration, formatPercent, formatTokenAmount } from '../lib/format'
import { vestingState, type VestingInput } from '../lib/vesting'

/**
 * The creator's dev allocation and its release schedule (#35 / ADR-0007).
 *
 * ⚠️ **Rendered only when a carve actually exists.** A vesting duration is recorded for every
 * launch, including those that took no allocation - it describes the terms that would have applied,
 * not a live schedule. Keying off it instead of off the allocation would show a vesting panel on
 * every launch on the board, each describing a grant that does not exist.
 *
 * ⚠️ **The vested figure is computed here, and there is deliberately no stored field to read.** Vested-so-far is a continuous function of wall-clock time, and a subgraph only
 * writes when an event fires, so a stored figure would sit frozen between trades - most wrong on a
 * quiet launch, which is exactly where a reader would trust it. See `lib/vesting.ts`.
 */
export function VestingCard({
  token,
  terms,
  creator,
  claimable: onchainClaimable,
  symbol,
  nowSeconds,
}: {
  token: Address
  terms: VestingInput
  /**
   * The grant's beneficiary, read off the grant itself.
   *
   * ⚠️ `claim` takes no recipient and pays this address, frozen at creation. Deciding who sees a
   * claim button from anywhere else is deciding it from a source merely expected to agree.
   */
  creator: string | undefined
  /**
   * What `claim` would pay right now, read from the chain.
   *
   * ⚠️ Deliberately NOT the client-computed figure above them. The two answer different questions:
   * the schedule says what has vested by the browser's clock, this says what the transaction will
   * actually pay at the head block. Offering a button for a number `claim` then refuses is the
   * failure this avoids.
   */
  claimable: bigint | undefined
  symbol: string
  nowSeconds: number
}) {
  const { address, isConnected } = useAccount()
  const wrongChain = useWrongChain()
  const { devVesting } = usePeriphery()

  const state = vestingState(terms, BigInt(nowSeconds))
  const isCreator = !!address && !!creator && address.toLowerCase() === creator.toLowerCase()

  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract()
  const { isLoading: isMining } = useWaitForTransactionReceipt({ hash: txHash })

  if (state.kind === 'none') return null

  return (
    <div className="card">
      <p className="section-title">Creator allocation</p>

      <div className="kv-grid">
        <Kv label="Granted" value={`${formatTokenAmount(state.allocation)} ${symbol}`} />
        <Kv
          label="Vests over"
          value={state.kind === 'terms-unknown' ? 'unknown' : formatDuration(state.duration)}
        />
      </div>

      {state.kind === 'terms-unknown' ? (
        /* ⚠️ Its own branch, and it must stay one. An unread duration collapsed to `0n` lands in
           `complete` and announces an untouched carve as 100% vested and fully releasable, which
           inverts ADR-0007 on the panel that exists to disclose it. Reachable today: `DevVesting`
           has never been deployed, so the vault read fails while the factory's carve read succeeds. */
        <p className="muted" style={{ marginBottom: 0 }}>
          The vesting schedule for this carve could not be read, so how much has released is unknown.
          The terms are still fixed on-chain.
        </p>
      ) : state.kind === 'schedule-unknown' ? (
        /* ⚠️ Says nothing about whether the schedule has started, because we do not know. Folded
           into `not-started` - which is where an unread date used to land - this rendered a launch
           that graduated a month ago as one that had never graduated, and told its creator they
           would receive nothing unless it did. The claim block below still appears, because
           `claimable` is read straight from the vault and does not depend on this. */
        <p className="muted" style={{ marginBottom: 0 }}>
          Whether this launch has graduated could not be read, so the release schedule cannot be
          placed on a timeline. The grant and its terms above are fixed on-chain either way.
        </p>
      ) : state.kind === 'not-started' ? (
        /* ⚠️ The single most important sentence on this card. Vesting runs from GRADUATION, never
           from creation, so on a curve that never graduates this grant never releases anything at
           all - and most launches never graduate (ADR-0007). A reader who assumes a clock is already
           running would price in sell pressure that cannot arrive.
           ⚠️ Only reachable once graduation is KNOWN to be absent - see `schedule-unknown`. */
        <p className="muted" style={{ marginBottom: 0 }}>
          Nothing has vested and nothing is releasing yet. The schedule starts <strong>at
          graduation</strong>, not at creation - so if this curve never graduates, the creator never
          receives any of it.
        </p>
      ) : (
        <>
          <div className="kv-grid" style={{ marginTop: 'var(--s-3)' }}>
            <Kv
              label="Vested so far"
              value={`${formatTokenAmount(state.vested)} (${formatPercent(
                state.kind === 'complete' ? 1 : state.fraction,
              )})`}
            />
            <Kv label="Claimed" value={formatTokenAmount(state.claimed)} />
          </div>

          <div
            className="progress-track"
            role="progressbar"
            aria-label="Vesting progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((state.kind === 'complete' ? 1 : state.fraction) * 100)}
            style={{ marginTop: 'var(--s-3)', marginBottom: 'var(--s-2)' }}
          >
            <div
              className="progress-fill"
              style={{ width: `${(state.kind === 'complete' ? 1 : state.fraction) * 100}%` }}
            />
          </div>

          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
            {state.kind === 'complete'
              ? 'Fully vested. The whole allocation is now releasable.'
              : 'Releasing linearly since graduation. Vesting delays the creator’s ability to sell; it does not prevent it.'}
          </p>
        </>
      )}

      {/* ⚠️ Outside the schedule branch on purpose. `claimable` is its own read against the vault
          and does not depend on the duration, the graduation date, or the indexer, so gating the
          button on any of them withdraws it from the creator precisely when a read has failed -
          the defect this card was rewritten to remove, in its last remaining hiding place. On a
          launch that genuinely has not graduated the vault returns zero and the button says so. */}
      {isCreator && (
        <div style={{ marginTop: 'var(--s-4)' }}>
          <div className="quote-line">
            <span>Claimable now</span>
            {/* ⚠️ An unread balance is not a zero balance. Rendering "0" here tells the one
                person it matters to that they have nothing coming, on the strength of a call
                that has not returned. */}
            <span className="num">
              {onchainClaimable === undefined ? '…' : `${formatTokenAmount(onchainClaimable)} ${symbol}`}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!isConnected || wrongChain || !onchainClaimable || isPending || isMining || !devVesting}
            onClick={() => {
              if (!devVesting) return
              reset()
              writeContract({
                address: devVesting,
                abi: devVestingAbi,
                functionName: 'claim',
                args: [token],
              })
            }}
          >
            {isPending
              ? 'Confirm in wallet…'
              : isMining
                ? 'Claiming…'
                : onchainClaimable === undefined
                  ? 'Checking claimable balance…'
                  : onchainClaimable === 0n
                    ? 'Nothing to claim yet'
                    : 'Claim vested tokens'}
          </button>
          {writeError && <div className="error-text">{shortReason(writeError.message)}</div>}
        </div>
      )}
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
