/** First line of a wallet/RPC error, trimmed for inline display. */
export function shortReason(message: string, max = 160): string {
  return message.split('\n')[0].slice(0, max)
}
