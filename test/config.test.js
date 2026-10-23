import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'

test('resolveConfig applies defaults and resolves memoryDir', () => {
  const config = resolveConfig({}, { env: { DSH_HOME: '/tmp/dsh-home' } })
  assert.equal(config.enabled, DEFAULT_CONFIG.enabled)
  assert.equal(config.memoryDir, '/tmp/dsh-home/memory')
  assert.equal(config.memoryRootDisplay, '$DSH_HOME/memory')
  assert.equal(config.searchMaxResults, 6)
  assert.equal(config.searchMinScore, 0.7)
  assert.equal(config.captureEnabled, true)
})

test('resolveConfig honors explicit options', () => {
  const config = resolveConfig({
    enabled: false,
    memoryDir: '/tmp/my-memory',
    searchMaxResults: 12,
    searchSourceWeights: { session: 0.5 },
    injectMaxBytes: 2048,
  })
  assert.equal(config.enabled, false)
  assert.equal(config.memoryDir, '/tmp/my-memory')
  assert.equal(config.searchMaxResults, 12)
  assert.equal(config.searchSourceWeights.session, 0.5)
  assert.equal(config.searchSourceWeights.global, 1)
  assert.equal(config.injectMaxBytes, 2048)
})

test('resolveConfig reports unknown options without throwing', () => {
  const config = resolveConfig({ unknownOption: true })
  assert.equal(config.warnings.length, 1)
  assert.match(config.warnings[0], /unknownOption/)
})

test('resolveConfig rejects invalid values', () => {
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => resolveConfig({ searchMaxResults: 0 }), /between 1 and 50/)
  assert.throws(() => resolveConfig({ searchMmrLambda: 2 }), /between 0 and 1/)
  assert.throws(() => resolveConfig({ chunkMaxChars: 300, chunkOverlapChars: 200 }), /must not exceed half/)
  assert.throws(() => resolveConfig({ searchSourceWeights: { bogus: 1 } }), /unknown source/)
})
