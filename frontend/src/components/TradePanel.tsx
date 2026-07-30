import { useEffect, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { bondingCurveAbi } from '../abi/bondingCurve'
import { erc20Abi } from '../abi/erc20'
import { TOKEN_DECIMALS } from '../config/constants'
import { parseAmount18 } from '../lib/amount'
import { applySlippage, withinBuyCap } from '../lib/curve'
import { shortReason } from '../lib/errors'
import { formatEth, formatTokenAmount } from '../lib/format'
import { useWrongChain } from '../hooks/useWrongChain'
import { ConnectButton } from './ConnectButton'
import { SlippageSelector } from './SlippageSelector'

type Side = 'buy' | 'sell'

// Only ever rendered for a live curve: TokenPage shows a single "Graduated" card instead once the
// curve closes, so this panel no longer carries a graduated branch of its own.
export function TradePanel({
  token,
  curve,
  symbol,
}: {
  token: Address
  curve: Address
  symbol: string
}) {
  const { address, isConnected } = useAccount()
  const [side, setSide] = useState<Side>('buy')
  const [amount, setAmount] = useState('')
  const [slippagePct, setSlippagePct] = useState(5)
  // Which kind of tx is in flight, so the success message can tell an approval from a real trade.
  const [action, setAction] = useState<'approve' | 'trade' | null>(null)

  const parsed = parseAmount18(amount)
  const enabled = parsed !== null && parsed > 0n

  // --- on-chain quotes (live, from the curve) ---
  const { data: buyQuote } = useReadContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'quoteBuy',
    args: enabled && side === 'buy' ? [parsed] : undefined,
    query: { enabled: enabled && side === 'buy' },
  })
  const { data: sellQuote } = useReadContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'quoteSell',
    args: enabled && side === 'sell' ? [parsed] : undefined,
    query: { enabled: enabled && side === 'sell' },
  })

  // --- anti-snipe context ---
  const { data: capActive } = useReadContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'buyCapActive',
  })
  const { data: maxBuy } = useReadContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'maxBuyPerWallet',
  })
  // Cumulative tokens this wallet has already bought from the curve — the on-chain cap is on the
  // running total, not a single buy (BondingCurve.sol: purchased = purchasedOf[buyer] + tokensOut).
  const { data: purchased, refetch: refetchPurchased } = useReadContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'purchasedOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })

  // --- balances / allowance ---
  const { data: tokenBalance, refetch: refetchBalance } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, curve] : undefined,
    query: { enabled: !!address },
  })

  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  // Refresh reads once a trade/approval confirms.
  useEffect(() => {
    if (isSuccess) {
      refetchBalance()
      refetchAllowance()
      refetchPurchased()
    }
  }, [isSuccess, refetchBalance, refetchAllowance, refetchPurchased])

  const wrongChain = useWrongChain()
  const needsApproval =
    side === 'sell' && enabled && allowance !== undefined && allowance < parsed!

  const tokensOut = buyQuote?.[0]
  const buyFee = buyQuote?.[1]
  const ethOut = sellQuote?.[0]
  const sellFee = sellQuote?.[1]

  // The receiving leg shows one figure whichever side is active. `null` means "quote not in yet",
  // which must render differently from a real zero - a greyed placeholder, not a confident 0.0.
  const receiveText = !enabled
    ? null
    : side === 'buy'
      ? tokensOut !== undefined
        ? formatTokenAmount(tokensOut)
        : null
      : ethOut !== undefined
        ? formatEth(ethOut, 6)
        : null

  const feeText = !enabled
    ? null
    : side === 'buy'
      ? buyFee !== undefined
        ? formatEth(buyFee, 6)
        : null
      : sellFee !== undefined
        ? formatEth(sellFee, 6)
        : null

  // Warn when this buy would push the wallet's *cumulative* purchases past the anti-snipe cap.
  const capWarning =
    side === 'buy' &&
    capActive === true &&
    tokensOut !== undefined &&
    maxBuy !== undefined &&
    !withinBuyCap(purchased ?? 0n, tokensOut, maxBuy, true)

  function onBuy() {
    if (!enabled || tokensOut === undefined) return
    reset()
    setAction('trade')
    writeContract({
      address: curve,
      abi: bondingCurveAbi,
      functionName: 'buy',
      args: [applySlippage(tokensOut, slippagePct * 100)],
      value: parsed!,
    })
  }

  function onSell() {
    if (!enabled || ethOut === undefined) return
    reset()
    setAction('trade')
    writeContract({
      address: curve,
      abi: bondingCurveAbi,
      functionName: 'sell',
      args: [parsed!, applySlippage(ethOut, slippagePct * 100)],
    })
  }

  function onApprove() {
    if (!enabled) return
    reset()
    setAction('approve')
    writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [curve, parsed!],
    })
  }

  return (
    <div className="card">
      <div className="tabs">
        <button
          className={`tab ${side === 'buy' ? 'active-buy' : ''}`}
          onClick={() => setSide('buy')}
        >
          Buy
        </button>
        <button
          className={`tab ${side === 'sell' ? 'active-sell' : ''}`}
          onClick={() => setSide('sell')}
        >
          Sell
        </button>
      </div>

      <div className="legs">
        <div className="leg">
          <label className="leg-label" htmlFor="trade-pay">
            {side === 'buy' ? 'You pay' : 'You sell'}
          </label>
          <div className="leg-row">
            <input
              id="trade-pay"
              className="leg-amount"
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            />
            <span className="leg-asset">{side === 'buy' ? 'ETH' : symbol}</span>
          </div>
          <div className="leg-meta">
            {side === 'sell' && tokenBalance !== undefined && (
              <>
                <span>bal {formatTokenAmount(tokenBalance)}</span>
                <span className="leg-meta-right" style={{ display: 'flex', gap: 'var(--s-2)' }}>
                  {[25, 50, 100].map((pct) => (
                    <button
                      key={pct}
                      className="pill"
                      onClick={() =>
                        setAmount(formatUnits((tokenBalance * BigInt(pct)) / 100n, TOKEN_DECIMALS))
                      }
                    >
                      {pct}%
                    </button>
                  ))}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Deliberately NOT a flip control: buy and sell are separate curve entry points with
            different approval and cap rules, so the tabs above own direction. */}
        <div className="leg">
          <span className="leg-label">You receive</span>
          <div className="leg-row">
            <span
              className={`leg-amount leg-amount-out${receiveText === null ? ' leg-amount-pending' : ''}`}
            >
              {receiveText ?? '0.0'}
            </span>
            <span className="leg-asset">{side === 'buy' ? symbol : 'ETH'}</span>
          </div>
          <div className="leg-meta">
            {enabled && feeText !== null && <span>curve fee {feeText} ETH</span>}
          </div>
        </div>
      </div>

      {enabled && (
        <div style={{ marginBottom: 'var(--s-4)' }}>
          <div className="quote-line">
            <span>Max slippage</span>
            <SlippageSelector value={slippagePct} onChange={setSlippagePct} />
          </div>
        </div>
      )}

      {capWarning && (
        <div className="hint" style={{ color: 'var(--warn)' }}>
          Anti-snipe cap is active: max {maxBuy !== undefined ? formatTokenAmount(maxBuy) : '…'}{' '}
          {symbol} per wallet during the early curve
          {purchased && purchased > 0n ? ` (you hold ${formatTokenAmount(purchased)})` : ''}. Reduce
          your buy.
        </div>
      )}

      {!isConnected ? (
        <ConnectButton block />
      ) : wrongChain ? (
        <button className="btn btn-warn" style={{ width: '100%' }} disabled>
          Wrong network
        </button>
      ) : needsApproval ? (
        <button className="btn btn-primary" onClick={onApprove} disabled={isPending || isMining}>
          {isPending || isMining ? 'Approving…' : `Approve ${symbol}`}
        </button>
      ) : (
        <button
          className={`btn ${side === 'buy' ? 'btn-buy' : 'btn-sell'}`}
          style={{ width: '100%', padding: 13 }}
          onClick={side === 'buy' ? onBuy : onSell}
          disabled={!enabled || isPending || isMining || capWarning}
        >
          {isPending
            ? 'Confirm in wallet…'
            : isMining
              ? 'Processing…'
              : side === 'buy'
                ? `Buy ${symbol}`
                : `Sell ${symbol}`}
        </button>
      )}

      {writeError && <div className="error-text">{shortReason(writeError.message, 140)}</div>}
      {isSuccess && action === 'approve' && (
        <div className="success-text">Approved — you can sell now.</div>
      )}
      {isSuccess && action === 'trade' && <div className="success-text">Trade confirmed.</div>}
    </div>
  )
}
