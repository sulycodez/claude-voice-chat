import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'voice-chat',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100 },
} as const

function listener(on: On) {
  const L = { state: 'listening', texts: [] as string[], error: '', posts: [] as string[], polls: 0, up: true }
  on('http.fetch', (_, e) => {
    if (!L.up) throw new Error('connection refused')
    const path = e.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')
    if (e.init?.method === 'POST') {
      L.posts.push(path)
      if (path === '/listen') L.state = 'listening'
      if (path === '/pause') L.state = 'paused'
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    L.polls += 1
    const body = JSON.stringify({ texts: L.texts, state: L.state, level: 0.5, error: L.error })
    L.texts = []
    return { value: { status: 200, ok: true, headers: {}, text: body } }
  })
  return L
}

type Opts = { speakRejects?: boolean; fallbackFails?: boolean }
function engine(on: On, opts: Opts = {}) {
  const spoken: string[] = []
  const prompts: string[] = []
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  let speakDone: (() => void) | undefined
  on('command.register', () => ({ value: { command: 'voice-chat' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    if (e.init?.stdin !== undefined && opts.fallbackFails) throw new Error('powershell missing')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false } }
  })
  on('audio.speak', async (_, e) => {
    if (opts.speakRejects) throw new Error('no synthesizer')
    spoken.push(e.text)
    await new Promise<void>(r => (speakDone = r))
    return { value: { via: 'system' as const } }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { spoken, prompts, runs, finishSpeaking: () => speakDone?.() }
}

const done = (answer: string, extra: Record<string, unknown> = {}) =>
  ({ answer, reason: 'answer', durationMs: 1, isAborted: false, turnId: 't', ...extra }) as never

async function voiceOn($: any, on: On, opts: Opts = {}) {
  const clock = mock.clock(on)
  const L = listener(on)
  const E = engine(on, opts)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.advance(1000)
  return { clock, L, E }
}

async function bandText($: any) {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const t = (await ui.find({ type: 'Text' }))?.text ?? ''
  await ui.unmount()
  return t
}

test('turning off while a reply is read out keeps the mic off afterwards', async ($, on) => {
  const { clock, L, E } = await voiceOn($, on)
  L.texts = ['hello']
  await clock.advance(500)
  await $.turn.complete(done('Hi there.'))
  await clock.settle()
  await $.command.run({ command: 'voice-chat', args: 'off' })
  E.finishSpeaking()
  await clock.advance(1000)
  expect(L.posts).toContain('/quit')
  expect(L.posts).not.toContain('/listen')
})

test('Esc (aborted turn), an API error and an empty answer reopen the mic without speaking', async ($, on) => {
  const { clock, L, E } = await voiceOn($, on)
  for (const end of [
    done('half an ans', { reason: 'aborted', isAborted: true }),
    done('', { reason: 'error' }),
    done(''),
  ]) {
    L.texts = ['question']
    await clock.advance(500)
    L.posts.length = 0
    await $.turn.complete(end)
    await clock.advance(500)
    expect(L.posts).toContain('/listen')
  }
  expect(E.spoken).toEqual([])
})

test("a subagent's end is ignored", async ($, on) => {
  const { clock, L, E } = await voiceOn($, on)
  L.texts = ['question']
  await clock.advance(500)
  await $.turn.complete(done('subagent report', { agentId: 'a1' }))
  await clock.advance(500)
  expect(E.spoken).toEqual([])
  expect(L.posts).not.toContain('/listen')
})

test('long answers are cut, and markdown is made speakable', async ($, on) => {
  const { clock, L, E } = await voiceOn($, on)
  L.texts = ['explain']
  await clock.advance(500)
  const long =
    '# Title\n- **First** point with [a link](https://x.io) and https://y.io/z\n| a | b |\n|---|---|\n' +
    'This is a sentence. '.repeat(80)
  await $.turn.complete(done(long))
  await clock.settle()
  const said = E.spoken[0] ?? ''
  expect(said.endsWith('The rest is on screen.')).toBe(true)
  expect(said.length).toBeLessThan(760)
  expect(said).toContain('First point with a link and a link')
  expect(said).not.toContain('|')
  expect(said).not.toContain('#')
  expect(said).not.toContain('**')
})

test('emoji and symbols are dropped, arrows read as "to", URLs with underscores stay one link', async ($, on) => {
  const { clock, L, E } = await voiceOn($, on)
  L.texts = ['status']
  await clock.advance(500)
  await $.turn.complete(done('✅ Done 🎉 input → output, see https://x.io/a_b_c ✓ café'))
  await clock.settle()
  expect(E.spoken).toEqual(['Done input to output, see a link café'])
})

test('a code-only answer just says the code is on screen', async ($, on) => {
  const { clock, L, E } = await voiceOn($, on)
  L.texts = ['write it']
  await clock.advance(500)
  await $.turn.complete(done('```cpp\nint main() {}\n```'))
  await clock.settle()
  expect(E.spoken).toEqual(['(code on screen)'])
})

test('words heard while Claude is thinking are not sent as a second prompt', async ($, on) => {
  const { clock, L, E } = await voiceOn($, on)
  L.texts = ['first']
  await clock.advance(500)
  L.texts = ['stray words']
  await clock.advance(500)
  expect(E.prompts).toEqual(['first'])
})

test('a listener that dies mid-session shows an error within a few seconds', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  L.up = false
  await clock.advance(4000)
  expect(await bandText($)).toContain('Voice: listener not running')
})

test('if the system voice fails, PowerShell speaks via stdin; if that fails too, the mic still reopens', async ($, on) => {
  const { clock, L, E } = await voiceOn($, on, { speakRejects: true, fallbackFails: true })
  L.texts = ['hi']
  await clock.advance(500)
  await $.turn.complete(done(`It's "quoted" $env:PATH \`tick'`))
  await clock.advance(1000)
  const speech = E.runs.find(r => r.stdin !== undefined)
  expect(speech?.stdin).toBe(`It's "quoted" $env:PATH \`tick'`)
  expect(speech?.argv.join(' ')).not.toContain('quoted')
  expect(L.posts).toContain('/listen')
})

test('/voice-chat on twice does not double the polling', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.advance(100)
  L.polls = 0
  await clock.advance(4000)
  expect(L.polls).toBeLessThan(12)
})

test('arguments: no arg toggles, OFF works in capitals, anything else shows usage and changes nothing', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  const r = await $.command.run({ command: 'voice-chat', args: 'louder' })
  expect(r.text).toContain('/voice-chat on')
  expect(L.posts).not.toContain('/quit')
  await $.command.run({ command: 'voice-chat', args: 'OFF' })
  expect(L.posts).toContain('/quit')
  await $.command.run({ command: 'voice-chat' })
  await clock.advance(1000)
  expect(await bandText($)).toContain('Listening')
})

test('after a reload with voice on, it picks up where it was', async ($, on) => {
  // What the running mod stored before the reload: mode 'listening', in its shape.
  let seeded = true
  on('state.set', (_, e, next) => {
    if (e.key === 'mode') seeded = false
    return next(e)
  })
  on('state.get', (_, e, next) =>
    (seeded && e.key === 'mode'
      ? { value: { value: { shape: 'mode-1', value: 'listening' }, version: 0 } }
      : next(e)) as never,
  )
  const clock = mock.clock(on)
  const L = listener(on)
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  expect(L.polls).toBeGreaterThan(0)
})
