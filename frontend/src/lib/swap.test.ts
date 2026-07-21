import { describe, expect, it } from 'vitest'
import { parseEther } from 'viem'
import {
  buildExactInputSingle,
  estimateAmountOut,
  spotPriceFromSqrtX96,
  tokenIsToken0,
} from './swap'
import { POOL_FEE_TIER } from '../config/constants'

const Q96 = 2n ** 96n

describe('tokenIsToken0', () => {
  it('is true when the token address sorts before WETH', () => {
    expect(
      tokenIsToken0(
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
      ),
    ).toBe(true)
  })
  it('is false when WETH sorts first', () => {
    expect(
      tokenIsToken0(
        '0x00000000000000000000000000000000000000f0',
        '0x0000000000000000000000000000000000000002',
      ),
    ).toBe(false)
  })
})

describe('spotPriceFromSqrtX96', () => {
  it('reads a 1:1 pool symmetrically', () => {
    const p = spotPriceFromSqrtX96(Q96, true)
    expect(p.wethPerToken).toBeCloseTo(1, 9)
    expect(p.tokenPerWeth).toBeCloseTo(1, 9)
  })

  it('interprets token1/token0 per the token ordering', () => {
    // sqrtPriceX96 for price token1/token0 = 4  →  sqrt = 2  →  sqrtPriceX96 = 2 * 2^96
    const sqrtP = 2n * Q96
    // token is token0: token1(=WETH) per token0(=TOKEN) = 4  → 4 WETH per TOKEN
    const asToken0 = spotPriceFromSqrtX96(sqrtP, true)
    expect(asToken0.wethPerToken).toBeCloseTo(4, 6)
    expect(asToken0.tokenPerWeth).toBeCloseTo(0.25, 6)
    // token is token1: token1(=TOKEN) per token0(=WETH) = 4 → 4 TOKEN per WETH
    const asToken1 = spotPriceFromSqrtX96(sqrtP, false)
    expect(asToken1.tokenPerWeth).toBeCloseTo(4, 6)
    expect(asToken1.wethPerToken).toBeCloseTo(0.25, 6)
  })

  it('returns zero for a zero price', () => {
    expect(spotPriceFromSqrtX96(0n, true)).toEqual({ wethPerToken: 0, tokenPerWeth: 0 })
  })
})

describe('estimateAmountOut', () => {
  it('multiplies amountIn by the output-per-input price', () => {
    // 1 ETH at 1000 TOKEN/ETH → 1000 TOKEN
    expect(estimateAmountOut(parseEther('1'), 1000)).toBe(parseEther('1000'))
    // 2 ETH at 0.5 → 1
    expect(estimateAmountOut(parseEther('2'), 0.5)).toBe(parseEther('1'))
  })
  it('returns zero for non-positive inputs', () => {
    expect(estimateAmountOut(0n, 1000)).toBe(0n)
    expect(estimateAmountOut(parseEther('1'), 0)).toBe(0n)
  })
})

describe('buildExactInputSingle', () => {
  const weth = '0x000000000000000000000000000000000000000a'
  const token = '0x000000000000000000000000000000000000000b'
  const user = '0x000000000000000000000000000000000000000c'

  it('always pins the 1% graduated-pool fee tier and no price limit', () => {
    const p = buildExactInputSingle({
      tokenIn: weth,
      tokenOut: token,
      recipient: user,
      deadline: 123n,
      amountIn: parseEther('1'),
      amountOutMinimum: parseEther('0.9'),
    })
    expect(p.fee).toBe(POOL_FEE_TIER)
    expect(p.fee).toBe(10_000)
    expect(p.sqrtPriceLimitX96).toBe(0n)
    expect(p).toMatchObject({
      tokenIn: weth,
      tokenOut: token,
      recipient: user,
      deadline: 123n,
      amountIn: parseEther('1'),
      amountOutMinimum: parseEther('0.9'),
    })
  })
})
