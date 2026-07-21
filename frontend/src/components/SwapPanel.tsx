import { useEffect, useState } from 'react'
import { encodeFunctionData, formatUnits, type Address } from 'viem'
import {
  useAccount,
  useBalance,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { erc20Abi } from '../abi/erc20'
import { swapRouterAbi } from '../abi/swapRouter'
import { uniswapV3PoolAbi } from '../abi/uniswapV3Pool'
import { WETH9_ADDRESS } from '../config/chain'
import { TOKEN_DECIMALS } from '../config/constants'
import { SWAP_ROUTER_ADDRESS, isSwapConfigured } from '../config/contracts'
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

// Swap a graduated TOKEN/WETH pool through the platform's own v3-periphery SwapRouter (#21). No
// Quoter is deployed, so output is ESTIMATED from the pool's live slot0 spot price (ignoring price
// impact) and clearly labelled; on-chain safety comes from the slippage-derived amountOutMinimum.
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

  // --- live spot price from the pool ---
  const { data: slot0 } = useReadContract({
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: 'slot0',
    query: { enabled: isSwapConfigured, refetchInterval: 8_000 },
  })
  const sqrtPriceX96 = slot0?.[0]
  const spot = sqrtPriceX96 !== undefined ? spotPriceFromSqrtX96(sqrtPriceX96, tokenIs0) : undefined
  const outPerIn = spot ? (dir === 'ethToToken' ? spot.tokenPerWeth : spot.wethPerToken) : 0
  const estOut = enabled && spot ? estimateAmountOut(parsed, outPerIn) : undefined
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

  const payLabel = dir === 'ethToToken' ? 'You pay (ETH)' : `You pay (${symbol})`
  const recvSymbol = dir === 'ethToToken' ? symbol : 'ETH'
  const bal = dir === 'ethToToken' ? ethBalance?.value : (tokenBalance as bigint | undefined)

  return (
    <div className="card">
      <div className="row-between" style={{ marginBottom: 16 }}>
        <p className="section-title" style={{ margin: 0 }}>
          Swap
        </p>
        <button
          className="pill"
          onClick={() => setDir((d) => (d === 'ethToToken' ? 'tokenToEth' : 'ethToToken'))}
        >
          ⇅ flip
        </button>
      </div>

      <div className="field">
        <label>{payLabel}</label>
        <input
          className="input-amount num"
          inputMode="decimal"
          placeholder="0.0"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
        />
        {bal !== undefined && (
          <div className="pill-row">
            {/* No "max" on the ETH leg — spending the whole balance leaves nothing for gas. */}
            {dir === 'tokenToEth' && (
              <button className="pill" onClick={() => setAmount(formatUnits(bal, TOKEN_DECIMALS))}>
                max
              </button>
            )}
            <span className="pill" style={{ cursor: 'default' }}>
              bal{' '}
              {dir === 'ethToToken'
                ? `${formatEth(bal)} ETH`
                : `${formatTokenAmount(bal)} ${symbol}`}
            </span>
          </div>
        )}
      </div>

      {enabled && (
        <div style={{ margin: '12px 0' }}>
          <div className="quote-line">
            <span>You receive (est.)</span>
            <span className="num">
              {estOut !== undefined
                ? recvSymbol === 'ETH'
                  ? `${formatEth(estOut, 6)} ETH`
                  : `${formatTokenAmount(estOut)} ${symbol}`
                : '…'}
            </span>
          </div>
          <div className="quote-line">
            <span>Minimum received</span>
            <span className="num">
              {recvSymbol === 'ETH'
                ? `${formatEth(minOut, 6)} ETH`
                : `${formatTokenAmount(minOut)} ${symbol}`}
            </span>
          </div>
          <div className="quote-line">
            <span>Max slippage</span>
            <SlippageSelector value={slippagePct} onChange={setSlippagePct} />
          </div>
          <div className="hint">
            Spot-price estimate (excludes price impact) — the trade is protected by your slippage
            limit. 1% pool fee applies.
          </div>
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
