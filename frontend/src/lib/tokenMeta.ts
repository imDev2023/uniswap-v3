// Off-chain token image storage.
//
// The LaunchToken contract and the subgraph carry only name + symbol (LaunchCreated emits no image
// field). Rather than block launches on a metadata backend that doesn't exist in v1, the create form
// captures an optional image URL and we persist it client-side, keyed by token address. This is a
// deliberate v1 limitation: images are per-browser, not shared. A follow-up (metadata contract or
// IPFS URI in the event) would make them global — see #20 notes.

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
