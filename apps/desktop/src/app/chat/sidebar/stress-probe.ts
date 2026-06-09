// Dev-only sidebar stress harness. Splats a large, varied set of fake sessions
// across every sidebar section (recents + workspace groups, pinned, per-platform
// messaging, cron jobs) so the layout's resize behaviour can be stress-tested at
// short window heights without a populated backend. Tree-shaken out of
// production builds; loaded from main.tsx alongside the perf probe.
//
// Usage (devtools console):
//   __hermesSidebarStress.seed()              // sensible defaults
//   __hermesSidebarStress.seed({ platforms: 12, perPlatform: 30, pins: 10 })
//   __hermesSidebarStress.clear()             // restore empty atoms
//
// Or auto-seed on boot with a query param: `?sidebarStress=1` (defaults) or
// `?sidebarStress=120` (that many recents).

import { MESSAGING_SESSION_SOURCE_IDS, sessionSourceLabel } from '@/lib/session-source'
import { completeDesktopBoot } from '@/store/boot'
import { $pinnedSessionIds } from '@/store/layout'
import { $cronJobs } from '@/store/cron'
import { $desktopOnboarding } from '@/store/onboarding'
import {
  $gatewayState,
  $messagingPlatformTotals,
  $messagingSessions,
  $messagingTruncated,
  $sessions,
  $sessionsLoading,
  $sessionsTotal
} from '@/store/session'
import type { CronJob, SessionInfo } from '@/types/hermes'

interface StressSeedOptions {
  /** Local recents (split across `workspaces` cwds). */
  recents?: number
  /** Distinct workspace cwds the recents fan out over. */
  workspaces?: number
  /** Recents to pin into the Pinned section. */
  pins?: number
  /** Messaging platforms to fan out (capped at the known platform list). */
  platforms?: number
  /** Conversations seeded per messaging platform. */
  perPlatform?: number
  /** Cron jobs in the Cron section. */
  cron?: number
}

const DEFAULTS: Required<StressSeedOptions> = {
  recents: 80,
  workspaces: 5,
  pins: 8,
  platforms: 10,
  perPlatform: 25,
  cron: 60
}

const TITLES = [
  'Confusing accidental vortex',
  'Refactor the gateway runner',
  'Why is the sidebar overlapping',
  'Ship the desktop release',
  'Investigate flaky cron tick',
  'Tighten the toolset schema',
  'Draft the PR description',
  'Debug WebSocket reconnect drop',
  'Audit dependency upper bounds',
  'Polish the model picker',
  'Trace a memory provider leak',
  'Rework the profile switcher'
]

const WORKSPACES = [
  '/Users/dev/www/hermes-agent',
  '/Users/dev/code/playground',
  '/Users/dev/projects/website',
  '/Users/dev/work/gateway',
  '/Users/dev/scratch/experiments',
  '/Users/dev/oss/contrib'
]

function makeSession(id: string, index: number, overrides: Partial<SessionInfo> = {}): SessionInfo {
  const now = Date.now() / 1000
  const ts = now - index * 60

  return {
    archived: false,
    cwd: null,
    ended_at: null,
    id,
    _lineage_root_id: null,
    input_tokens: 0,
    is_active: false,
    last_active: ts,
    message_count: 4,
    model: 'sonnet',
    output_tokens: 0,
    preview: 'Synthetic stress-test conversation row.',
    source: null,
    started_at: ts,
    title: TITLES[index % TITLES.length],
    tool_call_count: 0,
    ...overrides
  }
}

interface StressPayload {
  recents: SessionInfo[]
  messaging: SessionInfo[]
  platformTotals: Record<string, number>
  pinnedIds: string[]
  cron: CronJob[]
}

function buildPayload(options: StressSeedOptions = {}): StressPayload {
  const opts = { ...DEFAULTS, ...options }

  // Recents fanned across a handful of workspaces so the grouped view has
  // something to chew on too.
  const recents: SessionInfo[] = Array.from({ length: opts.recents }, (_, i) =>
    makeSession(`stress-recent-${i}`, i, {
      cwd: WORKSPACES[i % Math.max(1, Math.min(opts.workspaces, WORKSPACES.length))]
    })
  )

  const platforms = MESSAGING_SESSION_SOURCE_IDS.slice(0, Math.max(0, opts.platforms))
  const messaging: SessionInfo[] = platforms.flatMap((source, p) =>
    Array.from({ length: opts.perPlatform }, (_, i) =>
      makeSession(`stress-${source}-${i}`, p * opts.perPlatform + i, {
        source,
        title: `${sessionSourceLabel(source) ?? source} thread ${i + 1}`,
        preview: `${sessionSourceLabel(source) ?? source} synthetic conversation.`
      })
    )
  )

  const cron: CronJob[] = Array.from({ length: opts.cron }, (_, i) => ({
    enabled: true,
    id: `stress-cron-${i}`,
    name: `Scheduled job ${i + 1}`,
    prompt: 'Synthetic cron job for stress testing.',
    schedule_display: i % 2 === 0 ? 'every 2h' : '0 9 * * *',
    state: 'idle'
  }))

  return {
    recents,
    messaging,
    platformTotals: Object.fromEntries(platforms.map(source => [source, opts.perPlatform])),
    pinnedIds: recents.slice(0, Math.max(0, opts.pins)).map(s => s.id),
    cron
  }
}

