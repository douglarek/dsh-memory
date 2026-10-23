import assert from 'node:assert/strict'
import test from 'node:test'
import { queryTerms, tokenize, truncateText, makeSnippet, ageDays } from '../lib/text.js'

test('tokenize keeps Latin words and adds CJK unigrams and bigrams', () => {
  const tokens = tokenize('Hello, 世界 memory_search Vite 构建前端')
  assert.ok(tokens.includes('hello'))
  assert.ok(tokens.includes('memory_search'))
  assert.ok(tokens.includes('vite'))
  assert.ok(tokens.includes('世'))
  assert.ok(tokens.includes('界'))
  assert.ok(tokens.includes('世界'))
  assert.ok(tokens.includes('构'))
  assert.ok(tokens.includes('构建'))
  assert.ok(tokens.includes('建前'))
  assert.ok(tokens.includes('前端'))
})

test('queryTerms removes stop words and deduplicates', () => {
  assert.deepEqual(queryTerms('what is the auth middleware auth'), ['auth', 'middleware'])
  assert.deepEqual(queryTerms('how do I use the 构建 pipeline'), ['构', '建', '构建', 'pipeline'])
  assert.deepEqual(queryTerms('the and of'), ['the', 'and', 'of'])
})

test('truncateText counts code points', () => {
  assert.equal(truncateText('abcdef', 3), 'abc…')
  assert.equal(truncateText('记忆测试', 2), '记忆…')
  assert.equal(truncateText('abc', 10), 'abc')
})

test('makeSnippet centers on query terms', () => {
  const text = `${'a'.repeat(500)} auth middleware ${'b'.repeat(500)}`
  const snippet = makeSnippet(text, ['auth'], 120)
  assert.ok(snippet.includes('auth'))
  assert.ok(snippet.length <= 124)
})

test('ageDays is non-negative', () => {
  assert.equal(ageDays(Date.now() + 10_000), 0)
  assert.ok(ageDays(Date.now() - 86_400_000) >= 0.99)
})
