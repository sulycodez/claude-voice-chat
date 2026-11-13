import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bandText, voiceOn } from './fake'

/** Records the effort each model request of a turn goes out with. */
function steps(on: On) {
  const seen: { turnId: string; effort: unknown; agentId?: string }[] = []
  on('turn.step', async function* (_, e) {
    seen.push({ turnId: e.turnId, effort: e.effort, agentId: e.agentId })
    yield* []
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  return seen
}

async function step($: any, turnId: string, agentId?: string) {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'opus', messageCount: 1, ...(agentId ? { agentId } : {}) })) {
    // drain
  }
}

/** The sorting call auto mode makes: answers with `word`, after `delayMs` on the mocked clock. */
function sorter(on: On, word: string, clock?: { sleep: (ms: number) => Promise<void> }, delayMs = 0) {
  const asked: string[] = []
  on('model.complete', async (_, e) => {
    asked.push(String(e.prompt))
    if (clock && delayMs) await clock.sleep(delayMs)
    return { value: { isAnswered: true, text: word, usage: {} } as never }
  })
  return asked
}

for (const [speed, effort] of [['quick', 'low'], ['balanced', 'medium'], ['thorough', 'high']] as const) {
  test(`speed ${speed}: a spoken question's turn thinks at ${effort} effort`, async ($, on) => {
    const seen = steps(on)
    const { clock, L } = await voiceOn($, on)
    const r = await $.command.run({ command: 'voice-chat', args: `speed ${speed}` })
    expect(r.text).toContain(`Speed set to ${speed}`)
    L.texts = ['what is the date']
    await clock.advance(500)
    await $.turn.start({ text: 'what is the date', turnId: 'v1' })
    await step($, 'v1')
    await step($, 'v1') // every model request of that turn, not just the first
    expect(seen.map(s => s.effort)).toEqual([effort, effort])
  })
}

test('auto: a quick question gets low effort, a deep one high', async ($, on) => {
  const seen = steps(on)
  const clock = mock.clock(on)
  let word = 'QUICK'
  on('model.complete', async () => ({ value: { isAnswered: true, text: word, usage: {} } as never }))
  const { L } = await voiceOnWith($, on, clock)
  L.texts = ['what is the date today']
  await clock.advance(500)
  await $.turn.start({ text: 'x', turnId: 'q1' })
  await step($, 'q1')
  await $.turn.complete({ answer: 'Friday.', reason: 'answer', durationMs: 1, isAborted: false, turnId: 'q1' } as never)
  L.state = 'listening'
  await clock.advance(500)

  word = 'DEEP'
  L.texts = ['explain how a hash map handles collisions']
  await clock.advance(500)
  await $.turn.start({ text: 'y', turnId: 'q2' })
  await step($, 'q2')
  expect(seen.map(s => s.effort)).toEqual(['low', 'high'])
})

test('auto: if sorting takes over 2 s, it goes ahead at medium', async ($, on) => {
  const seen = steps(on)
  const clock = mock.clock(on)
  sorter(on, 'QUICK', clock, 5000)
  const { L, E } = await voiceOnWith($, on, clock)
  L.texts = ['hello there']
  await clock.advance(400) // the poll that picks it up
  await clock.advance(2100) // the sorter is still thinking: give up on it
  expect(E.prompts).toEqual(['hello there'])
  await $.turn.start({ text: 'x', turnId: 's1' })
  await step($, 's1')
  expect(seen.map(s => s.effort)).toEqual(['medium'])
})

test('typed prompts and subagents keep the session effort', async ($, on) => {
  const seen = steps(on)
  const { clock, L } = await voiceOn($, on)
  await $.command.run({ command: 'voice-chat', args: 'speed quick' })
  L.texts = ['spoken one']
  await clock.advance(500)
  await $.turn.start({ text: 'x', turnId: 'v1' })
  await step($, 'v1', 'sub-agent-1') // a subagent inside the spoken turn
  await $.turn.complete({ answer: '', reason: 'answer', durationMs: 1, isAborted: false, turnId: 'v1' } as never)
  await $.prompt.submit({ text: 'typed one' })
  await $.turn.start({ text: 'typed one', turnId: 't1' })
  await step($, 't1')
  expect(seen.map(s => s.effort)).toEqual([undefined, undefined])
})

test('/voice-chat speed shows, sets and rejects, and the band shows it', async ($, on) => {
  const { clock } = await voiceOn($, on)
  expect((await $.command.run({ command: 'voice-chat', args: 'speed' })).text).toContain('Speed is auto')
  expect((await $.command.run({ command: 'voice-chat', args: 'speed turbo' })).text).toContain('Speed options')
  await $.command.run({ command: 'voice-chat', args: 'speed thorough' })
  await clock.advance(500)
  const ui = await $.ui.mount({
    plugin: 'voice-chat',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100 },
    surface: 'desktop',
  })
  expect((await ui.find({ type: 'Text', text: /speed:/ }))?.text).toBe('speed: thorough')
  await ui.unmount()
  expect(await bandText($)).toContain('Listening')
})

/** voiceOn with a clock the test already made (mock.clock can only be set up once). */
async function voiceOnWith($: any, on: On, clock: { advance: (ms: number) => Promise<void> }) {
  const { listener, engine } = await import('./fake')
  const L = listener(on)
  const E = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'voice-chat', args: 'on' })
  await clock.advance(1000)
  return { L, E }
}
