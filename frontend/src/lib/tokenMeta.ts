// Off-chain token image storage — a local preview, superseded but not yet replaced.
//
// Build #24 put the real fix on-chain: `LaunchToken.metadataURI` is set at creation and emitted in
// `LaunchCreated`, so a token's metadata is now global rather than per-browser. What is NOT built yet
// is the read side — resolving that URI needs an IPFS gateway choice and a fallback avatar for
// unpinned or mistyped URIs, both Stage 3 decisions.
//
// Until then this client-side map stays: it keeps images working for tokens launched before #24, and
// gives a preview for ones launched without a metadata URI. Images stored here remain per-browser.

const KEY = 'launchpad:tokenImages'

type ImageMap = Record<string, string>

function read(): ImageMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as ImageMap
  } catch {
    return {}
  }
}

function write(map: ImageMap): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEY, JSON.stringify(map))
}

export function getTokenImage(address: string): string | undefined {
  return read()[address.toLowerCase()]
}

export function setTokenImage(address: string, imageUrl: string): void {
  const url = imageUrl.trim()
  if (!url) return
  const map = read()
  map[address.toLowerCase()] = url
  write(map)
}
