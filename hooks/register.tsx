import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelEffort, Register } from 'claude-code'

import type { VoiceMode, VoiceSpeed } from '../types'

const PORT = 47821
const BASE = `http://127.0.0.1:${PORT}`
// A Piper voice (natural, offline). The listener downloads it the first time and uses the
// Windows voice until it is ready.
const VOICE = 'en_GB-jenny_dioco-medium'
const MAX_SPOKEN = 700
const LISTENER_VERSION = 8
const BACKSLASH = String.fromCharCode(92)

const mode = atom({ plugin: 'voice-chat', key: 'mode' } as const, 'off' as VoiceMode, { shape: 'mode-1' })
const level = atom({ plugin: 'voice-chat', key: 'level' } as const, 0, { shape: 'level-1' })
const lastHeard = atom({ plugin: 'voice-chat', key: 'lastHeard' } as const, '', { shape: 'heard-1' })
const problem = atom({ plugin: 'voice-chat', key: 'problem' } as const, '', { shape: 'problem-1' })
const speed = atom({ plugin: 'voice-chat', key: 'speed' } as const, 'auto' as VoiceSpeed, { shape: 'speed-1' })
const effortNow = atom({ plugin: 'voice-chat', key: 'effortNow' } as const, '', { shape: 'effort-1' })

// How hard Claude thinks about a spoken question. Typed prompts keep the session's own setting.
const SPEEDS: readonly VoiceSpeed[] = ['auto', 'quick', 'balanced', 'thorough']
const EFFORT: Record<Exclude<VoiceSpeed, 'auto'>, ModelEffort> = { quick: 'low', balanced: 'medium', thorough: 'high' }
const SORT =
  'You sort spoken questions for a voice assistant. Reply with one word. ' +
  'QUICK: a fact, date, time, definition, yes or no, small talk, or a short follow-up. ' +
  'DEEP: an explanation of something complex, code to write or change, a plan, a comparison, or a decision.'

const LABEL: Record<VoiceMode, string | undefined> = {
  off: undefined,
  starting: '\u{1F399}\uFE0F Voice: loading Whisper\u2026',
  listening: '\u{1F399}\uFE0F Listening, just talk',
  hearing: '\u{1F399}\uFE0F Transcribing\u2026',
  thinking: '\u{1F4AD} Thinking\u2026',
  speaking: '\u{1F50A} Speaking. Talk, type or /voice-chat stop to cut in',
  error: '\u26A0\uFE0F Voice: listener not running (/voice-chat on to retry)',
}

type Poll = { texts: string[]; state: string; level: number; error?: string; version?: number }

// Module variables reset on reload: the polling timer, a re-entry flag, and missed polls.
let ticker: { cancel: () => void } | undefined
let polling = false
let misses = 0
// The effort chosen for the spoken prompt just submitted, then the turn it started.
let pendingEffort: ModelEffort | undefined
let voiceTurn: { id: string; effort: ModelEffort } | undefined

/** The effort for a spoken question: fixed by the speed setting, or in auto, sorted by a
 * quick Haiku call (at most 2 s; medium if it can't tell in time). */
async function effortFor($: EngineInterface, text: string): Promise<ModelEffort> {
  const s = await read($, speed)
  if (s !== 'auto') return EFFORT[s]
  try {
    const r = await Promise.race([
      $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 5, system: SORT, prompt: text }),
      $.clock.sleep(2000).then(() => undefined),
    ])
    if (r && r.isAnswered) return /quick/i.test(r.text) ? 'low' : 'high'
  } catch {
    // no answer: fall through
  }
  return 'medium'
}

async function fail($: EngineInterface, why: string) {
  await update($, problem, () => why)
  await setMode($, 'error')
}

async function setMode($: EngineInterface, m: VoiceMode) {
  await update($, mode, () => m)
  $.ui.status(LABEL[m])
}

