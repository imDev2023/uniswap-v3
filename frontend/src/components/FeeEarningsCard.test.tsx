import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FeeEarningsCard } from './FeeEarningsCard'
import type { LockRow } from '../lib/subgraph'
import type { ClaimableFees } from '../hooks/useClaimableFees'

const claimable = vi.fn()
vi.mock('../hooks/useClaimableFees', () => ({
  useClaimableFees: (...a: unknown[]) => claimable(...a),
}))

// The indexed lifetime totals arrive in the pool's token0/token1 ordering, so the card needs this to
// label them. Default true (launch token is token0); individual tests override it.
const poolOrder = vi.fn()
vi.mock('../hooks/usePoolTokenOrder', () => ({
  usePoolTokenOrder: (...a: unknown[]) => poolOrder(...a),
}))

const TOKEN = '0x1111111111111111111111111111111111111111' as const
const POOL = '0x6666666666666666666666666666666666666666' as const
const NOW = 1_800_000_000

function lock(over: Partial<LockRow> = {}): LockRow {
  return {
    id: '77',
    pool: POOL,
    origin: 'Launch',
    lockUntil: '99999999999',
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

function accrued(over: Partial<ClaimableFees> = {}): ClaimableFees {
  return {
    creatorToken: undefined,
    creatorWeth: undefined,
    treasuryToken: undefined,
    treasuryWeth: undefined,
    isError: false,
    ...over,
  }
}

function renderCard(over: {
  lock?: LockRow | null
  positionTokenId?: bigint | null | undefined
  creatorFeeBps?: number | undefined
  graduated?: boolean
} = {}) {
  return render(
    <FeeEarningsCard
      lock={over.lock === undefined ? lock() : over.lock}
      positionTokenId={'positionTokenId' in over ? over.positionTokenId : 77n}
      token={TOKEN}
      pool={POOL}
      creatorFeeBps={'creatorFeeBps' in over ? over.creatorFeeBps : 7000}
      graduated={over.graduated ?? true}
      symbol="TEST"
      nowSeconds={NOW}
    />,
  )
}

beforeEach(() => {
  // ⚠️ mockClear, not just mockReturnValue. `toHaveBeenCalledWith` matches ANY recorded call, so
  // without this the calls from earlier tests persist and an argument assertion passes on somebody
  // else's call - which is how the tokenId-wiring test below first passed against the very defect it
  // was written to catch. Confirmed by mutation.
  claimable.mockClear()
  poolOrder.mockClear()
  claimable.mockReturnValue(accrued())
  poolOrder.mockReturnValue(true)
})

describe('FeeEarningsCard', () => {
  it('renders nothing before graduation, when no position exists to earn anything', () => {
    const { container } = renderCard({ graduated: false })
    expect(container).toBeEmptyDOMElement()
  })

  it('names the denominator as the locked position, not the pool', () => {
    // "70% of pool fees" overstates the creator's take by a third: the protocol fee comes off the
    // top before the locked position accrues anything.
    renderCard()
    expect(screen.getByText(/70% of the fees this locked position earns/)).toBeInTheDocument()
  })

  it('⚠️ zero collections says nothing has been COLLECTED, never that nothing was earned', () => {
    // The distinction the whole card exists for. `collect` is permissionless, so no collection is
    // an ordinary state and says nothing at all about what the position has earned.
    renderCard({ lock: lock({ collectionCount: 0 }) })

    expect(screen.getByText(/Nothing has been collected yet/)).toBeInTheDocument()
    expect(screen.queryByText(/earned nothing/i)).not.toBeInTheDocument()
  })

  it('shows lifetime earnings in both assets once a collection has happened', () => {
    renderCard({
      lock: lock({
        collectionCount: 2,
        creatorFees0: '1500000000000000000000',
        creatorFees1: '700000000000000',
        treasuryFees0: '642857142857142857142',
        treasuryFees1: '300000000000000',
      }),
    })

    expect(screen.getByText(/Over 2 collections/)).toBeInTheDocument()
    // Both assets, neither summed into the other.
    expect(screen.getByText('TEST')).toBeInTheDocument()
    expect(screen.getByText(/Treasury received/)).toBeInTheDocument()
  })

  it('⚠️ labels the last collection as SENT BY, because the event carries no msg.sender', () => {
    renderCard({
      lock: lock({
        collectionCount: 1,
        creatorFees0: '100',
        creatorFees1: '100',
        collections: [
          {
            id: '0xabc-1',
            sentBy: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            collectedAtTimestamp: String(NOW - 3600),
          },
        ],
      }),
    })

    expect(screen.getByText(/sent by/)).toBeInTheDocument()
    // "collected by" would assert something the event cannot support.
    expect(screen.queryByText(/collected by/i)).not.toBeInTheDocument()
  })

  it('⚠️ an unread accrued figure reads as not-known, never as zero', () => {
    // Zero is a real answer here - a position with no accrued fees - so an unread value that
    // rendered as zero would be indistinguishable from a true one.
    claimable.mockReturnValue(accrued())
    renderCard()

    expect(screen.getByText(/Reading the position…/)).toBeInTheDocument()
    expect(screen.queryByText(/^0 ETH$/)).not.toBeInTheDocument()
  })

  it('a failed chain read says so instead of reporting nothing owed', () => {
    claimable.mockReturnValue(accrued({ isError: true }))
    renderCard()

    expect(screen.getByText(/Could not be read from the chain right now/)).toBeInTheDocument()
  })

  it('shows a genuine zero accrued as zero, distinct from the unread state', () => {
    claimable.mockReturnValue(
      accrued({ creatorToken: 0n, creatorWeth: 0n, treasuryToken: 0n, treasuryWeth: 0n }),
    )
    renderCard()

    expect(screen.queryByText(/Reading the position…/)).not.toBeInTheDocument()
    expect(screen.getByText(/Anyone can trigger a collection/)).toBeInTheDocument()
  })

  it('⚠️ a missing indexed row does not render realised earnings as zero', () => {
    // Graduated with no Lock entity is an indexer gap. Reporting "0 collected" would state a
    // creator's realised earnings on the strength of a subsystem that has not caught up.
    renderCard({ lock: null })

    expect(screen.getByText(/Not indexed yet/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing has been collected yet/)).not.toBeInTheDocument()
  })

  it('⚠️ an unread fee share reads as unknown rather than 0%', () => {
    renderCard({ creatorFeeBps: undefined })
    expect(screen.getByText(/unknown of the fees/)).toBeInTheDocument()
  })

  it('⚠️ still reads the chain for accrued fees when the indexed row is missing', () => {
    // ⚠️ The assertion is on the ARGUMENT, not on the mock's return. An earlier version of this test
    // mocked `useClaimableFees` wholesale and asserted its output, so it stayed green while the card
    // derived its tokenId from `lock.id` - meaning an indexer outage silently disabled the chain
    // read entirely. The mock can never fail that way; only the tokenId passed to it can.
    claimable.mockReturnValue(accrued({ creatorToken: 5n, creatorWeth: 5n, treasuryToken: 2n, treasuryWeth: 2n }))
    renderCard({ lock: null, positionTokenId: 77n })

    expect(claimable).toHaveBeenCalledWith(77n, POOL, TOKEN, 7000)
    expect(screen.getByText(/Anyone can trigger a collection/)).toBeInTheDocument()
    expect(screen.getByText(/Not indexed yet/)).toBeInTheDocument()
  })

  it('⚠️ names the treasury share on the accrued side, not only after a collection', () => {
    // Settled decision 1 is a 70/30 split, and the state this card exists for is "fees accrued,
    // nothing ever collected" - where quoting only the creator's 70% leaves its denominator invisible.
    claimable.mockReturnValue(
      accrued({ creatorToken: 700n, creatorWeth: 700n, treasuryToken: 300n, treasuryWeth: 300n }),
    )
    renderCard()

    expect(screen.getByText(/treasury's share is a further/)).toBeInTheDocument()
  })

  it('⚠️ a reclaimed position reads as terminal, not as a transient read failure', () => {
    // After reclaim the position no longer exists, so simulating collect reverts forever. Rendering
    // that as "could not be read right now" invites the reader to wait for something never coming.
    claimable.mockReturnValue(accrued({ isError: true }))
    renderCard({ lock: lock({ reclaimed: true }) })

    expect(screen.getByText(/wound up, so nothing accrues any more/)).toBeInTheDocument()
    expect(screen.queryByText(/Could not be read from the chain right now/)).not.toBeInTheDocument()
  })

  it('⚠️ an ungraduated launch has no position, so nothing is read for it', () => {
    renderCard({ graduated: false, positionTokenId: null })
    expect(claimable).toHaveBeenCalledWith(undefined, POOL, TOKEN, 7000)
  })

  it('⚠️ labels the indexed lifetime amounts by the POOL ordering, not by position', () => {
    // The indexer stores amount0/amount1 verbatim and refuses to guess which is which - the call
    // that would tell it deadlocks the subgraph against our pruning RPC. So this card does the
    // attribution, and getting it backwards reports the creator's WETH as launch tokens.
    // Here the launch token is token1, so creatorFees1 is the TOKEN amount.
    poolOrder.mockReturnValue(false)
    const { container } = renderCard({
      lock: lock({
        collectionCount: 1,
        creatorFees0: '5000000000000000', // WETH
        creatorFees1: '9000000000000000000000', // the launch token
        treasuryFees0: '1',
        treasuryFees1: '1',
      }),
    })

    // 9K TEST and 0.005 ETH. Swapped, the same fixture renders "0.005 TEST" and "9000 ETH", so both
    // halves are asserted - either one alone would pass against the swap.
    expect(container.textContent).toMatch(/9K\s*TEST/)
    expect(container.textContent).toMatch(/0\.005\s*ETH/)
  })

  it('⚠️ an unread pool ordering leaves the collected amounts unlabelled rather than guessed', () => {
    // Defaulting to "token0" would be right half the time and confidently wrong the rest.
    poolOrder.mockReturnValue(undefined)
    renderCard({
      lock: lock({ collectionCount: 1, creatorFees0: '5000000000000000', creatorFees1: '9000' }),
    })

    expect(screen.getByText(/token order could not be read/)).toBeInTheDocument()
    expect(screen.queryByText(/Treasury received/)).not.toBeInTheDocument()
  })
})
