import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../lib/config.js'
import { MemoryStore } from '../lib/store.js'

function fakeWorkspace(overrides = {}) {
  return {
    key: '12345678',
    root: '/tmp/fake-repo',
    projectRoot: '/tmp/fake-repo',
    identity: 'example/fake-repo',
    dirName: 'fake-repo-12345678',
    ephemeral: false,
    ...overrides,
  }
}

async function withStore(callback, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-store-'))
  try {
    const config = resolveConfig({
      memoryDir: root,
      searchMinScore: 0,
      searchMmrEnabled: false,
      ...overrides,
    })
    const workspace = fakeWorkspace()
    const store = new MemoryStore({ root, workspace, config })
    return await callback({ store, config, root, workspace })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('remember writes a topic, observations, and a generated index', async () => {
  await withStore(async ({ store, root }) => {
    const topic = await store.remember({ text: 'Auth uses JWT.', scope: 'workspace', topic: 'auth' })
    assert.equal(topic.created, true)
    assert.equal(topic.path, 'workspaces/fake-repo-12345678/topics/auth.md')
    const content = await readFile(join(root, topic.path), 'utf8')
    assert.match(content, /^# auth/m)
    assert.match(content, /Auth uses JWT/)

    const observation = await store.remember({ text: 'Build with pnpm test.', scope: 'workspace' })
    assert.match(observation.path, /observations\/_inbox\/\d+-.+\.md$/)
    const observationContent = await readFile(join(root, observation.path), 'utf8')
    assert.match(observationContent, /^---/)
    assert.match(observationContent, /## Build with pnpm test\./)

    const index = await readFile(join(root, 'workspaces/fake-repo-12345678/MEMORY.md'), 'utf8')
    assert.match(index, /# Workspace memory index/)
    assert.match(index, /workspaces\/fake-repo-12345678\/topics\/auth\.md/)
  })
})

test('remember deduplicates the same note', async () => {
  await withStore(async ({ store }) => {
    const first = await store.remember({ text: 'Use pnpm.', scope: 'workspace', topic: 'build' })
    const second = await store.remember({ text: 'Use pnpm.', scope: 'workspace', topic: 'build' })
    assert.equal(first.created, true)
    assert.equal(second.created, false)
  })
})

test('global and workspace scopes stay separate', async () => {
  await withStore(async ({ store, root }) => {
    await store.remember({ text: 'Prefer Chinese replies.', scope: 'global', topic: 'preferences' })
    await store.remember({ text: 'Project uses Vite.', scope: 'workspace', topic: 'build' })
    const global = await store.listFiles({ scopes: 'global', kinds: 'topic', readTitle: true })
    const workspace = await store.listFiles({ scopes: 'workspace', kinds: 'topic', readTitle: true })
    assert.deepEqual(global.map((file) => file.path), ['global/topics/preferences.md'])
    assert.deepEqual(workspace.map((file) => file.path), ['workspaces/fake-repo-12345678/topics/build.md'])
    assert.ok((await readFile(join(root, 'global/MEMORY.md'), 'utf8')).includes('global/topics/preferences.md'))
  })
})

test('search finds Latin and Chinese content with source filters', async () => {
  await withStore(async ({ store }) => {
    await store.remember({ text: 'Auth middleware lives in src/auth.ts and uses JWT.', scope: 'workspace', topic: 'auth' })
    await store.remember({ text: '用户偏好中文回复。', scope: 'global', topic: '偏好' })

    const latin = await store.search({ query: 'auth middleware JWT', minScore: 0 })
    assert.equal(latin.results.length, 1)
    assert.equal(latin.results[0].path, 'workspaces/fake-repo-12345678/topics/auth.md')
    assert.equal(latin.results[0].source, 'workspace')

    const chinese = await store.search({ query: '中文回复', minScore: 0 })
    assert.equal(chinese.results.length, 1)
    assert.equal(chinese.results[0].source, 'global')

    const sessions = await store.search({ query: 'auth', source: 'session', minScore: 0 })
    assert.equal(sessions.results.length, 0)
  })
})

test('read numbers lines and accepts workspace aliases', async () => {
  await withStore(async ({ store }) => {
    await store.remember({ text: 'line one\nline two', scope: 'workspace', topic: 'notes' })
    const result = await store.read({ path: 'workspace/topics/notes.md', from: 1, lines: 2 })
    assert.equal(result.path, 'workspaces/fake-repo-12345678/topics/notes.md')
    assert.match(result.content, /^1→# notes\n2→/)
    assert.equal(result.total_lines >= 4, true)

    const index = await store.read({ path: 'MEMORY.md', lines: 1 })
    assert.equal(index.path, 'workspaces/fake-repo-12345678/MEMORY.md')
  })
})

test('read rejects paths outside the memory root', async () => {
  await withStore(async ({ store }) => {
    await assert.rejects(() => store.read({ path: '/etc/passwd' }), /not found/)
    await assert.rejects(() => store.read({ path: '../../etc/passwd' }), /not found/)
  })
})

test('manifest includes topics, observations, and recent sessions', async () => {
  await withStore(async ({ store }) => {
    await store.remember({ text: 'Project uses Vite.', scope: 'workspace', topic: 'build' })
    await store.remember({ text: 'User prefers Chinese.', scope: 'global', topic: 'preferences' })
    const manifest = await store.manifest({})
    assert.match(manifest, /^<memory-context>/)
    assert.match(manifest, /Global memory/)
    assert.match(manifest, /Workspace memory/)
    assert.match(manifest, /global\/topics\/preferences\.md/)
    assert.match(manifest, /workspaces\/fake-repo-12345678\/topics\/build\.md/)
    assert.match(manifest, /<\/memory-context>$/)
  })
})

test('empty memory returns no manifest unless always is set', async () => {
  await withStore(async ({ store }) => {
    assert.equal(await store.manifest({}), '')
    assert.match(await store.manifest({ always: true }), /no notes or session logs/i)
  })
})

test('forget removes an exact path and best-effort query matches', async () => {
  await withStore(async ({ store, root }) => {
    const topic = await store.remember({ text: 'Auth uses JWT.', scope: 'workspace', topic: 'auth' })
    await store.remember({ text: 'Build uses pnpm.', scope: 'workspace', topic: 'build' })
    const deleted = await store.forget({ path: topic.path })
    assert.equal(deleted.count, 1)
    await assert.rejects(() => access(join(root, topic.path)))

    const query = await store.forget({ query: 'pnpm', scope: 'workspace' })
    assert.equal(query.count, 1)
    const remaining = await store.listFiles({ scopes: 'workspace', kinds: 'topic' })
    assert.equal(remaining.length, 0)
  })
})

test('clear removes only the requested scope', async () => {
  await withStore(async ({ store, root }) => {
    await store.remember({ text: 'Global note.', scope: 'global', topic: 'g' })
    await store.remember({ text: 'Workspace note.', scope: 'workspace', topic: 'w' })
    const result = await store.clear('workspace')
    assert.deepEqual(result.removed, ['workspaces/fake-repo-12345678'])
    await assert.rejects(() => access(join(root, 'workspaces/fake-repo-12345678')))
    await access(join(root, 'global/MEMORY.md'))
  })
})

test('forget query removes only matching lines and keeps sibling notes', async () => {
  await withStore(async ({ store, root }) => {
    const topic = await store.remember({ text: 'Keep this note.', scope: 'workspace', topic: 'mixed' })
    await store.remember({ text: 'Remove this obsolete note.', scope: 'workspace', topic: 'mixed' })
    const result = await store.forget({ query: 'obsolete', scope: 'workspace' })
    assert.equal(result.count, 1)
    const content = await readFile(join(root, topic.path), 'utf8')
    assert.match(content, /Keep this note/)
    assert.doesNotMatch(content, /obsolete/)
  })
})

test('manifest stays within a small byte budget and closes its frame', async () => {
  await withStore(
    async ({ store }) => {
      for (let index = 0; index < 20; index += 1) {
        await store.remember({
          text: `Note ${index} ${'x'.repeat(200)}`,
          scope: 'workspace',
          topic: `topic-${index}`,
        })
      }
      const manifest = await store.manifest({ maxBytes: 512 })
      assert.ok(Buffer.byteLength(manifest, 'utf8') <= 512)
      assert.match(manifest, /^<memory-context>/)
      assert.match(manifest, /<\/memory-context>$/)
      assert.ok(manifest.length > 100)
    },
    { injectMaxBytes: 512 },
  )
})
