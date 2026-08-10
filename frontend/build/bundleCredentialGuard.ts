import type { Plugin } from 'vite'
// Rollup's own types, not Vite's: vite 5 re-exports `Plugin` but not the bundle-output types, so
// importing them from 'vite' typechecks in an editor and fails `tsc -b`.
import type { OutputAsset, OutputChunk } from 'rollup'
import { findCredentials } from '../src/lib/rpcCredentials'

// The build-time half of Stage 4 key protection. `src/lib/rpcCredentials.ts` decides what a
// credential looks like; this decides what to do about one that reached the output.
//
// It lives outside src/ because it is build tooling, not application code: it runs in the Node
// process that performs the build and must never be reachable from a browser bundle.

/** The credential, server-side only. Never prefixed with VITE_, so Vite can never inline it. */
export const UPSTREAM_VAR = 'RPC_UPSTREAM_URL'

/** Deliberate acknowledgement that a bundled credential is domain-allowlisted at the provider. */
export const OPT_OUT_VAR = 'ALLOW_BUNDLED_RPC_CREDENTIAL'

export const GUARD_PLUGIN_NAME = 'octopus:bundle-credential-guard'

const remedy =
  `Move the keyed endpoint to ${UPSTREAM_VAR} (no VITE_ prefix, so it is never inlined) and set\n` +
  `VITE_RPC_PROXY_PATH=/rpc, which points the app at a same-origin proxy instead. See\n` +
  `frontend/.env.example and docs/security-checklist.md.\n\n` +
  `If the key is domain-allowlisted at the provider and shipping it is a deliberate decision,\n` +
  `set ${OPT_OUT_VAR}=1 to downgrade this to a warning.`

/**
 * The text a bundle entry contributes to the scan.
 *
 * Assets may be binary (`Uint8Array`), and contribute nothing.
 *
 * A chunk contributes its sourcemap as well as its code. `build.sourcemap` is off in this project
 * today, but if it is ever switched on the map is emitted alongside the chunk and its
 * `sourcesContent` carries the pre-minified source - a second published copy of anything inlined
 * into it. Scanning only `code` would let the guard pass a build that shipped the key in the file
 * next to it.
 */
const textOf = (output: OutputChunk | OutputAsset): string => {
  if (output.type !== 'chunk') return typeof output.source === 'string' ? output.source : ''
  return output.map === null || output.map === undefined
    ? output.code
    : `${output.code}\n${JSON.stringify(output.map)}`
}

/**
 * Fail the build when a credential-shaped URL reaches the bundle.
 *
 * This is what makes the protection durable rather than a thing somebody remembered once. The two
 * configuration mistakes that reintroduce the leak - putting a keyed URL back into `VITE_RPC_URL`,
 * or copying a `.env.local` from a machine that still has one - are both invisible in review and
 * both caught here.
 *
 * It runs in `generateBundle`, before anything is written, so a build that would have leaked
 * produces no `dist` at all rather than one somebody might deploy from.
 *
 * The failure text carries only redacted URLs, because `findCredentials` redacts at the point of
 * detection. A guard that printed the key it caught would publish it to a terminal and to CI logs
 * at exactly the moment it fired.
 *
 * @param acknowledged The operator has stated that a bundled credential is deliberate and
 *        domain-allowlisted at the provider. Downgrades the failure to a warning; it never silences
 *        it, because an allowlist is a provider-side control this build cannot verify.
 */
export const bundleCredentialGuard = (acknowledged: boolean): Plugin => ({
  name: GUARD_PLUGIN_NAME,
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const findings: string[] = []
    for (const [fileName, output] of Object.entries(bundle)) {
      const text = textOf(output)
      if (text === '') continue
      for (const found of findCredentials(text)) {
        findings.push(`  ${fileName}\n    ${found.redacted}   (credential in the URL ${found.location})`)
      }
    }
    if (findings.length === 0) return

    const detail = findings.join('\n')
    if (acknowledged) {
      this.warn(
        `A credential-shaped URL is in the bundle, allowed by ${OPT_OUT_VAR}:\n${detail}\n\n` +
          `It is readable by every visitor. Confirm the provider-side domain allowlist is in place.`,
      )
      return
    }

    this.error(
      `A credential-shaped URL reached the production bundle:\n${detail}\n\n` +
        `Vite inlines every VITE_* value, so this string is published to every visitor.\n\n${remedy}`,
    )
  },
})
