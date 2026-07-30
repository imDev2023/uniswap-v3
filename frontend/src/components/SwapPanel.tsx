import { useEffect, useState } from 'react'
import { encodeFunctionData, formatUnits, type Address } from 'viem'
import {
  useAccount,
  useBalance,
  useReadContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { erc20Abi } from '../abi/erc20'
import { quoterV2Abi } from '../abi/quoterV2'
import { swapRouterAbi } from '../abi/swapRouter'
import { uniswapV3PoolAbi } from '../abi/uniswapV3Pool'
import { WETH9_ADDRESS } from '../config/chain'
import { POOL_FEE_TIER, TOKEN_DECIMALS } from '../config/constants'
import {
  QUOTER_ADDRESS,
  SWAP_ROUTER_ADDRESS,
  isQuoterConfigured,
  isSwapConfigured,
} from '../config/contracts'
import { parseAmount18 } from '../lib/amount'
import { applySlippage } from '../lib/curve'
import { shortReason } from '../lib/errors'
import { formatEth, formatTokenAmount } from '../lib/format'
import {
  buildExactInputSingle,
  estimateAmountOut,
  spotPriceFromSqrtX96,
  tokenIsToken0,
} from '../lib/swap'
import { useWrongChain } from '../hooks/useWrongChain'
import { ConnectButton } from './ConnectButton'
import { SlippageSelector } from './SlippageSelector'

type Dir = 'ethToToken' | 'tokenToEth'

const DEADLINE_SECONDS = 1200

// Swap a graduated TOKEN/WETH pool through the platform's own v3-periphery SwapRouter (#21).
//
// Output comes from our own QuoterV2 when VITE_QUOTER_ADDRESS is set — an exact figure including the
// 1% fee and price impact, verified against real execution in contracts/test/QuoterV2.t.sol. When it
// is unset (older deployments, preview mode) the panel falls back to the pool's slot0 spot price,
// which is optimistic and is labelled as an estimate. Either way, on-chain safety comes from the
// slippage-derived amountOutMinimum.
export function SwapPanel({
  token,
  symbol,
  pool,
}: {
  token: Address
  symbol: string
  pool: Address
}) {
  const { address, isConnected } = useAccount()
  const wrongChain = useWrongChain()
  const [dir, setDir] = useState<Dir>('ethToToken')
  const [amount, setAmount] = useState('')
  const [slippagePct, setSlippagePct] = useState(3)
  const [action, setAction] = useState<'approve' | 'swap' | null>(null)

  const parsed = parseAmount18(amount)
  const enabled = parsed !== null && parsed > 0n
  const tokenIs0 = tokenIsToken0(token, WETH9_ADDRESS)

  const tokenIn = dir === 'ethToToken' ? WETH9_ADDRESS : token
  const tokenOut = dir === 'ethToToken' ? token : WETH9_ADDRESS

  // --- exact quote from our own QuoterV2 (preferred) ---
  // quoteExactInputSingle is non-view — it swaps and reverts with the result — so it must go through
  // eth_call. useSimulateContract does exactly that and surfaces the decoded return in `data.result`.
  const { data: quoteSim, isFetching: isQuoting } = useSimulateContract({
    address: QUOTER_ADDRESS,
    abi: quoterV2Abi,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn,
        tokenOut,
        amountIn: parsed ?? 0n,
        fee: POOL_FEE_TIER,
        sqrtPriceLimitX96: 0n,
      },
    ],
    query: { enabled: isSwapConfigured && isQuoterConfigured && enabled, refetchInterval: 8_000 },
  })
  const quotedOut = quoteSim?.result?.[0]

  // --- fallback: live spot price from the pool (optimistic; ignores fee and price impact) ---
  const { data: slot0 } = useReadContract({
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: 'slot0',
    query: { enabled: isSwapConfigured && !isQuoterConfigured, refetchInterval: 8_000 },
  })
  const sqrtPriceX96 = slot0?.[0]
  const spot = sqrtPriceX96 !== undefined ? spotPriceFromSqrtX96(sqrtPriceX96, tokenIs0) : undefined
  const outPerIn = spot ? (dir === 'ethToToken' ? spot.tokenPerWeth : spot.wethPerToken) : 0
  const spotOut = enabled && spot ? estimateAmountOut(parsed, outPerIn) : undefined

  const estOut = isQuoterConfigured ? quotedOut : spotOut
  const isExactQuote = isQuoterConfigured && quotedOut !== undefined
  const minOut = estOut !== undefined ? applySlippage(estOut, slippagePct * 100) : 0n

  // --- balances / allowance ---
  const { data: ethBalance } = useBalance({ address })
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
    args: address ? [address, SWAP_ROUTER_ADDRESS] : undefined,
    query: { enabled: !!address && isSwapConfigured },
  })

  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract()
  const { isLoading: isMining, isSuccess } = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (isSuccess) {
      refetchBalance()
      refetchAllowance()
    }
  }, [isSuccess, refetchBalance, refetchAllowance])

  const needsApproval =
    dir === 'tokenToEth' && enabled && allowance !== undefined && allowance < parsed!

  function deadline(): bigint {
    return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)
  }

  function onApprove() {
    if (!enabled) return
    reset()
    setAction('approve')
    writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [SWAP_ROUTER_ADDRESS, parsed!],
    })
  }

  function onSwap() {
    if (!enabled || estOut === undefined) return
    reset()
    setAction('swap')
    if (dir === 'ethToToken') {
      writeContract({
        address: SWAP_ROUTER_ADDRESS,
        abi: swapRouterAbi,
        functionName: 'exactInputSingle',
        args: [
          buildExactInputSingle({
            tokenIn: WETH9_ADDRESS,
            tokenOut: token,
            recipient: address!,
            deadline: deadline(),
            amountIn: parsed!,
            amountOutMinimum: minOut,
          }),
        ],
        value: parsed!,
      })
    } else {
      // TOKEN → ETH: swap TOKEN→WETH into the router, then unwrap WETH→ETH to the user, atomically.
      const swapData = encodeFunctionData({
        abi: swapRouterAbi,
        functionName: 'exactInputSingle',
        args: [
          buildExactInputSingle({
            tokenIn: token,
            tokenOut: WETH9_ADDRESS,
            recipient: SWAP_ROUTER_ADDRESS,
            deadline: deadline(),
            amountIn: parsed!,
            amountOutMinimum: minOut,
          }),
        ],
      })
      const unwrapData = encodeFunctionData({
        abi: swapRouterAbi,
        functionName: 'unwrapWETH9',
        args: [minOut, address!],
      })
      writeContract({
        address: SWAP_ROUTER_ADDRESS,
        abi: swapRouterAbi,
        functionName: 'multicall',
        args: [[swapData, unwrapData]],
      })
    }
  }

  if (!isSwapConfigured) {
    return (
      <div className="card">
        <p className="section-title">Swap</p>
        <p className="muted">
          The swap router isn’t configured for this build. Set <code>VITE_SWAP_ROUTER_ADDRESS</code>{' '}
          after deploying the platform’s V3 stack.
        </p>
      </div>
    )
  }

  const paySymbol = dir === 'ethToToken' ? 'ETH' : symbol
  const recvSymbol = dir === 'ethToToken' ? symbol : 'ETH'
  const bal = dir === 'ethToToken' ? ethBalance?.value : (tokenBalance as bigint | undefined)

  const formatOut = (v: bigint) =>
    recvSymbol === 'ETH' ? formatEth(v, 6) : formatTokenAmount(v)

  return (
    <div className="card">
      <p className="section-title">Swap</p>

      <div className="legs">
        <div className="leg">
          <label className="leg-label" htmlFor="swap-pay">
            You pay
          </label>
          <div className="leg-row">
            <input
              id="swap-pay"
              className="leg-amount"
              inputMode="decimal"
              placeholder="0.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            />
            <span className="leg-asset">{paySymbol}</span>
          </div>
          <div className="leg-meta">
            {bal !== undefined && (
              <>
                <span>
                  bal{' '}
                  {dir === 'ethToToken'
                    ? `${formatEth(bal)} ETH`
                    : `${formatTokenAmount(bal)} ${symbol}`}
                </span>
                {/* No "max" on the ETH leg — spending the whole balance leaves nothing for gas. */}
                {dir === 'tokenToEth' && (
                  <button
                    className="pill leg-meta-right"
                    onClick={() => setAmount(formatUnits(bal, TOKEN_DECIMALS))}
                  >
                    max
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        <button
          className="leg-flip"
          aria-label={`Swap direction to pay ${recvSymbol}`}
          onClick={() => setDir((d) => (d === 'ethToToken' ? 'tokenToEth' : 'ethToToken'))}
        >
          ⇅
        </button>

        <div className="leg">
          <span className="leg-label">
            You receive{!isExactQuote && estOut !== undefined ? ' (est.)' : ''}
          </span>
          <div className="leg-row">
            <span
              className={`leg-amount leg-amount-out${estOut === undefined ? ' leg-amount-pending' : ''}`}
            >
              {estOut !== undefined ? formatOut(estOut) : enabled && isQuoting ? '…' : '0.0'}
            </span>
            <span className="leg-asset">{recvSymbol}</span>
          </div>
          <div className="leg-meta">
            {enabled && estOut !== undefined && (
              <span>
                min {formatOut(minOut)} {recvSymbol} after slippage
              </span>
            )}
          </div>
        </div>
      </div>

      {enabled && (
        <div style={{ marginBottom: 'var(--s-4)' }}>
          <div className="quote-line">
            <span>Max slippage</span>
            <SlippageSelector value={slippagePct} onChange={setSlippagePct} />
          </div>
          <div className="hint">
            {isExactQuote
              ? 'Exact quote from the pool, including the 1% fee and price impact. The trade is still protected by your slippage limit.'
              : 'Spot-price estimate (excludes price impact) — the trade is protected by your slippage limit. 1% pool fee applies.'}
          </div>
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
          className="btn btn-primary"
          onClick={onSwap}
          disabled={!enabled || estOut === undefined || isPending || isMining}
        >
          {isPending ? 'Confirm in wallet…' : isMining ? 'Swapping…' : 'Swap'}
        </button>
      )}

      {writeError && <div className="error-text">{shortReason(writeError.message, 140)}</div>}
      {isSuccess && action === 'approve' && (
        <div className="success-text">Approved — you can swap now.</div>
      )}
      {isSuccess && action === 'swap' && <div className="success-text">Swap confirmed.</div>}
    </div>
  )
}