async function post($: EngineInterface, path: string, body?: unknown) {
  try {
    await $.http.fetch(`${BASE}${path}`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  } catch {
    // listener gone
  }
}

async function poll($: EngineInterface): Promise<Poll | undefined> {
  try {
    const r = await $.http.fetch(`${BASE}/poll`)
    return r.ok ? (JSON.parse(r.text) as Poll) : undefined
  } catch {
    return undefined
  }
}

/** Turn markdown into something worth hearing. */
function speakable(md: string): string {
  let t = md
    .replace(/```[\s\S]*?```/g, ' (code on screen) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/\s*(->|\u2192|=>)\s*/g, ' to ')
    // Emoji, check marks and other symbols are read out as their Unicode names.
    .replace(/[\p{Extended_Pictographic}\u2190-\u21ff\u2500-\u27bf\ufe0f\u200d]/gu, '')
    .replace(/[*_~>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > MAX_SPOKEN) {
    const cut = t.slice(0, MAX_SPOKEN)
    t = cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, 200)) + ' The rest is on screen.'
  }
  return t
}

async function startListener($: EngineInterface): Promise<boolean> {
  const running = await poll($)
  if (running && running.state !== 'error' && running.version === LISTENER_VERSION) return true
  if (running) {
    // A listener that failed, or one from an older version of this plugin: replace it.
    await post($, '/quit')
    await $.clock.sleep(1500)
  }
  // Forward slashes, and ' doubled: the paths sit in single-quoted PowerShell
  // strings, and a folder like C:/Users/O'Brien would otherwise end the string.
  const fwd = (p: string) => p.split(BACKSLASH).join('/').split("'").join("''")
  const script = fwd(`${$.plugin.root}/scripts/listener.py`)
  const log = fwd(`${$.plugin.root}/scripts/listener.log`)
  const ps =
    `Start-Process -WindowStyle Hidden -FilePath python -ArgumentList ` +
    `'"${script}"','--port','${PORT}','--log','"${log}"','--voice','${VOICE}'`
  try {
    const r = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], {
      timeoutMs: 20_000,
    })
    if (r.exitCode === 0) return true
  } catch {
    // fall through
  }
  await fail($, 'could not start Python. Is python 3.9+ on your PATH?')
  return false
}

function startPolling($: EngineInterface) {
  ticker?.cancel()
  misses = 0
  ticker = $.clock.every(400, async () => {
    if (polling) return
    polling = true
    try {
      const m = await read($, mode)
      if (m === 'off') return
      const p = await poll($)
      if (!p) {
        // First start loads the model; allow about a minute before calling it failed.
        misses += 1
        if (misses > (m === 'starting' ? 150 : 8) && m !== 'error')
          await fail(
            $,
            m === 'starting'
              ? "listener didn't start. Check that python runs in a terminal (not the Microsoft Store stub)"
              : 'listener stopped, see scripts/listener.log',
          )
        return
      }
      misses = 0
      if (p.state === 'error') {
        if (m !== 'error') await fail($, p.error || 'listener failed, see scripts/listener.log')
        return
      }
      await update($, level, () => p.level)
      if (m === 'starting' || m === 'error') {
        if (p.state === 'listening') await setMode($, 'listening')
        return
      }
      // The listener reads replies out: it says when it finished, or when you talked over it.
      if (m === 'speaking' && p.state === 'listening') await setMode($, 'listening')
      if ((m === 'listening' || m === 'speaking') && p.state === 'transcribing') await setMode($, 'hearing')
      if (m === 'hearing' && p.state === 'listening') await setMode($, 'listening')
      const text = p.texts.join(' ').trim()
      if (text && (m === 'listening' || m === 'hearing' || m === 'speaking')) {
        await update($, lastHeard, () => text)
        await setMode($, 'thinking')
        pendingEffort = await effortFor($, text)
        await update($, effortNow, () => pendingEffort ?? '')
        await $.prompt.submit({ text, asUser: true })
      }
    } finally {
      polling = false
    }
  })
}

async function turnOn($: EngineInterface) {
  await update($, problem, () => '')
  await setMode($, 'starting')
  if (await startListener($)) startPolling($)
}

async function turnOff($: EngineInterface) {
  ticker?.cancel()
  ticker = undefined
  await post($, '/quit')
  await setMode($, 'off')
}

