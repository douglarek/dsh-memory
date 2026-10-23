import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'
import { CaptureManager, parseTurnMarkers, renderTurnEntry } from '../lib/capture.js'

function fakeWorkspace() {
  return {
    key: '12345678',
    root: '/tmp/fake-repo',
    projectRoot: '/tmp/fake-repo',
    identity: 'example/fake-repo',
    dirName: 'fake-repo-12345678',
    ephemeral: false,
  }
}

function fakeSession(id = 'session-test-12345678') {
  return { id, header: { cwd: '/tmp/fake-repo' } }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-capture-'))
  const config = resolveConfig({ memoryDir: root, captureMinTurnChars: 1 })
  const store = new MemoryStore({ root, workspace: fakeWorkspace(), config })
  const capture = new CaptureManager({
    config,
    resolveStore: async () => ({ store, workspace: fakeWorkspace() }),
    logger: {},
  })
  return { root, config, store, capture }
}

function emit(capture, session, type, data) {
  capture.observe(session, { type, data, seq: 1, time: Date.now() })
}

test('a completed turn becomes a searchable session log', async () => {
  const { root, store, capture } = await setup()
  try {
    const session = fakeSession()
    emit(capture, session, 'turn/start', { turn: 1 })
    emit(capture, session, 'user/message', {
      role: 'user',
      content: [{ type: 'text', text: 'How does auth work?' }],
      source: { kind: 'user' },
    })
    emit(capture, session, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: 'text', text: 'It uses JWT middleware.' },
          { type: 'tool-call', name: 'read' },
        ],
      },
    })
    emit(capture, session, 'turn/end', { turn: 1 })
    await capture.drain()

    const files = await store.listFiles({ scopes: 'workspace', kinds: 'session' })
    assert.equal(files.length, 1)
    assert.match(files[0].path, /2026-\d{2}-\d{2}-how-does-auth-work-12345678\.md$/)
    const content = await readFile(join(root, files[0].path), 'utf8')
    assert.match(content, /^---/m)
    assert.match(content, /title: "How does auth work\?"/)
    assert.match(content, /<!-- dsh-memory turn=1 -->/)
    assert.match(content, /It uses JWT middleware\./)
    assert.match(content, /\*\*Tools:\*\* `read`/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the same turn is not captured twice and dedup markers are parsed', async () => {
  const { root, store, capture } = await setup()
  try {
    const session = fakeSession('session-dup-87654321')
    emit(capture, session, 'turn/start', { turn: 3 })
    emit(capture, session, 'user/message', {
      role: 'user',
      content: [{ type: 'text', text: 'A repeated turn' }],
      source: { kind: 'user' },
    })
    emit(capture, session, 'turn/end', { turn: 3 })
    await capture.drain()
    emit(capture, session, 'turn/end', { turn: 3 })
    await capture.drain()

    const files = await store.listFiles({ scopes: 'workspace', kinds: 'session' })
    const content = await readFile(join(root, files[0].path), 'utf8')
    assert.equal((content.match(/<!-- dsh-memory turn=3 -->/g) ?? []).length, 1)
    assert.deepEqual([...parseTurnMarkers(content)], [3])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent-assisted turns are not captured', async () => {
  const { root, store, capture } = await setup()
  try {
    const session = fakeSession('session-dream-11112222')
    emit(capture, session, 'turn/start', { turn: 1 })
    emit(capture, session, 'user/message', {
      role: 'user',
      content: [{ type: 'text', text: 'Consolidate memory now.' }],
      source: { kind: 'dsh-memory', form: 'dream' },
    })
    emit(capture, session, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'Consolidated.' }] },
    })
    emit(capture, session, 'turn/end', { turn: 1 })
    await capture.drain()
    const files = await store.listFiles({ scopes: 'workspace', kinds: 'session' })
    assert.equal(files.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('flush returns the last saved file after a completed turn', async () => {
  const { root, capture } = await setup()
  try {
    const session = fakeSession('session-flush-33334444')
    emit(capture, session, 'turn/start', { turn: 1 })
    emit(capture, session, 'user/message', {
      role: 'user',
      content: [{ type: 'text', text: 'Remember this turn.' }],
      source: { kind: 'user' },
    })
    emit(capture, session, 'turn/end', { turn: 1 })
    await capture.drain()
    const path = await capture.flushSession(session)
    assert.ok(typeof path === 'string' && path.endsWith('.md'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('entry rendering is bounded', () => {
  const config = { captureMaxUserChars: 20, captureMaxAssistantChars: 20, captureMaxEntryChars: 400 }
  const entry = renderTurnEntry(
    { turn: 1, user: ['u'.repeat(100)], assistant: 'a'.repeat(100), tools: ['bash', 'read'] },
    config,
  )
  assert.ok(entry.length <= 420)
  assert.match(entry, /turn=1/)
})

test('large sessions rotate into part files without losing turn markers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-rotate-'))
  try {
    const config = resolveConfig({
      memoryDir: root,
      captureMinTurnChars: 1,
      captureMaxFileBytes: 4096,
      captureMaxEntryChars: 6000,
    })
    const workspace = fakeWorkspace()
    const store = new MemoryStore({ root, workspace, config })
    const capture = new CaptureManager({
      config,
      resolveStore: async () => ({ store, workspace }),
      logger: {},
    })
    const session = fakeSession('session-rotate-55556666')
    for (let turn = 1; turn <= 4; turn += 1) {
      emit(capture, session, 'turn/start', { turn })
      emit(capture, session, 'user/message', {
        role: 'user',
        content: [{ type: 'text', text: `turn ${turn} ${'u'.repeat(1800)}` }],
        source: { kind: 'user' },
      })
      emit(capture, session, 'assistant/message', {
        turn,
        step: 1,
        message: { content: [{ type: 'text', text: `answer ${turn} ${'a'.repeat(1800)}` }] },
      })
      emit(capture, session, 'turn/end', { turn })
    }
    await capture.drain()

    const files = await store.listFiles({ scopes: 'workspace', kinds: 'session' })
    assert.ok(files.length >= 2)
    const markers = new Set()
    let totalBytes = 0
    for (const file of files) {
      totalBytes += file.size
      const content = await readFile(join(root, file.path), 'utf8')
      const parsed = parseTurnMarkers(content)
      for (const turn of parsed) {
        assert.equal(markers.has(turn), false, `turn ${turn} was captured twice`)
        markers.add(turn)
      }
    }
    assert.deepEqual([...markers].sort((a, b) => a - b), [1, 2, 3, 4])
    assert.ok(totalBytes > 4096)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
