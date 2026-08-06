import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LockCard } from './LockCard'
import { VestingCard } from './VestingCard'
import { PERMANENT_LOCK_UNTIL, ReclaimBlocker } from '../lib/lock'
import type { LockRow } from '../lib/subgraph'

const CREATOR = '0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C'
const STRANGER = '0x52eEF29c3c869B4D04F3c1451b16548DEAA923bE'
const TOKEN = '0x52eEF29c3c869B4D04F3c1451b16548DEAA923bE' as const
const POOL = '0xDC27FeCB8589c0FB0328fd98963c823a1681E933' as const

const NOW = 1_800_000_000
const YEAR = 31_536_000n
const THIRTY_DAYS = 2_592_000n
const T = 10n ** 18n
const FORTY_MILLION = 40_000_000n * T

const reclaimStatus = vi.fn()
vi.mock('../hooks/useReclaimStatus', () => ({
  useReclaimStatus: (...a: unknown[]) => reclaimStatus(...a),
}))

const connected = vi.fn()
const writeContract = vi.fn()
vi.mock('wagmi', () => ({
  useAccount: () => connected(),
  useReadContracts: () => ({ data: undefined }),
  useWriteContract: () => ({ writeContract, data: undefined, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isLoading: false }),
}))

vi.mock('../hooks/usePeriphery', () => ({
  usePeriphery: () => ({ devVesting: '0x0000000000000000000000000000000000000042', lpLock: undefined }),
}))

function lock(over: Partial<LockRow> = {}): LockRow {
  return {
    id: '77',
    pool: POOL,
    origin: 'Launch',
    lockUntil: String(BigInt(NOW) + YEAR),
    permanent: false,
    creatorFeeBps: 7000,
    extendCount: 0,
    reclaimed: false,
    reclaimedEth: null,
    reclaimedTokensBurned: null,
    reclaimedAtTimestamp: null,
    collectionCount: 0,
    creatorFees0: '0',
    creatorFees1: '0',
    treasuryFees0: '0',
    treasuryFees1: '0',
    collections: [],
    ...over,
  }
}