const USAGE =
  'Usage: /voice-chat on, /voice-chat off, /voice-chat stop (cut a reply short), /voice-chat speed auto|quick|balanced|thorough, or /voice-chat to toggle.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'voice-chat',
      description: 'Hands-free voice: /voice-chat on | off | stop | speed (speak prompts, hear replies)',
    })
    // After a reload, pick up where we were.
    if ((await read($, mode)) !== 'off') void turnOn($)
    return next(e)
  })

  on('command.run', { command: 'voice-chat' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    const isOn = (await read($, mode)) !== 'off'
    if (arg === 'speed' || arg.startsWith('speed ')) {
      const want = arg.slice(5).trim()
      if (want === '') return { text: `Speed is ${await read($, speed)}. Options: ${SPEEDS.join(', ')}.` }
      if (!(SPEEDS as readonly string[]).includes(want)) return { text: `Speed options: ${SPEEDS.join(', ')}.` }
      const sp = want as VoiceSpeed
      await update($, speed, () => sp)
      const what: Record<VoiceSpeed, string> = {
        auto: 'quick questions get quick answers, complex ones get proper thinking',
        quick: 'fastest answers, light thinking',
        balanced: 'medium thinking',
        thorough: 'careful answers, takes longer',
      }
      return { text: `Speed set to ${sp}: ${what[sp]}. Only spoken questions are affected.` }
    }
    if (arg === 'stop' || arg === 'skip') {
      if (!isOn) return { text: 'Voice chat is off.' }
      await post($, '/stop')
      await setMode($, 'listening')
      return { text: 'Stopped. Listening.' }
    }
    if (arg !== '' && arg !== 'on' && arg !== 'off') return { text: USAGE }
    const want = arg === 'on' ? true : arg === 'off' ? false : !isOn
    if (want) {
      void turnOn($)
      return {
        text: 'Voice chat on. Whisper loads in a few seconds, then just talk and I will answer out loud. Talk over a reply, or type, to cut it short. /voice-chat off to stop.',
      }
    }
    await turnOff($)
    return { text: 'Voice chat off. Mic released.' }
  })

  // A typed prompt while voice is on: stop any reply being read out, and stop
  // listening until the new reply is done.
  on('prompt.submit', async ($, e, next) => {
    const m = await read($, mode)
    if (m === 'listening' || m === 'hearing' || m === 'speaking') {
      await post($, '/pause')
      await setMode($, 'thinking')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The turn a spoken prompt starts thinks as hard as its speed says; nothing else changes.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId && pendingEffort) {
      voiceTurn = { id: e.turnId, effort: pendingEffort }
      pendingEffort = undefined
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId && voiceTurn && e.turnId === voiceTurn.id) return yield* next({ ...e, effort: voiceTurn.effort })
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    if (voiceTurn && e.turnId === voiceTurn.id) voiceTurn = undefined
    const m = await read($, mode)
    if (m === 'off' || m === 'starting' || m === 'error') return done
    const text = e.reason === 'answer' ? speakable(e.answer) : ''
    if (text) {
      // The listener reads it out and listens again when it ends (or you cut in).
      await setMode($, 'speaking')
      await post($, '/speak', { text, voice: VOICE })
    } else {
      await post($, '/listen')
      await setMode($, 'listening')
    }
    return done
  }).catch(($, e, next) => next(e))

  // A slim band above the prompt while voice is on: state, mic level, last words heard.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, mode)
    if (m === 'off') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const lvl = await read($, level)
    const heard = await read($, lastHeard)
    const why = await read($, problem)
    const sp = await read($, speed)
    const eff = await read($, effortNow)
    const bars = 10
    const lit = m === 'listening' || m === 'hearing' ? Math.round(lvl * bars) : 0
    const meter = '\u25AE'.repeat(lit) + '\u25AF'.repeat(bars - lit)
    const color = m === 'error' ? 'error' : m === 'speaking' ? 'claude' : m === 'thinking' ? 'warning' : 'success'
    return (
      <Box flexDirection="row" gap={2}>
        <Text color={color} bold>
          {LABEL[m] ?? ''}
        </Text>
        {(m === 'listening' || m === 'hearing') && <Text color="success">{meter}</Text>}
        {m === 'error' && why !== '' && <Text color="error">{why}</Text>}
        {m === 'thinking' && eff !== '' && <Text dimColor>{`${eff} effort`}</Text>}
        {m !== 'error' && m !== 'thinking' && <Text dimColor>{`speed: ${sp}`}</Text>}
        {m !== 'error' && heard !== '' && (
          <Text dimColor>last heard: "{heard.length > 60 ? heard.slice(0, 59) + '\u2026' : heard}"</Text>
        )}
      </Box>
    )
  })
}
