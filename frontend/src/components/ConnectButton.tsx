import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { activeChain } from '../config/chain'
import { shortAddress } from '../lib/format'

/**
 * @param block Stretch to the container width. The topbar wants an inline chip; a trade panel wants
 *        a full-width call to action in the same slot the Buy/Swap button occupies once connected,
 *        so the button must not visibly change size when a wallet connects.
 */
export function ConnectButton({ block = false }: { block?: boolean } = {}) {
  const cls = block ? ' btn-block' : ''
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()

  const injected = connectors.find((c) => c.type === 'injected') ?? connectors[0]
  const wrongChain = isConnected && chainId !== activeChain.id

  if (!isConnected) {
    return (
      <button
        className={`btn btn-connect${cls}`}
        disabled={isPending || !injected}
        onClick={() => injected && connect({ connector: injected })}
      >
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    )
  }

  if (wrongChain) {
    return (
      <button className={`btn btn-warn${cls}`} onClick={() => switchChain({ chainId: activeChain.id })}>
        Switch to {activeChain.name}
      </button>
    )
  }

  return (
    <button className={`btn btn-account${cls}`} onClick={() => disconnect()} title="Disconnect">
      <span className="dot-online" />
      {shortAddress(address!)}
    </button>
  )
}