function status(over: Partial<ReturnType<typeof import('../hooks/useReclaimStatus').useReclaimStatus>> = {}) {
  reclaimStatus.mockReturnValue({
    blocker: ReclaimBlocker.NotExpired,
    secondsSinceActivity: undefined,
    inactivityPeriod: 15_552_000,
    unknownBlocker: false,
    isError: false,
    ...over,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  status()
  connected.mockReturnValue({ address: undefined, isConnected: false })
})

describe('LockCard', () => {
  it('never says a default lock is forever', () => {
    // ⚠️ ADR-0005 retired the permanent-lock claim, and the default case is the case almost every
    // launch is in. "Locked forever" was live in seven places and was wrong in all of them.
    const { container } = render(
      <LockCard
        lock={null}
        lockDuration={YEAR}
        permanentLockChoice={false}
        creatorFeeBps={7000}
        graduated={false}
        pool={undefined}
        nowSeconds={NOW}
        symbol="RDOGE"
      />,
    )
    expect(container.textContent).not.toMatch(/forever/i)
    expect(screen.getByText('1 year')).toBeInTheDocument()
    expect(screen.getByText(/never shorten it/i)).toBeInTheDocument()
  })

  it('renders a permanent lock as permanent, not as the year 584942417355', () => {
    // ⚠️ There is no permanent flag on-chain; it is the `type(uint64).max` sentinel. A card that
    // subtracted `now` from it would count down for the next 584 billion years.
    const { container } = render(
      <LockCard
        lock={lock({ permanent: true, lockUntil: PERMANENT_LOCK_UNTIL.toString() })}
        lockDuration={YEAR}
        permanentLockChoice
        creatorFeeBps={7000}
        graduated
        pool={POOL}
        nowSeconds={NOW}
        symbol="RDOGE"
      />,
    )
    expect(screen.getByText(/locked permanently/i)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/584942417355|58494/)
  })

  it('shows a lock whose realised state diverges from the creator’s original choice', () => {
    // ⚠️ `Token.permanentLock` (the choice) and `Lock.permanent` (the realised state) are DIFFERENT
    // facts, and `extend` can turn the second true later. Neither may be mirrored onto the other.
    render(
      <LockCard
        lock={lock({ permanent: true, lockUntil: PERMANENT_LOCK_UNTIL.toString(), extendCount: 2 })}
        lockDuration={YEAR}
        permanentLockChoice={false}
        creatorFeeBps={7000}
        graduated
        pool={POOL}
        nowSeconds={NOW}
        symbol="RDOGE"
      />,
    )
    // The term reflects the choice; the status reflects what extend() actually did.
    expect(screen.getByText('1 year')).toBeInTheDocument()
    expect(screen.getByText(/locked permanently/i)).toBeInTheDocument()
    expect(screen.getByText('2 times')).toBeInTheDocument()
  })

  it('says WHICH condition holds an expired lock open, not merely "not yet"', () => {
    // ⚠️ The whole reason `LPLock` returns a named enum. An expired lock held open indefinitely by
    // the pool's own trading is the case that surprises people.
    status({ blocker: ReclaimBlocker.PoolActive, secondsSinceActivity: 86_400 })
    render(
      <LockCard
        lock={lock({ lockUntil: String(BigInt(NOW) - 100n) })}
        lockDuration={YEAR}
        permanentLockChoice={false}
        creatorFeeBps={7000}
        graduated
        pool={POOL}
        nowSeconds={NOW}
        symbol="RDOGE"
      />,
    )
    expect(screen.getByText(/pool is still active/i)).toBeInTheDocument()
    expect(screen.getByText(/last traded 1 day ago/i)).toBeInTheDocument()
  })

  it('does not claim liquidity is safely locked when the reclaim read never landed', () => {
    // ⚠️ An unread verdict is not a verdict. Rendering the optimistic case here would reassure a
    // reader about locked liquidity on the strength of a call that failed.
    status({ blocker: undefined, isError: true })
    const { container } = render(
      <LockCard
        lock={lock()}
        lockDuration={YEAR}
        permanentLockChoice={false}
        creatorFeeBps={7000}
        graduated
        pool={POOL}
        nowSeconds={NOW}
        symbol="RDOGE"
      />,
    )
    expect(screen.getByText(/reclaim status unavailable/i)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/reclaimable now/i)
  })

  // ⚠️ "unread", not "unindexed": these terms come from `useLaunchTerms` over RPC and the indexer is
  // not on the path at all. The old name was residue from before #37 moved them onto the chain.
  it('reports unread terms as unknown rather than as "none" and "0%"', () => {
    // ⚠️ A zero here is a claim, not a blank: "Term: none" on this panel says the liquidity is not
    // locked, which is the worst available lie about a lock that certainly exists on-chain.
    const { container } = render(
      <LockCard
        lock={null}
        lockDuration={undefined}
        permanentLockChoice={undefined}
        creatorFeeBps={undefined}
        graduated={false}
        pool={undefined}
        nowSeconds={NOW}
        symbol="RDOGE"
      />,
    )
    expect(container.textContent).not.toMatch(/none/i)
    expect(container.textContent).not.toMatch(/0% of the locked position/)
    expect(screen.getByText(/still frozen on-chain and still binding/i)).toBeInTheDocument()
  })

  it('reports a reclaimed position as reclaimed, with what actually left', () => {
    render(
      <LockCard
        lock={lock({
          reclaimed: true,
          reclaimedEth: '2000000000000000000',
          reclaimedTokensBurned: (900_000_000n * T).toString(),
        })}
        lockDuration={YEAR}
        permanentLockChoice={false}
        creatorFeeBps={7000}
        graduated
        pool={POOL}
        nowSeconds={NOW}
        symbol="RDOGE"
      />,
    )
    expect(screen.getByText('Reclaimed')).toBeInTheDocument()
    expect(screen.getByText(/900M RDOGE burned/)).toBeInTheDocument()
    expect(screen.getByText(/2 ETH sent to the treasury/)).toBeInTheDocument()
  })
})

describe('VestingCard', () => {
  const terms = {
    allocation: FORTY_MILLION,
    duration: THIRTY_DAYS,
    graduatedAt: BigInt(NOW) - THIRTY_DAYS / 2n,
    claimed: 0n,
  }

  it('renders nothing at all when the launch took no carve', () => {
    // ⚠️ `vestingDuration` is populated for EVERY launch, including those with no allocation - it
    // records the terms that would have applied. Keying off it would put a vesting panel describing
    // a grant that does not exist on every launch on the board.
    const { container } = render(
      <VestingCard
        token={TOKEN}
        terms={{ ...terms, allocation: 0n }}
        creator={CREATOR}
        claimable={0n}
        symbol="RDOGE"
        nowSeconds={NOW}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('does not announce an unreadable schedule as fully vested and releasable', () => {
    // ⚠️ The worst thing this card can say, and it was reachable today: `DevVesting` has never been
    // deployed, so the vault read fails while the factory's carve read succeeds. An unknown duration
    // collapsed to `0n` lands in the `complete` branch, and a graduated 5% launch announced itself
    // as "40M (100%)" and "Fully vested. The whole allocation is now releasable."
    const { container } = render(
      <VestingCard
        token={TOKEN}
        terms={{ ...terms, duration: undefined }}
        creator={CREATOR}
        claimable={undefined}
        symbol="RDOGE"
        nowSeconds={NOW}
      />,
    )
    expect(container.textContent).not.toMatch(/100%/)
    expect(container.textContent).not.toMatch(/fully vested/i)
    expect(container.textContent).not.toMatch(/releasable/i)
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    // The grant itself IS known and still worth disclosing - only the schedule is missing.
    expect(screen.getByText(/40M RDOGE/)).toBeInTheDocument()
  })

  it('says the schedule has not started, and may never, before graduation', () => {
    // ⚠️ ADR-0007's whole point: most launches never graduate, so this grant may never release.
    render(
      <VestingCard
        token={TOKEN}
        terms={{ ...terms, graduatedAt: null }}
        creator={CREATOR}
        claimable={0n}
        symbol="RDOGE"
        nowSeconds={NOW}
      />,
    )
    expect(screen.getByText(/nothing has vested/i)).toBeInTheDocument()
    expect(screen.getByText(/never receives any of it/i)).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('does not claim a launch never graduated when the graduation date is merely unread', () => {
    // ⚠️ The defect this state exists for. `graduatedAt` used to come from the indexed row, so with
    // graph-node down an unread date fell through to `not-started` and a launch that graduated a
    // month ago told its reader "if this curve never graduates, the creator never receives any of
    // it" - a specific, confident falsehood about a schedule already running. `undefined` is now a
    // state of its own and must never render the not-started copy.
    render(
      <VestingCard
        token={TOKEN}
        terms={{ ...terms, graduatedAt: undefined }}
        creator={CREATOR}
        claimable={undefined}
        symbol="RDOGE"
        nowSeconds={NOW}
      />,
    )
    expect(screen.queryByText(/never receives any of it/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/nothing has vested/i)).not.toBeInTheDocument()
    // Nor may it assert the opposite: no progress figure can be honest without a start date.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
    // The grant and its terms are still known and still disclosed.
    expect(screen.getByText(/40M RDOGE/)).toBeInTheDocument()
  })

  it('keeps the creator’s claim button when the graduation date is unread', () => {
    // ⚠️ `claimable` is its own read against the vault and does not depend on the graduation date,
    // so the button must survive a failure of anything else on the card. It used to live inside the
    // schedule branch, which meant one unread value withdrew it from the only person it serves.
    connected.mockReturnValue({ address: CREATOR, isConnected: true, chainId: 46630 })
    render(
      <VestingCard
        token={TOKEN}
        terms={{ ...terms, graduatedAt: undefined }}
        creator={CREATOR}
        claimable={FORTY_MILLION / 2n}
        symbol="RDOGE"
        nowSeconds={NOW}
      />,
    )
    expect(screen.getByRole('button', { name: /claim vested tokens/i })).toBeEnabled()
  })

  it('shows a ticking vested figure computed from the terms, not read from the indexer', () => {
    const claimable = FORTY_MILLION / 2n
    // There is deliberately no `devVestedSoFar` field. Half a 30-day schedule elapsed is half the
    // grant, and it must move with the clock rather than with the last indexed event.
    render(
      <VestingCard token={TOKEN} terms={terms} creator={CREATOR} claimable={claimable} symbol="RDOGE" nowSeconds={NOW} />,
    )
    expect(screen.getByText(/20M \(50%\)/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
  })

  it('offers the claim button to the creator only', () => {
    // `claim` pays `grant.creator` and takes no recipient, so a stranger's click would spend gas to
    // benefit someone else with no explanation on screen.
    const claimable = FORTY_MILLION / 2n
    connected.mockReturnValue({ address: STRANGER, isConnected: true, chainId: 46630 })
    const { rerender } = render(
      <VestingCard token={TOKEN} terms={terms} creator={CREATOR} claimable={claimable} symbol="RDOGE" nowSeconds={NOW} />,
    )
    expect(screen.queryByRole('button', { name: /claim/i })).not.toBeInTheDocument()

    connected.mockReturnValue({ address: CREATOR, isConnected: true, chainId: 46630 })
    rerender(
      <VestingCard token={TOKEN} terms={terms} creator={CREATOR} claimable={claimable} symbol="RDOGE" nowSeconds={NOW} />,
    )
    expect(screen.getByRole('button', { name: /claim vested tokens/i })).toBeEnabled()
  })

  it('offers the CHAIN’s claimable figure, not the one it computed', () => {
    // ⚠️ The two answer different questions: the schedule says what has vested by the browser's
    // clock, `claimable` says what `claim` will pay at the head block. Here the creator has already
    // claimed everything vested, so the button must refuse even though 50% shows as vested.
    const claimable = 0n
    connected.mockReturnValue({ address: CREATOR, isConnected: true, chainId: 46630 })
    render(
      <VestingCard token={TOKEN} terms={terms} creator={CREATOR} claimable={claimable} symbol="RDOGE" nowSeconds={NOW} />,
    )
    expect(screen.getByText(/20M \(50%\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /nothing to claim yet/i })).toBeDisabled()
  })
})
