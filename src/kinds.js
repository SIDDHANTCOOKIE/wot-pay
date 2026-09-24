// Custom event kinds (regular range, not replaceable).
export const KIND = {
  OFFER: 3401,
  CLAIM: 3402,
  SETTLED: 3403,
  DISPUTED: 3404,
}

export const KIND_NAME = Object.fromEntries(
  Object.entries(KIND).map(([k, v]) => [v, k.toLowerCase()]),
)

// Every event we publish carries this tag so clients can filter on it.
// Bumped from wot-upi with the rename; old test events are not read.
export const APP_TAG = 'wot-pay'

export const SCHEMA_VERSION = 1

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]
