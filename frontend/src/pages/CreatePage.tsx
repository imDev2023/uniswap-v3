import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseEventLogs } from 'viem'
import {
  useAccount,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { launchpadFactoryAbi } from '../abi/launchpadFactory'
import { FACTORY_ADDRESS, isLaunchpadConfigured } from '../config/contracts'
import { activeChain } from '../config/chain'
import { shortReason } from '../lib/errors'
import { formatDuration, formatEth, formatTokenAmount } from '../lib/format'
import { classifyMetadataUri } from '../lib/metadataUri'
import { useWrongChain } from '../hooks/useWrongChain'
import { ConnectButton } from '../components/ConnectButton'

const SYMBOL_RE = /^[A-Za-z0-9]{1,11}$/

/**
 * `LaunchpadFactory` rejects a name longer than 32 bytes.
 *
 * ⚠️ The input used to cap at 40 while validation rejected above 32, so eight characters could be
 * typed into a field that had already gone invalid. Both numbers now come from here.
 */
const NAME_MAX = 32

/** Granularity of the dev-allocation control, in basis points. 10 bps = 0.1%. */
const DEV_BPS_STEP = 10

/** Immutable or owner-tunable-but-slow. Fetched once; a retune is a new page load away. */
const TERMS_QUERY = { staleTime: 60_000 } as const

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
  const [devBps, setDevBps] = useState(0)
  const [permanentLock, setPermanentLock] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)

  const { data: creationFee } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: launchpadFactoryAbi,
    functionName: 'creationFee',
    query: { enabled: isLaunchpadConfigured },
  })

  // ⚠️ **Every bound and every term below is READ, never hardcoded.** All four are owner-tunable and
  // future-only, and that design exists so testnet feedback can retune the platform with a
  // transaction rather than a redeploy. A form carrying `500` or `365 days` as a literal turns each
  // retune into a frontend deploy, and in the window before that deploy lands it quotes creators
  // terms the contract will not honour - or refuses an allocation the contract would have accepted.
  const { data: terms } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: FACTORY_ADDRESS, abi: launchpadFactoryAbi, functionName: 'maxDevAllocationBps' },
      { address: FACTORY_ADDRESS, abi: launchpadFactoryAbi, functionName: 'defaultLockDuration' },
      { address: FACTORY_ADDRESS, abi: launchpadFactoryAbi, functionName: 'vestingDuration' },
      { address: FACTORY_ADDRESS, abi: launchpadFactoryAbi, functionName: 'creatorFeeBps' },
      { address: FACTORY_ADDRESS, abi: launchpadFactoryAbi, functionName: 'CURVE_SUPPLY' },
    ],
    query: { enabled: isLaunchpadConfigured, ...TERMS_QUERY },
  })

  // Destructured positionally in ONE place, right beside the array it mirrors. Reading each value
  // by index at its point of use typechecks whatever index you write, so reordering the `contracts`
  // array above would silently hand `defaultLockDuration` to the vesting copy and vice versa - both
  // are `uint64` second counts, so nothing would look wrong.
  const [maxDevBpsR, lockDurationR, vestingDurationR, creatorFeeBpsR, curveSupplyR] = terms ?? []
  const ok = <T,>(entry: { status: string; result?: unknown } | undefined): T | undefined =>
    entry?.status === 'success' ? (entry.result as T) : undefined

  const maxDevBps = ok<number>(maxDevBpsR)
  const lockDuration = ok<bigint>(lockDurationR)
  const vestingDuration = ok<bigint>(vestingDurationR)
  const creatorFeeBps = ok<number>(creatorFeeBpsR)
  const curveSupply = ok<bigint>(curveSupplyR)

  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract()
  const { data: receipt, isLoading: isMining } = useWaitForTransactionReceipt({ hash: txHash })

  // The control is clamped to whatever the chain currently allows, and it is never offered against
  // a guessed ceiling.
  //
  // ⚠️ **Three states, not two.** An unread bound is NOT the same as a bound of zero, and collapsing
  // them recreates the very defect this ticket exists to fix: the form would render with no carve
  // control, submit `devAllocationBps: 0`, and never tell the creator the option existed - only now
  // with an RPC hiccup as the trigger instead of a hardcoded literal. Zero means the owner has
  // turned the pre-mine off, which is a real answer worth stating; undefined means we do not know.
  const devBoundUnread = maxDevBps === undefined
  const devEnabled = maxDevBps !== undefined && maxDevBps > 0
  const effectiveDevBps = devEnabled ? Math.min(devBps, maxDevBps) : 0
  const devTokens =
    curveSupply !== undefined ? (curveSupply * BigInt(effectiveDevBps)) / 10_000n : undefined

  const uriVerdict = classifyMetadataUri(metadataURI)

  const nameError =
    name.trim().length === 0 ? 'Required' : name.length > NAME_MAX ? 'Too long' : ''
  const symbolError = !SYMBOL_RE.test(symbol) ? '1–11 letters/numbers' : ''
  const uriError = uriVerdict.kind === 'invalid' ? uriVerdict.reason : ''
  const canSubmit =
    isConnected &&
    !wrongChain &&
    !nameError &&
    !symbolError &&
    !uriError &&
    acknowledged &&
    creationFee !== undefined

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
          permanentLock,
          devAllocationBps: effectiveDevBps,
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
            maxLength={NAME_MAX}
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
            aria-invalid={uriVerdict.kind === 'invalid'}
            onChange={(e) => setMetadataURI(e.target.value)}
          />
          {/* ⚠️ Validated since #37. This field writes permanently and has no setter, and until this
              ticket it accepted anything at all - `ipfs//cid`, free text, a lone space - while the
              read side silently dropped every one. The creator saw a successful launch and a blank
              avatar forever, with nothing telling them which of the two had gone wrong. */}
          {uriError ? (
            <div className="error-text">{uriError}</div>
          ) : (
            <div className="hint">
              Points to a JSON document (<code>name</code>, <code>description</code>,{' '}
              <code>image</code>, <code>banner</code>, <code>links</code>). Written to the token
              contract and <strong>permanent - it can never be changed or removed</strong>, by you or
              anyone else. Leave blank to launch without metadata.
            </div>
          )}
        </div>

        {/* --- the two choices that were silently hardcoded until #37 --- */}

        {devBoundUnread ? (
          <div className="field">
            <label>Creator allocation</label>
            <div className="hint">
              The maximum creator allocation could not be read from the launchpad, so this option is
              not being offered. Reload before launching if you intend to take a carve - it cannot be
              added afterwards.
            </div>
          </div>
        ) : !devEnabled ? (
          <div className="field">
            <label>Creator allocation</label>
            <div className="hint">
              The launchpad is not currently allowing any creator allocation, so the whole curve
              supply goes to buyers.
            </div>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="devBps">
              Creator allocation - {(effectiveDevBps / 100).toFixed(2)}%
            </label>
            <input
              id="devBps"
              className="range"
              type="range"
              min={0}
              max={maxDevBps}
              step={DEV_BPS_STEP}
              value={effectiveDevBps}
              onChange={(e) => setDevBps(Number(e.target.value))}
              // The filled portion of the track. A range input cannot express this in CSS alone -
              // there is no selector for "left of the thumb" - so the percentage is handed to the
              // stylesheet as a custom property and the track paints a two-stop gradient from it.
              style={
                {
                  '--range-fill': `${maxDevBps > 0 ? (effectiveDevBps / maxDevBps) * 100 : 0}%`,
                } as React.CSSProperties
              }
            />
            {/* The ceiling is owner-tunable, so it is shown rather than left to be discovered by
                dragging to the end of the track. */}
            <div className="range-scale">
              <span>0%</span>
              <span>max {(maxDevBps / 100).toFixed(2)}%</span>
            </div>
            <div className="hint">
              {devTokens !== undefined && effectiveDevBps > 0 ? (
                <>
                  <strong>{formatTokenAmount(devTokens)} tokens</strong> free to you, carved out of
                  the curve supply - so there is that much less for buyers.{' '}
                </>
              ) : (
                <>Take none, and the whole curve supply is available to buyers. </>
              )}
              {effectiveDevBps > 0 && vestingDuration !== undefined && (
                <>
                  It releases linearly over {formatDuration(vestingDuration)}, starting{' '}
                  <strong>at graduation</strong> - never at creation. A curve that never graduates
                  never releases any of it.
                </>
              )}
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="permanentLock" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              id="permanentLock"
              className="check"
              type="checkbox"
              checked={permanentLock}
              onChange={(e) => setPermanentLock(e.target.checked)}
            />
            Lock the liquidity permanently
          </label>
          <div className="hint">
            {permanentLock ? (
              <>
                The graduation liquidity can <strong>never</strong> be withdrawn or reclaimed.{' '}
                <strong>This choice is terminal and cannot be undone.</strong>
              </>
            ) : (
              <>
                Default:{' '}
                {lockDuration !== undefined ? formatDuration(lockDuration) : 'a fixed term'} from
                graduation. You can extend it later, never shorten it. Once expired, and only after
                the pool has gone quiet for a long period, anyone can wind the position up.
              </>
            )}
          </div>
        </div>

        <div className="quote-line" style={{ margin: '4px 0 8px' }}>
          <span>Creation fee</span>
          <span className="num">
            {creationFee !== undefined ? `${formatEth(creationFee)} ETH` : '…'}
          </span>
        </div>
        {creatorFeeBps !== undefined && (
          <div className="quote-line" style={{ margin: '0 0 16px' }}>
            <span>Your share of pool fees after graduation</span>
            <span className="num">{creatorFeeBps / 100}%</span>
          </div>
        )}

        {/* ⚠️ Everything on this form is irreversible, and two of the fields became irreversible
            CHOICES rather than silent defaults in #37. An explicit acknowledgement gates submit
            because a creator who did not realise the allocation was a one-time decision cannot fix
            it afterwards - there is no setter for any of it, for anyone, ever. */}
        <label className="hint" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            className="check"
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            I understand the metadata URI, the {(effectiveDevBps / 100).toFixed(2)}% carve and the{' '}
            {permanentLock ? 'permanent' : 'standard'} lock are fixed at creation and can never be
            changed.
          </span>
        </label>

        <div style={{ marginTop: 16 }}>
          {!isConnected ? (
            <ConnectButton />
          ) : wrongChain ? (
            <button type="button" className="btn btn-warn" style={{ width: '100%' }} disabled>
              Switch to {activeChain.name} to launch
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={!canSubmit || isPending || isMining}
            >
              {isPending ? 'Confirm in wallet…' : isMining ? 'Launching…' : 'Launch token'}
            </button>
          )}
        </div>

        {writeError && <div className="error-text">{shortReason(writeError.message)}</div>}
      </form>
    </div>
  )
}
