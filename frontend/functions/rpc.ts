import { type RpcProxyEnv, handleRpc } from '../src/lib/rpcProxyHandler'

// Cloudflare Pages routes by FILE NAME, so this file - and only its name - is what makes `/rpc`
// exist in production. It must stay at the Pages project root (`frontend/functions/`), never inside
// the static output directory, which Cloudflare serves verbatim.
//
// Deliberately an adapter and nothing more. Everything that could be wrong about the forwarding
// lives in `src/lib/rpcProxyHandler.ts`, where the ordinary frontend suite can falsify it; if the
// logic lived here, only a deploy could. The one thing this file asserts is Cloudflare's calling
// convention, and that is what `wrangler pages dev` checks.

export const onRequest: PagesFunction<RpcProxyEnv> = ({ request, env }) => handleRpc(request, env)
