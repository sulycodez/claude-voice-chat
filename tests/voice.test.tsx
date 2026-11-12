import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'voice-chat',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100 },
} as const

/** A fake listener on 127.0.0.1: what /poll answers, and every POST it gets. */
function listener(on: On) {
  const L = { state: 'listening', texts: [] as string[], error: '', posts: [] as string[], up: true }
  on('http.fetch', (_, e) => {
    if (!L.up) throw new Error('connection refused')
    const path = e.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')
    if (e.init?.method === 'POST') {
      L.posts.push(path)
      if (path === '/listen') L.state = 'listening'
      if (path === '/pause') L.state = 'paused'
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    const body = JSON.stringify({ texts: L.texts, state: L.state, level: 0.5, error: L.error })
    L.texts = []
    return { value: { status: 200, ok: true, headers: {}, text: body } }
  })
  return L
}

function engine(on: On, opts: { startExit?: number } = {}) {
  const spoken: string[] = []
  const prompts: string[] = []
  let speakDone: (() => void) | undefined
  on('command.register', () => ({ value: { command: 'voice-chat' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: opts.startExit ?? 0, stdout: '', stderr: '', isStdoutTruncated: false } }))
  on('audio.speak', async (_, e) => {
    spoken.push(e.text)
    await new Promise<void>(r => (speakDone = r))
    return { value: { via: 'system' as const } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { spoken, prompts, finishSpeaking: () => speakDone?.() }
}

const answer = (text: string) =>
  ({ answer: text, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't' }) as const

test('a spoken prompt is sent, the reply is read out, then the mic reopens', async ($, on) => {
  const clock = mock.clock(on)
  const L = listener(on)
  const E = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.advance(1000)

  L.texts = ['what is binary search']
  await clock.advance(500)
  expect(E.prompts).toEqual(['what is binary search'])

  await $.turn.complete(answer('It halves the range each step. ```cpp\nint x;\n``` Done.'))
  await clock.settle()
  expect(E.spoken.length).toBe(1)
  expect(E.spoken[0]).toContain('(code on screen)')
  expect(L.posts).not.toContain('/listen')

  E.finishSpeaking()
  await clock.advance(500)
  expect(L.posts).toContain('/listen')
})

test('typing while a reply is being read out keeps the mic closed for that turn', async ($, on) => {
  const clock = mock.clock(on)
  const L = listener(on)
  const E = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.advance(1000)
  L.texts = ['first question']
  await clock.advance(500)
  await $.turn.complete(answer('A long answer.'))
  await clock.settle()

  // Typed while speaking: the mic pauses, and the old reply finishing must not reopen it.
  await $.prompt.submit({ text: 'typed follow up' })
  expect(L.posts).toContain('/pause')
  E.finishSpeaking()
  await clock.advance(1000)
  expect(L.posts).not.toContain('/listen')
})

test('a listener that fails says why in the band', async ($, on) => {
  const clock = mock.clock(on)
  const L = listener(on)
  engine(on)
  L.state = 'error'
  L.error = "ModuleNotFoundError: No module named 'sounddevice'"
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.advance(2600) // the failed one is replaced, and the new one fails the same way
  expect(L.posts).toContain('/quit')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /sounddevice/ }))?.text).toContain('sounddevice')
    await ui.unmount()
  }
})

test('no python on PATH is reported at once', async ($, on) => {
  const clock = mock.clock(on)
  const L = listener(on)
  engine(on, { startExit: 1 })
  L.up = false
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /python/ }))?.text).toContain('PATH')
  await ui.unmount()
})
