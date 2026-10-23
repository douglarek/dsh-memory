import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSearchIndex, decayMultiplier, jaccard, searchIndex } from '../lib/search.js'

const config = {
  chunkMaxChars: 1600,
  chunkOverlapChars: 0,
  searchMaxChunks: 100,
}

const now = Date.now()
const day = 86_400_000

function doc(path, source, content, ageDays = 0, title = path) {
  return { path, source, content, mtimeMs: now - ageDays * day, title }
}

test('BM25 ranks the more relevant document first', () => {
  const docs = [
    doc('workspaces/a/topics/auth.md', 'workspace', '# Auth\n\nAuth middleware uses JWT.'),
    doc('workspaces/a/topics/build.md', 'workspace', '# Build\n\nBuild with pnpm test.'),
  ]
  const index = buildSearchIndex(docs, config)
  const results = searchIndex(index, 'auth middleware', ['auth', 'middleware'], {
    minScore: 0,
    mmrEnabled: false,
    halfLifeDays: 30,
    sourceWeights: { global: 1, workspace: 1, session: 1 },
  })
  assert.equal(results.length, 1)
  assert.equal(results[0].path, 'workspaces/a/topics/auth.md')
  assert.equal(results[0].score, 1)
})

test('temporal decay lowers old session memory but not curated memory', () => {
  const docs = [
    doc('workspaces/a/sessions/old.md', 'session', 'auth middleware decision', 60),
    doc('workspaces/a/sessions/new.md', 'session', 'auth middleware decision', 1),
    doc('workspaces/a/topics/auth.md', 'workspace', 'auth middleware decision', 60),
  ]
  const index = buildSearchIndex(docs, config)
  const results = searchIndex(index, 'auth middleware', ['auth', 'middleware'], {
    minScore: 0,
    mmrEnabled: false,
    halfLifeDays: 30,
    sourceWeights: { global: 1, workspace: 1, session: 1 },
  })
  const byPath = new Map(results.map((entry) => [entry.path, entry]))
  assert.ok(byPath.get('workspaces/a/sessions/new.md').rawScore > byPath.get('workspaces/a/sessions/old.md').rawScore)
  assert.ok(byPath.get('workspaces/a/topics/auth.md').rawScore > byPath.get('workspaces/a/sessions/old.md').rawScore)
})

test('source weights apply per source', () => {
  const docs = [
    doc('workspaces/a/sessions/s.md', 'session', 'alpha beta gamma'),
    doc('workspaces/a/topics/a.md', 'workspace', 'alpha beta gamma'),
  ]
  const index = buildSearchIndex(docs, config)
  const results = searchIndex(index, 'alpha beta gamma', ['alpha', 'beta', 'gamma'], {
    minScore: 0,
    mmrEnabled: false,
    halfLifeDays: 0,
    sourceWeights: { global: 1, workspace: 1, session: 0.1 },
  })
  const session = results.find((entry) => entry.source === 'session')
  const workspace = results.find((entry) => entry.source === 'workspace')
  assert.ok(workspace.score > session.score)
})

test('MMR prefers a diverse second result over a near duplicate', () => {
  const docs = [
    doc('workspaces/a/topics/a.md', 'workspace', 'auth middleware auth middleware auth middleware'),
    doc('workspaces/a/topics/b.md', 'workspace', 'auth middleware auth middleware auth middleware'),
    doc('workspaces/a/topics/c.md', 'workspace', 'auth middleware plus many other unique words to diversify the result'),
  ]
  const index = buildSearchIndex(docs, config)
  const terms = ['auth', 'middleware']
  const withoutMmr = searchIndex(index, 'auth middleware', terms, {
    minScore: 0,
    mmrEnabled: false,
    halfLifeDays: 0,
    sourceWeights: { global: 1, workspace: 1, session: 1 },
  })
  const withMmr = searchIndex(index, 'auth middleware', terms, {
    minScore: 0,
    mmrEnabled: true,
    mmrLambda: 0.3,
    halfLifeDays: 0,
    sourceWeights: { global: 1, workspace: 1, session: 1 },
  })
  assert.equal(withoutMmr.length, 3)
  assert.equal(withMmr.length, 3)
  assert.equal(withMmr[0].path, 'workspaces/a/topics/a.md')
  assert.equal(withMmr[1].path, 'workspaces/a/topics/c.md')
})

test('decayMultiplier is evergreen for curated sources', () => {
  assert.equal(decayMultiplier('global', now - 100 * day, now, 30), 1)
  assert.equal(decayMultiplier('workspace', now - 100 * day, now, 30), 1)
  assert.equal(decayMultiplier('session', now, now, 30), 1)
  assert.ok(decayMultiplier('session', now - 30 * day, now, 30) < 0.51)
  assert.equal(decayMultiplier('session', now - 100 * day, now, 0), 1)
})

test('jaccard compares token sets', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1)
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0)
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3)
})
