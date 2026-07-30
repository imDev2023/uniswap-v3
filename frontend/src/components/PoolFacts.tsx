import type { Address } from 'viem'
import { useReadContract } from 'wagmi'
import { uniswapV3PoolAbi } from '../abi/uniswapV3Pool'
import { WETH9_ADDRESS } from '../config/chain'
import { POOL_FEE_TIER } from '../config/constants'
import { explorerAddressUrl, shortAddress } from '../lib/format'
import { spotPriceFromSqrtX96, tokenIsToken0 } from '../lib/swap'
import { Price } from './Price'

/**
 * Market facts for a graduated pool, read straight from the chain.
 *
 * The swap page used to show no market data at all - an amount box floating in an empty page, with
 * no way to tell what a token was worth before committing to a quote. Everything here comes from
 * RPC (`slot0` on the pool, plus addresses already resolved by useOnchainToken), so it survives an
 * indexer outage exactly like the swap panel beside it does.
 */
export function PoolFacts({
  token,
  symbol,
  pool,
  explorer,
}: {
  token: Address
  symbol: string
  pool: Address
  explorer: string
}) {
  const { data: slot0 } = useReadContract({
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: 'slot0',
    query: { refetchInterval: 8_000 },
  })

  const sqrtPriceX96 = slot0?.[0]
  const spot =
    sqrtPriceX96 !== undefined
      ? spotPriceFromSqrtX96(sqrtPriceX96, tokenIsToken0(token, WETH9_ADDRESS))
      : undefined

  return (
    <div className="pool-facts">
      <div className="pool-fact">
        <span className="pool-fact-label">Price</span>
        <span className="pool-fact-value">
          {spot ? (
            // The float carries far more digits than a price can actually have; scaling to the same
            // 1e18 fixed point the curve uses keeps this rendering identical to every other price
            // in the product rather than inventing a second notation for pool prices.
            <Price priceX18={BigInt(Math.round(spot.wethPerToken * 1e18))} />
          ) : (
            <span className="num">…</span>
          )}
        </span>
      </div>

      <div className="pool-fact">
        <span className="pool-fact-label">Pool fee</span>
        <span className="pool-fact-value num">{POOL_FEE_TIER / 10_000}%</span>
      </div>

      <div className="pool-fact">
        <span className="pool-fact-label">Liquidity</span>
        <span className="pool-fact-value">
          <span className="badge badge-grad">Locked forever</span>
        </span>
      </div>

      <div className="pool-fact">
        <span className="pool-fact-label">Pool</span>
        <span className="pool-fact-value">
          <a
            className="link-accent num"
            href={explorerAddressUrl(explorer, pool)}
            target="_blank"
            rel="noreferrer"
          >
            {shortAddress(pool)}
          </a>
        </span>
      </div>

      <p className="pool-facts-note">
        1 {symbol} at the pool's current spot price. Your quote below includes the fee and price
        impact.
      </p>
    </div>
  )
}
