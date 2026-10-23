import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkMarkdown, extractDescription, extractTitle, normalizeNote, parseFrontmatter } from '../lib/markdown.js'

test('parseFrontmatter extracts shallow values and body offset', () => {
  const parsed = parseFrontmatter('---\ntitle: "Hello"\ncreated: "2026"\n---\n\n## Body\n')
  assert.equal(parsed.data.title, 'Hello')
  assert.equal(parsed.bodyStartLine, 4)
  assert.ok(parsed.body.includes('## Body'))
})

test('extractTitle prefers frontmatter, then headings', () => {
  assert.equal(extractTitle('---\ntitle: "Front"\n---\n# Heading\n'), 'Front')
  assert.equal(extractTitle('# Heading\n\ntext'), 'Heading')
  assert.equal(extractTitle('plain first line\nmore'), 'plain first line')
})

test('extractDescription uses the first paragraph after the title', () => {
  assert.equal(extractDescription('# Auth\n\nJWT middleware lives in src/auth.ts.\n\nMore.'), 'JWT middleware lives in src/auth.ts.')
})

test('normalizeNote always produces a heading', () => {
  assert.equal(normalizeNote('single line'), '## single line')
  assert.equal(normalizeNote('short\nbody'), '## short\n\nbody')
  assert.ok(normalizeNote('x'.repeat(100) + '\nbody').startsWith('## Note'))
  assert.equal(normalizeNote('## already'), '## already')
})

test('chunkMarkdown respects sections and reports inclusive line ranges', () => {
  const content = ['# Title', '', 'Intro.', '', '## One', '', 'alpha beta', '', '## Two', '', 'gamma delta'].join('\n')
  const chunks = chunkMarkdown(content, { maxChars: 40, overlapChars: 0 })
  assert.ok(chunks.length >= 2)
  assert.equal(chunks[0].startLine, 1)
  assert.ok(chunks.some((chunk) => chunk.text.includes('alpha beta')))
  assert.ok(chunks.some((chunk) => chunk.text.includes('gamma delta')))
  for (const chunk of chunks) assert.ok(chunk.endLine >= chunk.startLine)
})

test('chunkMarkdown splits oversized sections and adds overlap', () => {
  const content = ['## Big', '', ...Array.from({ length: 80 }, (_, index) => `paragraph ${index} ${'x'.repeat(40)}`)].join('\n\n')
  const chunks = chunkMarkdown(content, { maxChars: 300, overlapChars: 60 })
  assert.ok(chunks.length > 2)
  for (const chunk of chunks) assert.ok(chunk.text.length > 0)
})

test('chunkMarkdown handles frontmatter line offsets', () => {
  const content = ['---', 'title: "T"', '---', '', '## H', '', 'body'].join('\n')
  const chunks = chunkMarkdown(content, { maxChars: 1600, overlapChars: 0 })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].startLine, 1)
})
