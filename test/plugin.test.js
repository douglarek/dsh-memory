import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

function createFakeContext() {
  const tools = new Map()
  const commands = new Map()
  const sections = []
  const listeners = new Map()
  const disposers = []
  return {
    toolDefinitions: tools,
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
      get(name) {
        return tools.get(name)
      },
    },
    commands,
    sections,
    listeners,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(service) {
      if (service === 'systemPrompt') {
        return {
          section(section) {
            sections.push(section)
            return () => {}
          },
        }
      }
      if (service === 'commands') {
        return {
          register(definition) {
            commands.set(definition.name, definition)
            return () => {}
          },
        }
      }
      return undefined
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {}
    },
    effect(effect) {
      const disposer = effect()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    async dispose() {
      for (const disposer of disposers.reverse()) await disposer()
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

function fakeAgent(session, follows = []) {
  return {
    session,
    followup(message) {
      follows.push(message)
    },
  }
}

function fakeSession(id = 'session-plugin-12345678') {
  return {
    id,
    header: { cwd: process.cwd() },
    surface: { nodes: [] },
    eventAt() {
      return undefined
    },
  }
}

async function setup(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-plugin-'))
  const ctx = createFakeContext()
  apply(ctx, {
    memoryDir: root,
    injectAlways: true,
    searchMinScore: 0,
    captureMinTurnChars: 1,
    ...overrides,
  })
  const session = fakeSession()
  const agent = fakeAgent(session)
  const signal = new AbortController().signal
  return {
    root,
    ctx,
    agent,
    session,
    signal,
    async cleanup() {
      await ctx.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('apply registers tools, commands, and a prompt section', async () => {
  const { ctx, cleanup } = await setup()
  try {
    assert.deepEqual([...ctx.toolDefinitions.keys()].sort(), [
      'memory_forget',
      'memory_get',
      'memory_list',
      'memory_remember',
      'memory_search',
    ])
    assert.deepEqual([...ctx.commands.keys()].sort(), ['dream', 'flush', 'forget', 'memory', 'remember'])
    assert.equal(ctx.sections.length, 1)
    assert.equal(ctx.sections[0].name, 'dsh-memory:instructions')
    assert.equal(ctx.sections[0].interpolate, false)
    assert.match(ctx.sections[0].text, /memory_search/)
  } finally {
    await cleanup()
  }
})

test('tools remember, search, get, list, and forget', async () => {
  const { ctx, agent, signal, cleanup } = await setup()
  try {
    const remember = ctx.tools.get('memory_remember')
    const saved = await remember.execute(
      { text: 'Auth middleware lives in src/auth.ts and uses JWT.', scope: 'workspace', topic: 'auth' },
      { agent, signal },
    )
    assert.equal(saved.created, true)
    assert.match(saved.path, /topics\/auth\.md$/)

    const search = ctx.tools.get('memory_search')
    const found = await search.execute({ query: 'auth JWT' }, { agent, signal })
    assert.equal(found.total, 1)
    assert.equal(found.results[0].path, saved.path)

    const get = ctx.tools.get('memory_get')
    const read = await get.execute({ path: saved.path }, { agent, signal })
    assert.match(read.content, /^1→# auth/)
    assert.equal(read.truncated, false)

    const list = ctx.tools.get('memory_list')
    const inventory = await list.execute({ scope: 'workspace' }, { agent, signal })
    assert.ok(inventory.files.some((file) => file.path === saved.path))
    assert.ok(inventory.files.some((file) => file.kind === 'index'))

    const forget = ctx.tools.get('memory_forget')
    const removed = await forget.execute({ path: saved.path }, { agent, signal })
    assert.equal(removed.count, 1)
    const after = await search.execute({ query: 'auth JWT' }, { agent, signal })
    assert.equal(after.total, 0)
  } finally {
    await cleanup()
  }
})

test('first pre-step injects the manifest once', async () => {
  const { ctx, agent, signal, cleanup } = await setup()
  try {
    const remember = ctx.tools.get('memory_remember')
    await remember.execute({ text: 'Build with pnpm test.', scope: 'workspace', topic: 'build' }, { agent, signal })
    const userMessage = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'How do I build?' }], source: { kind: 'user' } }
    const preStep = ctx.listeners.get('agent/pre-step')[0]
    const first = await preStep(
      { agent, messages: [userMessage], step: 1, signal },
      async () => ({ kind: 'enter', messages: [userMessage] }),
    )
    assert.equal(first.messages.length, 2)
    assert.equal(first.messages[1].source.kind, 'dsh-memory')
    assert.equal(first.messages[1].source.form, 'baseline')
    assert.match(first.messages[1].content[0].text, /Build with pnpm test/)

    const second = await preStep(
      { agent, messages: [userMessage], step: 2, signal },
      async () => ({ kind: 'enter', messages: [userMessage] }),
    )
    assert.equal(second.messages.length, 1)
  } finally {
    await cleanup()
  }
})

test('compaction triggers a refresh injection', async () => {
  const { ctx, agent, session, signal, cleanup } = await setup()
  try {
    const remember = ctx.tools.get('memory_remember')
    await remember.execute({ text: 'Build with pnpm test.', scope: 'workspace', topic: 'build' }, { agent, signal })
    const userMessage = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'How do I build?' }], source: { kind: 'user' } }
    const preStep = ctx.listeners.get('agent/pre-step')[0]
    await preStep({ agent, messages: [userMessage], step: 1, signal }, async () => ({ kind: 'enter', messages: [userMessage] }))
    ctx.emit('session/event', session, { type: 'compaction/end', data: {} })
    const refresh = await preStep(
      { agent, messages: [userMessage], step: 3, signal },
      async () => ({ kind: 'enter', messages: [userMessage] }),
    )
    assert.equal(refresh.messages.length, 2)
    assert.equal(refresh.messages[1].source.form, 'refresh')
  } finally {
    await cleanup()
  }
})

test('capture writes a session log and /flush reports it', async () => {
  const { ctx, agent, session, root, cleanup } = await setup()
  try {
    const userMessage = { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Capture this turn.' }], source: { kind: 'user' } }
    ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    ctx.emit('session/event', session, userMessage ? { type: 'user/message', data: userMessage } : {})
    ctx.emit('session/event', session, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Captured.' }] } },
    })
    ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1 } })
    const flush = ctx.commands.get('flush')
    const result = await flush.handler({ agent, rawInput: '', signal: new AbortController().signal })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /Session transcript saved to workspaces\/.+\/sessions\/.+\.md/)
    const relative = result.text.replace('Session transcript saved to ', '')
    const content = await readFile(join(root, relative), 'utf8')
    assert.match(content, /Capture this turn\./)
    assert.match(content, /Captured\./)
  } finally {
    await cleanup()
  }
})

