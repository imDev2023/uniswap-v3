import { parseEther } from 'viem'

/**
 * Parse a user-typed decimal string into 18-decimal wei, or null if it isn't a valid amount.
 * Both native ETH and the 18-decimal LaunchToken share this — parseEther is the 18-decimal parser.
 */
export function parseAmount18(input: string): bigint | null {
  if (!input || input === '.') return null
  try {
    return parseEther(input)
  } catch {
    return null
  }
}
