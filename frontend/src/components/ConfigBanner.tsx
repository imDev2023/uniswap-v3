import { isLaunchpadConfigured } from '../config/contracts'
import { activeChain } from '../config/chain'

// When the factory address is still the zero address (contracts not yet deployed — see #18/docs
// deploy pipeline), be explicit rather than letting on-chain calls fail silently.
export function ConfigBanner() {
  if (isLaunchpadConfigured) return null
  return (
    <div className="banner banner-warn" role="status">
      <strong>Preview mode.</strong> The launchpad contracts aren’t configured for this build yet.
      Set <code>VITE_FACTORY_ADDRESS</code> (and a <code>VITE_SUBGRAPH_URL</code>) after deploying to{' '}
      {activeChain.name} — see <code>docs/deploy.md</code>. Trading and creation are disabled until
      then.
    </div>
  )
}
