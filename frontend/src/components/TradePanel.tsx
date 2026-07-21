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

export function TradePanel({
  token,
  curve,
  symbol,
  graduated,
}: {
  token: Address
  curve: Address
  symbol: string
  graduated: boolean
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
    query: { enabled: enabled && side === 'buy' && !graduated },
  })
  const { data: sellQuote } = useReadContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'quoteSell',
    args: enabled && side === 'sell' ? [parsed] : undefined,
    query: { enabled: enabled && side === 'sell' && !graduated },
  })

  // --- anti-snipe context ---
  const { data: capActive } = useReadContract({
    address: curve,
    abi: bondingCurveAbi,
    functionName: 'buyCapActive',
    query: { enabled: !graduated },
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
    query: { enabled: !!address && !graduated },
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

  if (graduated) {
    return (
      <div className="card">
        <p className="section-title">Trade</p>
        <p className="muted">
          This token has graduated. Curve trading is closed — trade it on the DEX pool instead.
        </p>
      </div>
    )
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

      <div className="field">
        <label>{side === 'buy' ? 'You pay (ETH)' : `You sell (${symbol})`}</label>
        <input
          className="input-amount num"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
        />
        {side === 'sell' && tokenBalance !== undefined && (
          <div className="pill-row">
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
            <span className="pill" style={{ cursor: 'default' }}>
              bal {formatTokenAmount(tokenBalance)}
            </span>
          </div>
        )}
      </div>

      {enabled && (
        <div style={{ margin: '12px 0' }}>
          {side === 'buy' ? (
            <>
              <div className="quote-line">
                <span>You receive</span>
                <span className="num">
                  {tokensOut !== undefined ? `${formatTokenAmount(tokensOut)} ${symbol}` : '…'}
                </span>
              </div>
              <div className="quote-line">
                <span>Curve fee</span>
                <span className="num">{buyFee !== undefined ? `${formatEth(buyFee, 6)} ETH` : '…'}</span>
              </div>
            </>
          ) : (
            <>
              <div className="quote-line">
                <span>You receive</span>
                <span className="num">{ethOut !== undefined ? `${formatEth(ethOut, 6)} ETH` : '…'}</span>
              </div>
              <div className="quote-line">
                <span>Curve fee</span>
                <span className="num">{sellFee !== undefined ? `${formatEth(sellFee, 6)} ETH` : '…'}</span>
              </div>
            </>
          )}
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
        <ConnectButton />
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
