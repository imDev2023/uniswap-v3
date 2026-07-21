import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { activeChain } from '../config/chain'
import { shortAddress } from '../lib/format'

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()

  const injected = connectors.find((c) => c.type === 'injected') ?? connectors[0]
  const wrongChain = isConnected && chainId !== activeChain.id

  if (!isConnected) {
    return (
      <button
        className="btn btn-connect"
        disabled={isPending || !injected}
        onClick={() => injected && connect({ connector: injected })}
      >
        {isPending ? 'Connecting…' : 'Connect wallet'}
      </button>
    )
  }

  if (wrongChain) {
    return (
      <button className="btn btn-warn" onClick={() => switchChain({ chainId: activeChain.id })}>
        Switch to {activeChain.name}
      </button>
    )
  }

  return (
    <button className="btn btn-account" onClick={() => disconnect()} title="Disconnect">
      <span className="dot-online" />
      {shortAddress(address!)}
    </button>
  )
}
