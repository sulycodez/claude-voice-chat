import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VoiceMode } from '../types'

const PORT = 47821
const BASE = `http://127.0.0.1:${PORT}`
const VOICE = 'Microsoft Hazel Desktop'
const MAX_SPOKEN = 700
const BACKSLASH = String.fromCharCode(92)

const mode = atom({ plugin: 'voice-chat', key: 'mode' } as const, 'off' as VoiceMode, { shape: 'mode-1' })
const level = atom({ plugin: 'voice-chat', key: 'level' } as const, 0, { shape: 'level-1' })
const lastHeard = atom({ plugin: 'voice-chat', key: 'lastHeard' } as const, '', { shape: 'heard-1' })
const problem = atom({ plugin: 'voice-chat', key: 'problem' } as const, '', { shape: 'problem-1' })

const LABEL: Record<VoiceMode, string | undefined> = {
  off: undefined,
  starting: '🎙️ Voice: loading Whisper…',
  listening: '🎙️ Listening, just talk',
  hearing: '🎙️ Transcribing…',
  thinking: '💭 Thinking…',
  speaking: '🔊 Speaking…',
  error: '⚠️ Voice: listener not running (/voice-chat on to retry)',
}

type Poll = { texts: string[]; state: string; level: number; error?: string }

// Module variables reset on reload: the polling timer, a re-entry flag, and a
// count of prompts so a reply that finishes speaking after a newer prompt
// started doesn't reopen the mic in the middle of that turn.
let ticker: { cancel: () => void } | undefined
let polling = false
let misses = 0
let promptCount = 0

async function fail($: EngineInterface, why: string) {
  await update($, problem, () => why)
  await setMode($, 'error')
}

async function setMode($: EngineInterface, m: VoiceMode) {
  await update($, mode, () => m)
  $.ui.status(LABEL[m])
}

async function post($: EngineInterface, path: string) {
  try {
    await $.http.fetch(`${BASE}${path}`, { method: 'POST' })
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
    .replace(/\s*(->|→|=>)\s*/g, ' to ')
    // Emoji, check marks and other symbols read out as their Unicode names.
    .replace(/[\p{Extended_Pictographic}←-⇿─-➿️‍]/gu, '')
    .replace(/[*_~>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length > MAX_SPOKEN) {
    const cut = t.slice(0, MAX_SPOKEN)
    t = cut.slice(0, Math.max(cut.lastIndexOf('. ') + 1, 200)) + ' The rest is on screen.'
  }
  return t
}

async function say($: EngineInterface, text: string) {
  if (!text) return
  try {
    await $.audio.speak(text, { voice: VOICE })
    return
  } catch {
    // No platform synthesizer from the engine here: use Windows SAPI directly.
  }
  const ps =
    // UTF-8 in: Windows PowerShell reads stdin in the console code page, and "café" came out as "calf register trademark".
    '[Console]::InputEncoding = [Text.Encoding]::UTF8; ' +
    'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    `try { $s.SelectVoice('${VOICE}') } catch {}; $s.Rate = 1; $s.Speak([Console]::In.ReadToEnd())`
  await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], {
    stdin: text,
    timeoutMs: 300_000,
  })
}

async function startListener($: EngineInterface): Promise<boolean> {
  const running = await poll($)
  if (running && running.state !== 'error') return true
  if (running) {
    // A listener that failed earlier: replace it so a retry really retries.
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
    `'"${script}"','--port','${PORT}','--log','"${log}"'`
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
      if (m === 'listening' && p.state === 'transcribing') await setMode($, 'hearing')
      if (m === 'hearing' && p.state === 'listening') await setMode($, 'listening')
      const text = p.texts.join(' ').trim()
      if (text && (m === 'listening' || m === 'hearing')) {
        await update($, lastHeard, () => text)
        await setMode($, 'thinking')
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'voice-chat',
      description: 'Hands-free voice: /voice-chat on | off (speak prompts, hear replies)',
    })
    // After a reload, pick up where we were.
    if ((await read($, mode)) !== 'off') void turnOn($)
    return next(e)
  })

  on('command.run', { command: 'voice-chat' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Usage: /voice-chat on, /voice-chat off, or /voice-chat to toggle.' }
    }
    const isOn = (await read($, mode)) !== 'off'
    const want = arg === 'on' ? true : arg === 'off' ? false : !isOn
    if (want) {
      void turnOn($)
      return {
        text: 'Voice chat on. Whisper loads in a few seconds, then just talk and I will answer out loud. Listening pauses while I think and speak. /voice-chat off to stop.',
      }
    }
    await turnOff($)
    return { text: 'Voice chat off. Mic released.' }
  })

  // A typed prompt while voice is on: stop listening until the reply is done.
  // That includes while a reply is still being read out.
  on('prompt.submit', async ($, e, next) => {
    promptCount += 1
    const m = await read($, mode)
    if (m === 'listening' || m === 'hearing' || m === 'speaking') {
      await post($, '/pause')
      await setMode($, 'thinking')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    const m = await read($, mode)
    if (m === 'off' || m === 'starting' || m === 'error') return done
    // Speak in the background so the turn ends now.
    const mine = promptCount
    void (async () => {
      const text = e.reason === 'answer' ? speakable(e.answer) : ''
      if (text) {
        await setMode($, 'speaking')
        try {
          await say($, text)
        } catch {
          // keep going
        }
      }
      // Off, or a newer prompt is already running: its own end reopens the mic.
      if ((await read($, mode)) === 'off' || promptCount !== mine) return
      await post($, '/listen')
      await setMode($, 'listening')
    })()
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
    const bars = 10
    const lit = m === 'listening' || m === 'hearing' ? Math.round(lvl * bars) : 0
    const meter = '▮'.repeat(lit) + '▯'.repeat(bars - lit)
    const color = m === 'error' ? 'error' : m === 'speaking' ? 'claude' : m === 'thinking' ? 'warning' : 'success'
    return (
      <Box flexDirection="row" gap={2}>
        <Text color={color} bold>
          {LABEL[m] ?? ''}
        </Text>
        {(m === 'listening' || m === 'hearing') && <Text color="success">{meter}</Text>}
        {m === 'error' && why !== '' && <Text color="error">{why}</Text>}
        {m !== 'error' && heard !== '' && (
          <Text dimColor>last heard: "{heard.length > 60 ? heard.slice(0, 59) + '…' : heard}"</Text>
        )}
      </Box>
    )
  })
}
