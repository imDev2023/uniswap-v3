import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseEventLogs } from 'viem'
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { launchpadFactoryAbi } from '../abi/launchpadFactory'
import { FACTORY_ADDRESS, isLaunchpadConfigured } from '../config/contracts'
import { activeChain } from '../config/chain'
import { shortReason } from '../lib/errors'
import { formatEth } from '../lib/format'
import { useWrongChain } from '../hooks/useWrongChain'
import { ConnectButton } from '../components/ConnectButton'

const SYMBOL_RE = /^[A-Za-z0-9]{1,11}$/

export function CreatePage() {
  const navigate = useNavigate()
  const { isConnected } = useAccount()
  const wrongChain = useWrongChain()

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  // Goes on-chain, permanently. v1 is "bring your own URI": the creator supplies one they have
  // already pinned. Uploading and pinning on the creator's behalf needs a pinning API key, which
  // cannot live in a Vite bundle, so that flow needs a server-side endpoint (Stage 3).
  const [metadataURI, setMetadataURI] = useState('')

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
      args: [
        {
          name: name.trim(),
          symbol: symbol.trim().toUpperCase(),
          metadataURI: metadataURI.trim(),
          // The lock choice is not surfaced yet; #37 adds the control. Defaulting to false means the
          // standard 1-year lock, which is the reversible option - `true` is terminal.
          permanentLock: false,
          // No dev allocation until #37 surfaces the control. Zero is the no-pre-mine case, so the
          // launch a creator gets today is exactly the one they got before #34.
          devAllocationBps: 0,
        },
      ],
      value: creationFee,
    })
  }

  // When the tx confirms, pull the new token address out of LaunchCreated and jump to the token
  // page. Nothing is persisted client-side any more: the metadata URI went on-chain in #24 and is
  // resolved from there, so a launch looks the same in every browser.
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
    navigate(`/token/${newToken}`)
  }, [newToken, navigate])

  if (!isLaunchpadConfigured) {
    return <p className="center-note">Launching is disabled until the contracts are configured.</p>
  }

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      <h1 style={{ fontSize: 26, marginBottom: 6 }}>Launch a token</h1>
      <p className="muted" style={{ marginTop: 0, marginBottom: 24 }}>
        Fixed 1B supply, zero protocol allocation, no upfront liquidity. It trades on a bonding
        curve and graduates automatically into a locked Octopus pool.
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

        {/* The "Image URL" field that used to sit here is gone. It wrote to a per-browser
            localStorage map and its own hint called it "a local preview until metadata rendering
            ships" - which is this ticket. Keeping it would offer a creator an image that only they,
            on that one machine, would ever see, while the field right below it is the one that
            actually travels with the token. */}
        <div className="field">
          <label htmlFor="metadataURI">Metadata URI (optional)</label>
          <input
            id="metadataURI"
            className="input"
            placeholder="ipfs://…"
            value={metadataURI}
            onChange={(e) => setMetadataURI(e.target.value)}
          />
          <div className="hint">
            Points to a JSON document (<code>name</code>, <code>description</code>,{' '}
            <code>image</code>, <code>banner</code>, <code>links</code>). Written to the token
            contract and <strong>permanent — it can never be changed or removed</strong>, by you or
            anyone else. Leave blank to launch without metadata.
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
