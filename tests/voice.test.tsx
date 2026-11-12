import { expect, mock, test } from 'claude-code/testing'

import { BAND, bandText, done, engine, listener, voiceOn } from './fake'

test('a spoken prompt is sent, the reply is read out, then the mic reopens', async ($, on) => {
  const { clock, L, E } = await voiceOn($, on)
  L.texts = ['what is binary search']
  await clock.advance(500)
  expect(E.prompts).toEqual(['what is binary search'])

  await $.turn.complete(done('It halves the range each step. ```cpp\nint x;\n``` Done.'))
  await clock.settle()
  expect(L.spoken.length).toBe(1)
  expect(L.spoken[0]?.text).toContain('(code on screen)')
  expect(L.spoken[0]?.voice).toBe('Microsoft Hazel Desktop')
  expect(await bandText($)).toContain('Speaking')

  L.state = 'listening' // the listener finished reading it out
  await clock.advance(500)
  expect(await bandText($)).toContain('Listening')
})

test('talking over a reply: what you said becomes the next prompt', async ($, on) => {
  const { clock, L, E } = await voiceOn($, on)
  L.texts = ['explain binary search']
  await clock.advance(500)
  await $.turn.complete(done('A very long answer. '.repeat(20)))
  await clock.settle()

  L.state = 'transcribing' // the listener heard you over the reply and cut it
  await clock.advance(500)
  expect(await bandText($)).toContain('Transcribing')
  L.texts = ['actually just give me the short version']
  await clock.advance(500)
  expect(E.prompts).toEqual(['explain binary search', 'actually just give me the short version'])
})

test('typing while a reply is read out stops it and keeps the mic closed for that turn', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  L.texts = ['first question']
  await clock.advance(500)
  await $.turn.complete(done('A long answer.'))
  await clock.settle()

  await $.prompt.submit({ text: 'typed follow up' })
  expect(L.posts).toContain('/pause')
  await clock.advance(1000)
  expect(L.posts).not.toContain('/listen')
  expect(await bandText($)).toContain('Thinking')
})

test('/voice-chat stop cuts the reply short and listens', async ($, on) => {
  const { clock, L } = await voiceOn($, on)
  L.texts = ['question']
  await clock.advance(500)
  await $.turn.complete(done('A long answer.'))
  await clock.settle()
  const r = await $.command.run({ command: 'voice-chat', args: 'stop' })
  expect(L.posts).toContain('/stop')
  expect(r.text).toContain('Listening')
  await clock.advance(500)
  expect(await bandText($)).toContain('Listening')
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

test('a listener from an older version is replaced', async ($, on) => {
  const clock = mock.clock(on)
  const L = listener(on)
  const E = engine(on)
  L.version = undefined
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.advance(2000)
  expect(L.posts).toContain('/quit')
  expect(E.runs.length).toBe(1)
})

test('no python on PATH is reported at once', async ($, on) => {
  const clock = mock.clock(on)
  const L = listener(on)
  engine(on, { startExit: 1 })
  L.up = false
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.settle()
  expect(await bandText($)).toContain('Voice')
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /python/ }))?.text).toContain('PATH')
  await ui.unmount()
})