// Push the synthetic payload into every sidebar atom. Holds the exact array
// references so the keep-alive loop can detect when the live gateway poll has
// clobbered them.
function apply(payload: StressPayload): void {
  $sessions.set(payload.recents)
  $sessionsTotal.set(payload.recents.length)
  $messagingSessions.set(payload.messaging)
  $messagingTruncated.set(false)
  $messagingPlatformTotals.set(payload.platformTotals)
  $pinnedSessionIds.set(payload.pinnedIds)
  $cronJobs.set(payload.cron)
}

// In the live Electron app the desktop controller re-fetches sessions/messaging/
// cron on gateway events + a poll, which overwrites a one-shot seed within a
// second (so the fakes flash and vanish). This interval re-asserts the payload
// only when something has replaced our array references — keeping the sidebar
// flooded for as long as the lock is held, without churning React every tick.
const KEEP_ALIVE_MS = 400
let keepAliveTimer: ReturnType<typeof setInterval> | null = null
let locked: StressPayload | null = null

function startKeepAlive(): void {
  if (keepAliveTimer != null) {
    return
  }

  keepAliveTimer = setInterval(() => {
    if (!locked) {
      return
    }

    // Bare-browser tabs (no backend) keep flipping these overlays back on via
    // their own polls; re-suppress them so the seeded sidebar stays visible.
    if ($gatewayState.get() !== 'open') {
      $gatewayState.set('open')
    }

    if ($desktopOnboarding.get().configured !== true || $desktopOnboarding.get().manual) {
      $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: true, manual: false })
    }

    if (
      $sessions.get() !== locked.recents ||
      $messagingSessions.get() !== locked.messaging ||
      $cronJobs.get() !== locked.cron
    ) {
      apply(locked)
    }
  }, KEEP_ALIVE_MS)
}

function stopKeepAlive(): void {
  if (keepAliveTimer != null) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
}

function seed(options: StressSeedOptions = {}): void {
  const payload = buildPayload(options)

  // Dismiss the boot + connecting + first-run onboarding overlays so a bare
  // browser tab (no Electron preload / gateway / configured model) still renders
  // the chat shell and its sidebar. No-op in the real app, which is already
  // booted + configured.
  completeDesktopBoot()
  $desktopOnboarding.set({ ...$desktopOnboarding.get(), configured: true, manual: false })
  $gatewayState.set('open')
  $sessionsLoading.set(false)

  locked = payload
  apply(payload)
  startKeepAlive()

  // eslint-disable-next-line no-console
  console.info(
    `[sidebar-stress] seeded ${payload.recents.length} recents, ` +
      `${Object.keys(payload.platformTotals).length} platforms (${payload.messaging.length} convos), ` +
      `${payload.pinnedIds.length} pins, ${payload.cron.length} cron jobs — ` +
      'keep-alive ON (call __hermesSidebarStress.clear() to release)'
  )
}

function clear(): void {
  locked = null
  stopKeepAlive()
  $sessions.set([])
  $sessionsTotal.set(0)
  $messagingSessions.set([])
  $messagingPlatformTotals.set({})
  $messagingTruncated.set(false)
  $pinnedSessionIds.set([])
  $cronJobs.set([])
  // eslint-disable-next-line no-console
  console.info('[sidebar-stress] cleared + keep-alive OFF (gateway data will repopulate)')
}

declare global {
  interface Window {
    __hermesSidebarStress?: {
      seed: (options?: StressSeedOptions) => void
      clear: () => void
    }
  }
}

if (typeof window !== 'undefined' && !window.__hermesSidebarStress) {
  window.__hermesSidebarStress = { seed, clear }

  try {
    const raw = new URLSearchParams(window.location.search).get('sidebarStress')

    if (raw != null) {
      const recents = Number.parseInt(raw, 10)
      // Seed after the first paint so the controller's initial (empty) fetch
      // doesn't clobber the synthetic rows.
      window.setTimeout(() => seed(Number.isFinite(recents) && recents > 1 ? { recents } : {}), 300)
    }
  } catch {
    // location parsing is best-effort; ignore.
  }
}

export {}
