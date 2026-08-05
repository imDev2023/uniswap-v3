import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CurvePositionsCard } from './CurvePositionsCard'
import type { CurvePositionRow } from '../lib/subgraph'

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }))

const CREATOR = '0x8Ec5f1e04531416d337E61733DfC5d1685D9A80C'
const STRANGER = '0x52eEF29c3c869B4D04F3c1451b16548DEAA923bE'

const T = 10n ** 18n
/** A 5% carve on an 800M curve supply - the largest the contract permits. */
const FORTY_MILLION = 40_000_000n * T
/** The curve allocation left after that carve. */
const CARVED_ALLOCATION = 760_000_000n * T

function position(account: string, balance: bigint): CurvePositionRow {
  return {
    id: `t-${account}`,
    account,
    balance: balance.toString(),
    bought: balance.toString(),
    sold: '0',
    tradeCount: 1,
    lastTradeTimestamp: '1000',
  }
}

describe('creator concentration', () => {
  it('does NOT read 0% for a creator holding the largest carve the protocol allows', () => {
    // ⚠️ The defect this panel existed to disclose and could not see. A dev allocation is a free
    // carve, not a curve buy, so it emits no `Bought` and produced no row here - a creator holding
    // 40M tokens rendered as "0" on the panel a buyer reads specifically to judge concentration.
    render(
      <CurvePositionsCard
        positions={[]}
        creator={CREATOR}
        curveAllocation={CARVED_ALLOCATION}
        devAllocation={FORTY_MILLION}
        devClaimed={0n}
        graduated={false}
      />,
    )

    expect(screen.getByText('40M')).toBeInTheDocument()
    expect(screen.queryByText(/^0%/)).not.toBeInTheDocument()
    expect(screen.getByText(/dev allocation/i)).toBeInTheDocument()
  })

  it('shows granted and released as TWO numbers, because they diverge for the whole window', () => {
    // Settled 2026-08-05. Granted alone overstates near-term sell pressure; released alone reads as
    // nothing at all on a launch whose supply is already entirely spoken for.
    render(
      <CurvePositionsCard
        positions={[]}
        creator={CREATOR}
        curveAllocation={CARVED_ALLOCATION}
        devAllocation={FORTY_MILLION}
        devClaimed={10_000_000n * T}
        graduated
      />,
    )

    expect(screen.getByText('40M')).toBeInTheDocument()
    expect(screen.getByText(/10M released/i)).toBeInTheDocument()
  })

  it('still shows "0 released" during the window rather than hiding it', () => {
    // Hiding it leaves the granted figure looking like tokens already sitting in a wallet.
    render(
      <CurvePositionsCard
        positions={[]}
        creator={CREATOR}
        curveAllocation={CARVED_ALLOCATION}
        devAllocation={FORTY_MILLION}
        devClaimed={0n}
        graduated
      />,
    )
    expect(screen.getByText(/0 released/i)).toBeInTheDocument()
  })

  it('says plainly that no carve was taken, rather than showing a zero', () => {
    render(
      <CurvePositionsCard
        positions={[]}
        creator={CREATOR}
        curveAllocation={800_000_000n * T}
        devAllocation={0n}
        devClaimed={0n}
        graduated={false}
      />,
    )
    expect(screen.getByText(/no dev allocation taken/i)).toBeInTheDocument()
    expect(screen.queryByText(/dev allocation ·/i)).not.toBeInTheDocument()
  })

  it('measures the carve against this launch’s OWN carved allocation', () => {
    // ⚠️ Since #34 the denominator is per launch. Dividing 40M by the 800M constant understates the
    // creator's share on exactly the launches where it is largest - 5.0% instead of 5.3%.
    render(
      <CurvePositionsCard
        positions={[]}
        creator={CREATOR}
        curveAllocation={CARVED_ALLOCATION}
        devAllocation={FORTY_MILLION}
        devClaimed={0n}
        graduated={false}
      />,
    )
    // ⚠️ And the LABEL names that denominator. The creator picks the carve in bps of the 800M
    // CURVE_SUPPLY constant, so 5% is 40M - but measured against this launch's own 760M allocation
    // the same 40M is 5.3%. Calling it "of curve supply" made this page contradict the 5.00% the
    // create form had just quoted for the identical launch.
    expect(screen.getByText(/5\.3% of\s*the curve allocation/i)).toBeInTheDocument()
  })

  it('rebuilds the denominator from the chain carve when the indexed allocation is missing', () => {
    // ⚠️ `curveAllocation` comes from the indexed row and `devAllocation` over RPC, so an indexer
    // outage leaves the exact carve in hand and the denominator absent. Defaulting to the 800M
    // constant there printed 5.00% for a launch that is 5.3% concentrated - the ADR-0006 error, in
    // the direction that flatters the launch, on the panel that exists to disclose concentration.
    // `curveAllocation == CURVE_SUPPLY - devAllocation` exactly, so nothing has to be guessed.
    render(
      <CurvePositionsCard
        positions={[]}
        creator={CREATOR}
        curveAllocation={undefined}
        devAllocation={FORTY_MILLION}
        devClaimed={0n}
        graduated={false}
      />,
    )
    expect(screen.getByText(/5\.3% of\s*the curve allocation/i)).toBeInTheDocument()
    expect(screen.queryByText(/5\.0% of/i)).not.toBeInTheDocument()
  })
})

describe('an UNREAD carve is not an absent carve', () => {
  it('says the allocation could not be read rather than "none"', () => {
    // ⚠️ Same class as the lock panel's "Term: none". A failed read printed as a confident absence
    // is the worst available answer on the panel that exists to disclose concentration.
    const { container } = render(
      <CurvePositionsCard
        positions={[]}
        creator={CREATOR}
        devAllocation={undefined}
        devClaimed={undefined}
        graduated={false}
      />,
    )
    expect(container.textContent).not.toMatch(/no dev allocation taken/i)
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
  })
})

describe('final versus current', () => {
  it('marks a graduated launch’s positions as FINAL', () => {
    // ⚠️ The curve stops trading forever at graduation, so every position freezes - while the real
    // holders change with every pool swap. Without this the panel presents a snapshot of who once
    // bought on a closed curve as a statement about who holds the token today.
    render(
      <CurvePositionsCard
        positions={[position(STRANGER, 1000n * T)]}
        creator={CREATOR}
        devAllocation={0n}
        devClaimed={0n}
        graduated
      />,
    )
    expect(screen.getByText(/final\./i)).toBeInTheDocument()
    expect(screen.getByText(/can never change again/i)).toBeInTheDocument()
  })

  it('does not call a live curve’s positions final', () => {
    render(
      <CurvePositionsCard
        positions={[position(STRANGER, 1000n * T)]}
        creator={CREATOR}
        devAllocation={0n}
        devClaimed={0n}
        graduated={false}
      />,
    )
    expect(screen.queryByText(/final\./i)).not.toBeInTheDocument()
    expect(screen.getByText(/net tokens bought from the curve/i)).toBeInTheDocument()
  })

  it('never calls these rows holders', () => {
    // #36 renamed the entity; #37 owns the words. The model ignores transfers entirely, so "holder"
    // is a claim it cannot support in any phase of a launch's life.
    const { container } = render(
      <CurvePositionsCard
        positions={[position(STRANGER, 1000n * T)]}
        creator={CREATOR}
        devAllocation={0n}
        devClaimed={0n}
        graduated={false}
      />,
    )
    // "token holders" appears once, in the sentence explaining what this is NOT - and only after
    // graduation. On a live curve the word must not appear at all.
    expect(container.textContent).not.toMatch(/holder/i)
  })
})