test('commands remember, list, search, show, and clear', async () => {
  const { ctx, agent, signal, cleanup } = await setup()
  try {
    const remember = ctx.commands.get('remember')
    const saved = await remember.handler({ agent, rawInput: '--topic auth Use JWT middleware', signal })
    assert.equal(saved.kind, 'success')
    assert.match(saved.text, /Memory saved to /)

    const memory = ctx.commands.get('memory')
    const listed = await memory.handler({ agent, rawInput: '', signal })
    assert.match(listed.text, /Memory is enabled/)
    assert.match(listed.text, /auth/)

    const search = await memory.handler({ agent, rawInput: 'search JWT', signal })
    assert.match(search.text, /Found 1 memory result/)

    const show = await memory.handler({ agent, rawInput: 'show workspace/topics/auth.md', signal })
    assert.match(show.text, /JWT middleware/)

    const refused = await memory.handler({ agent, rawInput: 'clear global', signal })
    assert.equal(refused.kind, 'error')
    assert.match(refused.text, /--yes/)

    const cleared = await memory.handler({ agent, rawInput: 'clear global --yes', signal })
    assert.equal(cleared.kind, 'success')
  } finally {
    await cleanup()
  }
})

test('/dream queues one consolidation turn', async () => {
  const { ctx, agent, cleanup } = await setup()
  try {
    const follows = []
    const target = { session: agent.session, followup: (message) => follows.push(message) }
    const dream = ctx.commands.get('dream')
    const result = await dream.handler({ agent: target, rawInput: '', signal: new AbortController().signal })
    assert.equal(result.kind, 'success')
    assert.equal(follows.length, 1)
    assert.equal(follows[0].source.kind, 'dsh-memory')
    assert.equal(follows[0].source.form, 'dream')
    assert.match(follows[0].content[0].text, /memory_list/)
  } finally {
    await cleanup()
  }
})

test('disabled config registers nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-disabled-'))
  const ctx = createFakeContext()
  try {
    apply(ctx, { memoryDir: root, enabled: false })
    assert.equal(ctx.toolDefinitions.size, 0)
    assert.equal(ctx.commands.size, 0)
    assert.equal(ctx.sections.length, 0)
  } finally {
    await ctx.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
