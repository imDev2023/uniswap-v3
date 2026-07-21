import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseEventLogs } from 'viem'
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { launchpadFactoryAbi } from '../abi/launchpadFactory'
import { FACTORY_ADDRESS, isLaunchpadConfigured } from '../config/contracts'
import { activeChain } from '../config/chain'
import { shortReason } from '../lib/errors'
import { formatEth } from '../lib/format'
import { setTokenImage } from '../lib/tokenMeta'
import { useWrongChain } from '../hooks/useWrongChain'
import { ConnectButton } from '../components/ConnectButton'

const SYMBOL_RE = /^[A-Za-z0-9]{1,11}$/

export function CreatePage() {
  const navigate = useNavigate()
  const { isConnected } = useAccount()
  const wrongChain = useWrongChain()

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [image, setImage] = useState('')

  const { data: creationFee } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: launchpadFactoryAbi,
    functionName: 'creationFee',
    query: { enabled: isLaunchpadConfigured },
  })

  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract()
  const { data: receipt, isLoading: isMining } = useWaitForTransactionReceipt({ hash: txHash })

  const nameError = name.trim().length === 0 ? 'Required' : name.length > 32 ? 'Too long' : ''
  const symbolError = !SYMBOL_RE.test(symbol) ? '1–11 letters/numbers' : ''
  const canSubmit =
    isConnected && !wrongChain && !nameError && !symbolError && creationFee !== undefined

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit || creationFee === undefined) return
    reset()
    writeContract({
      address: FACTORY_ADDRESS,
      abi: launchpadFactoryAbi,
      functionName: 'createLaunch',
      args: [name.trim(), symbol.trim().toUpperCase()],
      value: creationFee,
    })
  }

  // When the tx confirms, pull the new token address out of LaunchCreated, persist the image
  // client-side (no on-chain image field in v1), and jump to the token page.
  const newToken = useMemo(() => {
    if (!receipt) return undefined
    const logs = parseEventLogs({
      abi: launchpadFactoryAbi,
      eventName: 'LaunchCreated',
      logs: receipt.logs,
    })
    return logs[0]?.args.token
  }, [receipt])

  useEffect(() => {
    if (!newToken) return
    if (image.trim()) setTokenImage(newToken, image)
    navigate(`/token/${newToken}`)
  }, [newToken, image, navigate])

  if (!isLaunchpadConfigured) {
    return <p className="center-note">Launching is disabled until the contracts are configured.</p>
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      <h1 style={{ fontSize: 26, marginBottom: 6 }}>Launch a token</h1>
      <p className="muted" style={{ marginTop: 0, marginBottom: 24 }}>
        Fixed 1B supply, no pre-mine, no upfront liquidity. It trades on a bonding curve and
        graduates automatically into a permanently-locked Uniswap V3 pool.
      </p>

      <form className="card" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="name">Token name</label>
          <input
            id="name"
            className="input"
            placeholder="e.g. Robinhood Doge"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
          {name && nameError && <div className="error-text">{nameError}</div>}
        </div>

        <div className="field">
          <label htmlFor="symbol">Symbol</label>
          <input
            id="symbol"
            className="input"
            placeholder="e.g. RDOGE"
            value={symbol}
            maxLength={11}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          />
          {symbol && symbolError && <div className="error-text">{symbolError}</div>}
        </div>

        <div className="field">
          <label htmlFor="image">Image URL (optional)</label>
          <input
            id="image"
            className="input"
            placeholder="https://…"
            value={image}
            onChange={(e) => setImage(e.target.value)}
          />
          <div className="hint">
            Stored in your browser for v1 — there’s no on-chain image field yet.
          </div>
        </div>

        <div className="quote-line" style={{ margin: '4px 0 16px' }}>
          <span>Creation fee</span>
          <span className="num">
            {creationFee !== undefined ? `${formatEth(creationFee)} ETH` : '…'}
          </span>
        </div>

        {!isConnected ? (
          <ConnectButton />
        ) : wrongChain ? (
          <button type="button" className="btn btn-warn" style={{ width: '100%' }} disabled>
            Switch to {activeChain.name} to launch
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!canSubmit || isPending || isMining}>
            {isPending ? 'Confirm in wallet…' : isMining ? 'Launching…' : 'Launch token'}
          </button>
        )}

        {writeError && <div className="error-text">{shortReason(writeError.message)}</div>}
      </form>
    </div>
  )
}
