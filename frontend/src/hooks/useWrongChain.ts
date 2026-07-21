import { useAccount } from 'wagmi'
import { activeChain } from '../config/chain'

/** True when a wallet is connected but pointed at a chain other than the configured target. */
export function useWrongChain(): boolean {
  const { isConnected, chainId } = useAccount()
  return isConnected && chainId !== activeChain.id
}
