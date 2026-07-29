import { activeChain } from '../config/chain'
import type { OnchainToken } from '../lib/onchainToken'

// The states that mean "there is nothing to trade here yet" are identical on the token page and the
// swap page, and so is the copy. Kept in one place so a new OnchainToken state can't be handled on
// one page and silently forgotten on the other - which on the money path is how a page ends up
// rendering a trade panel it shouldn't.
//
// Pair with `isTradeable` (lib/onchainToken): pages read
//   if (!isTradeable(onchain)) return <OnchainTokenGate token={onchain} />
// which both renders the right notice and narrows `onchain` to the states that carry a curve.
export function OnchainTokenGate({ token }: { token: UntradeableToken }) {
  switch (token.status) {
    case 'not-configured':
      return (
        <p className="center-note">
          The launchpad isn’t configured for this build - see the banner above.
        </p>
      )
    case 'loading':
      return <div className="spinner">Loading token…</div>
    case 'unreachable':
      return (
        <p className="center-note">
          Couldn’t reach the chain to look up this token. The RPC endpoint for {activeChain.name}{' '}
          isn’t responding - trading is unavailable until it does.
        </p>
      )
    case 'not-a-launch':
      return <p className="center-note">This address isn’t a token launched on Octopus.</p>
  }
}

type UntradeableToken = Exclude<OnchainToken, { curve: string }>
