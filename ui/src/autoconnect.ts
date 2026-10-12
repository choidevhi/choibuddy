import { useEffect, useRef } from 'react'
import { pairingLink } from '../../shared/protocol.ts'
import { type Feed, readRemotes, saveRemotes } from './feeds.ts'
import { claimTailnet, fetchTailnetBridges } from './live.ts'
import { platform } from './platform.ts'

const CHECK_MS = 2 * 60_000
// A PC that said no (it does not trust its tailnet yet) is asked again later.
const RETRY_MS = 10 * 60_000

// Adds one of the person's PCs as a source of this app, the same as pasting
// or scanning its pairing link.
function addPc(baseUrl: string, token: string): void {
  if (platform === 'android') {
    window.ChoiBuddyNative?.setPairing(pairingLink(baseUrl, token))

    return
  }

  saveRemotes([...readRemotes().filter(item => item.baseUrl !== baseUrl), { baseUrl, token }])
  window.dispatchEvent(new Event('choibuddy-config'))
}

// The person's other PCs that trust their tailnet connect by themselves: each
// bridge this app already reaches lists the PCs it found on the tailnet, and
// each of those hands this device a code of its own once Tailscale vouches
// that the device belongs to the same account. A phone needs one PC paired
// by QR first; the rest follow.
export function useTailnetAutoConnect(feeds: Feed[], onConnected: (name: string) => void): void {
  const tried = useRef(new Map<string, number>())
  const latest = useRef({ feeds, onConnected })
  const liveKeys = feeds.flatMap(feed => (feed.link === 'live' ? [feed.key] : [])).join('|')

  useEffect(() => {
    latest.current = { feeds, onConnected }
  })

  useEffect(() => {
    if (platform === 'web' || liveKeys === '') return

    let stopped = false

    const run = async (): Promise<void> => {
      const current = latest.current.feeds
      const known = new Set(current.flatMap(feed => (feed.snapshot === null ? [] : [feed.snapshot.server.pcId])))

      for (const feed of current) {
        if (feed.link !== 'live') continue

        for (const bridge of await fetchTailnetBridges(feed.connection)) {
          if (stopped || !bridge.trustTailnet || known.has(bridge.pcId)) continue
          if (Date.now() - (tried.current.get(bridge.pcId) ?? 0) < RETRY_MS) continue
          tried.current.set(bridge.pcId, Date.now())

          const token = await claimTailnet(bridge.baseUrl)

          if (token === null || stopped) continue
          known.add(bridge.pcId)
          addPc(bridge.baseUrl, token)
          latest.current.onConnected(bridge.name)
        }
      }
    }

    void run()

    const timer = window.setInterval(() => void run(), CHECK_MS)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [liveKeys])
}
