import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const BAND = {
  plugin: 'voice-chat',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100 },
} as const

/** A fake listener on 127.0.0.1: what /poll answers, every POST it gets, and what it was asked to say. */
export function listener(on: On) {
  const L = {
    state: 'listening',
    texts: [] as string[],
    error: '',
    version: 5 as number | undefined,
    posts: [] as string[],
    spoken: [] as { text: string; voice: string }[],
    polls: 0,
    up: true,
  }
  on('http.fetch', (_, e) => {
    if (!L.up) throw new Error('connection refused')
    const path = e.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')
    if (e.init?.method === 'POST') {
      L.posts.push(path)
      if (path === '/listen' || path === '/stop') L.state = 'listening'
      if (path === '/pause') L.state = 'paused'
      if (path === '/speak') {
        L.spoken.push(JSON.parse(String(e.init.body)))
        L.state = 'speaking'
      }
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    L.polls += 1
    const body = JSON.stringify({ texts: L.texts, state: L.state, level: 0.5, error: L.error, version: L.version })
    L.texts = []
    return { value: { status: 200, ok: true, headers: {}, text: body } }
  })
  return L
}

/** Everything beneath the plugin that isn't the listener. */
export function engine(on: On, opts: { startExit?: number } = {}) {
  const prompts: string[] = []
  const runs: (readonly string[])[] = []
  on('command.register', () => ({ value: { command: 'voice-chat' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push(e.argv)
    return { value: { exitCode: opts.startExit ?? 0, stdout: '', stderr: '', isStdoutTruncated: false } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { prompts, runs }
}

export const done = (answer: string, extra: Record<string, unknown> = {}) =>
  ({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', ...extra }) as never

export async function voiceOn($: any, on: On, opts: { startExit?: number } = {}) {
  const clock = mock.clock(on)
  const L = listener(on)
  const E = engine(on, opts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.advance(1000)
  return { clock, L, E }
}

export async function bandText($: any, surface: 'terminal' | 'desktop' = 'desktop') {
  const ui = await $.ui.mount({ ...BAND, surface })
  const t = (await ui.find({ type: 'Text' }))?.text ?? ''
  await ui.unmount()
  return t
}
