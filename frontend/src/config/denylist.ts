/**
 * Moderation denylist.
 *
 * ⚠️ **This is the only takedown mechanism that exists.** `LaunchToken.metadataURI` is constructor-set
 * with no setter for anyone, including the owner, and a token's name and symbol are likewise fixed
 * at creation. Nothing on-chain can be edited or removed after the fact, so abusive imagery or a
 * slur in a ticker can only ever be handled on the surfaces we control. Planning for that was an
 * explicit condition of the immutability decision in build #24 rather than something to discover in
 * production.
 *
 * **Storage: committed here and compiled into the bundle.** The alternative - fetching a list at
 * runtime - buys a faster takedown (seconds, versus a commit plus a redeploy) at the cost of a
 * second thing to host and a runtime dependency that can fail, be blocked, or be tampered with, and
 * which then forces a fail-open/fail-closed decision of its own. For v1, which has no server by
 * design, a few minutes is an acceptable response time and zero runtime dependencies is worth more.
 * `lib/denylist.ts` reads this through a function, so a runtime overlay can be layered in later
 * without touching a single call site.
 *
 * A `.ts` module rather than a `.json` file for the same reason the rest of the config is typed: a
 * mistyped tier is a build error here and a silently ignored entry there.
 *
 * ## Tiers
 *
 * | tier | board / feeds | token page | trading |
 * | --- | --- | --- | --- |
 * | `image` | listed, identicon | reachable, identicon | unaffected |
 * | `hide` | removed | reachable by direct link, with a notice | **unaffected** |
 *
 * ⚠️ **Neither tier blocks trading, and that is deliberate.** Someone may already hold a token we
 * later hide; refusing to render its trade panel would strand them in a position they cannot exit
 * through our UI, which is a real financial harm inflicted to make a moderation point. Hiding it
 * from discovery removes our amplification of it, which is the part we are actually responsible
 * for. The curve and the pool remain on-chain and reachable regardless of what this file says.
 *
 * ## Adding an entry
 *
 * Key by **token address**, lowercased. Not by symbol - symbols are attacker-chosen and duplicable,
 * so a symbol rule would be trivially evaded by relaunching and would catch innocent tokens by
 * collision. Not by CID either: the same image republished under a new CID escapes, whereas the
 * token address is fixed for the life of the launch.
 */

export type DenylistTier = 'image' | 'hide'

/**
 * Address (lowercase) to tier.
 *
 * Empty in the repo: nothing on testnet warrants an entry, and seeding it with examples would risk
 * shipping a real address as a placeholder. The two seeded launches with unresolvable URIs
 * (`OCAT`, `BOOTS`) are NOT denylist cases - they are the ordinary broken-URI path, which the
 * identicon already handles without any moderation decision.
 */
export const DENYLIST: Readonly<Record<string, DenylistTier>> = {}
