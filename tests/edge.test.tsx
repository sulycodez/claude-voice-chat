import { expect, mock, test } from 'claude-code/testing'

import { bandText, done, engine, listener, voiceOn } from './fake'

test('turning off while a reply is read out stops it and keeps the mic off', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  L.texts = ['hello']
  await clock.advance(500)
  await $.turn.complete(done('Hi there.'))
  await clock.settle()
  await $.command.run({ command: 'voice-chat', args: 'off' })
  await clock.advance(1000)
  expect(L.posts).toContain('/quit')
  expect(L.posts).not.toContain('/listen')
})

test('Esc (aborted turn), an API error and an empty answer reopen the mic without speaking', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
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
  expect(L.spoken).toEqual([])
})

test("a subagent's end is ignored", async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  L.texts = ['question']
  await clock.advance(500)
  await $.turn.complete(done('subagent report', { agentId: 'a1' }))
  await clock.advance(500)
  expect(L.spoken).toEqual([])
  expect(L.posts).not.toContain('/listen')
})

test('long answers are cut, and markdown is made speakable', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  L.texts = ['explain']
  await clock.advance(500)
  const long =
    '# Title\n- **First** point with [a link](https://x.io) and https://y.io/z\n| a | b |\n|---|---|\n' +
    'This is a sentence. '.repeat(80)
  await $.turn.complete(done(long))
  await clock.settle()
  const said = L.spoken[0]?.text ?? ''
  expect(said.endsWith('The rest is on screen.')).toBe(true)
  expect(said.length).toBeLessThan(760)
  expect(said).toContain('First point with a link and a link')
  expect(said).not.toContain('|')
  expect(said).not.toContain('#')
  expect(said).not.toContain('**')
})

test('emoji and symbols are dropped, arrows read as "to", URLs with underscores stay one link', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  L.texts = ['status']
  await clock.advance(500)
  await $.turn.complete(done('✅ Done \u{1F389} input → output, see https://x.io/a_b_c ✓ café'))
  await clock.settle()
  expect(L.spoken.map(s => s.text)).toEqual(['Done input to output, see a link café'])
})

test('a code-only answer just says the code is on screen', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  L.texts = ['write it']
  await clock.advance(500)
  await $.turn.complete(done('```cpp\nint main() {}\n```'))
  await clock.settle()
  expect(L.spoken.map(s => s.text)).toEqual(['(code on screen)'])
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

test('/voice-chat on twice does not double the polling', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.advance(100)
  L.polls = 0
  await clock.advance(4000)
  expect(L.polls).toBeLessThan(12)
})

test('arguments: no arg toggles, OFF works in capitals, stop when off is harmless, anything else shows usage', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  const r = await $.command.run({ command: 'voice-chat', args: 'louder' })
  expect(r.text).toContain('/voice-chat stop')
  expect(L.posts).not.toContain('/quit')
  await $.command.run({ command: 'voice-chat', args: 'OFF' })
  expect(L.posts).toContain('/quit')
  const s = await $.command.run({ command: 'voice-chat', args: 'stop' })
  expect(s.text).toBe('Voice chat is off.')
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
