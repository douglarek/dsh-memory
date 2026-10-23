/**
 * Markdown parsing and chunking for memory notes.
 *
 * Chunks respect ATX headings and paragraph boundaries, carry inclusive line
 * ranges, and prefix continuation chunks with a bounded overlap so embeddings
 * or keyword windows are not cut exactly at a boundary.
 *
 * @module dsh-memory/markdown
 */

import { collapseWhitespace, firstLine, truncateText } from './text.js'

/**
 * Parse a leading simple YAML frontmatter block.
 *
 * Only shallow `key: value` pairs are supported; values may be JSON-quoted.
 *
 * @param {string} content
 * @returns {{data:Record<string,string>, body:string, bodyStartLine:number, hasFrontmatter:boolean}}
 */
export function parseFrontmatter(content) {
  const value = String(content ?? '')
  const lines = value.split(/\r?\n/)
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { data: {}, body: value, bodyStartLine: 0, hasFrontmatter: false }
  }
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end < 0) return { data: {}, body: value, bodyStartLine: 0, hasFrontmatter: false }

  const data = {}
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!match) continue
    let raw = match[2].trim()
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        raw = JSON.parse(raw)
      } catch {
        // keep the raw value when it is not valid JSON
      }
    } else if (raw.startsWith("'") && raw.endsWith("'")) {
      raw = raw.slice(1, -1)
    }
    data[match[1]] = raw
  }

  return {
    data,
    body: lines.slice(end + 1).join('\n'),
    bodyStartLine: end + 1,
    hasFrontmatter: true,
  }
}

/**
 * Extract a display title: frontmatter `title`, then the first heading, then
 * the first non-empty line.
 */
export function extractTitle(content, fallback = '') {
  const parsed = parseFrontmatter(content)
  if (typeof parsed.data.title === 'string' && parsed.data.title.trim().length > 0) {
    return collapseWhitespace(parsed.data.title)
  }
  for (const line of parsed.body.split(/\r?\n/)) {
    const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
    if (match) return collapseWhitespace(match[1])
  }
  return truncateText(firstLine(parsed.body), 120) || fallback
}

/**
 * Extract a short description: the first paragraph after the title that is not
 * a heading, comment, or list marker.
 */
export function extractDescription(content, maxChars = 200) {
  const parsed = parseFrontmatter(content)
  const lines = parsed.body.split(/\r?\n/)
  let seenHeading = false
  const paragraphs = []
  let current = []

  const flush = () => {
    if (current.length === 0) return
    const text = collapseWhitespace(current.join(' '))
    current = []
    if (text.length > 0) paragraphs.push(text)
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      flush()
      continue
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      flush()
      seenHeading = true
      continue
    }
    if (!seenHeading) continue
    if (trimmed.startsWith('<!--') || trimmed.startsWith('-->')) continue
    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      const bullet = trimmed
        .replace(/^([-*+]|\d+\.)\s+/, '')
        .replace(/^\*\*\d{4}-\d{2}-\d{2}\*\*:\s*/, '')
      if (bullet.length > 0) current.push(bullet)
      continue
    }
    current.push(trimmed)
  }
  flush()

  const first = paragraphs.find((paragraph) => paragraph.length > 0) ?? ''
  return truncateText(first, maxChars)
}

/**
 * Normalize free-form remember text into a Markdown note with a heading, so
 * the chunker always has structure to work with.
 */
export function normalizeNote(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return ''
  if (text.startsWith('#')) return text
  const newline = text.indexOf('\n')
  if (newline < 0) return `## ${text}`
  const head = text.slice(0, newline).trim()
  const rest = text.slice(newline).trim()
  if (head.length <= 80) return `## ${head}\n\n${rest}`
  return `## Note\n\n${text}`
}

/**
 * Split Markdown into search chunks.
 *
 * @param {string} content
 * @param {{maxChars?: number, overlapChars?: number}} [options]
 * @returns {Array<{text:string,startLine:number,endLine:number}>} inclusive 1-based line ranges.
 */
export function chunkMarkdown(content, options = {}) {
  const maxChars = options.maxChars ?? 1600
  const overlapChars = options.overlapChars ?? 320
  const value = String(content ?? '')
  if (value.trim().length === 0) return []

  const parsed = parseFrontmatter(value)
  const allLines = value.split(/\r?\n/)
  const bodyStart = parsed.hasFrontmatter ? parsed.bodyStartLine : 0
  const bodyLines = allLines.slice(bodyStart)
  if (bodyLines.join('\n').length <= maxChars) {
    return [{ text: value.trim(), startLine: 1, endLine: allLines.length }]
  }

  const blocks = splitBlocks(bodyLines)
  const chunks = []
  let current = null

  for (const block of blocks) {
    const blockText = block.lines.join('\n').trim()
    if (blockText.length === 0) continue

    if (blockText.length > maxChars) {
      if (current !== null) {
        chunks.push(current)
        current = null
      }
      for (const part of splitLongBlock(block, maxChars, bodyStart)) chunks.push(part)
      continue
    }

    if (current !== null && current.text.length + 2 + blockText.length > maxChars) {
      chunks.push(current)
      current = null
    }

    if (current === null) {
      current = {
        text: blockText,
        startLine: block.start + bodyStart + 1,
        endLine: block.end + bodyStart + 1,
      }
    } else {
      current.text += `\n\n${blockText}`
      current.endLine = block.end + bodyStart + 1
    }
  }
  if (current !== null) chunks.push(current)

  if (overlapChars > 0 && chunks.length > 1) {
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = Array.from(chunks[index - 1].text)
      if (previous.length === 0) continue
      const overlap = previous.slice(-overlapChars).join('').trim()
      if (overlap.length > 0) chunks[index] = { ...chunks[index], text: `${overlap}\n\n${chunks[index].text}` }
    }
  }

  return chunks
}

function splitBlocks(lines) {
  const blocks = []
  let current = []
  let currentStart = 0

  const flush = () => {
    while (current.length > 0 && current[current.length - 1].trim() === '') current.pop()
    if (current.length > 0) {
      blocks.push({ lines: current, start: currentStart, end: currentStart + current.length - 1 })
    }
    current = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const isHeading = /^\s{0,3}#{1,6}\s+/.test(line) && line.trim().length > 0
    if (isHeading && current.some((entry) => entry.trim().length > 0)) {
      flush()
      currentStart = index
    }
    if (line.trim() === '' && current.length > 0) {
      current.push(line)
      flush()
      currentStart = index + 1
      continue
    }
    if (current.length === 0) currentStart = index
    current.push(line)
  }
  flush()
  return blocks
}

function splitLongBlock(block, maxChars, bodyStart) {
  const chunks = []
  let currentLines = []
  let currentStart = block.start
  let currentLength = 0

  const flush = (endLine) => {
    if (currentLines.length === 0) return
    chunks.push({
      text: currentLines.join('\n').trim(),
      startLine: currentStart + bodyStart + 1,
      endLine: endLine + bodyStart + 1,
    })
    currentLines = []
    currentLength = 0
  }

  for (let offset = 0; offset < block.lines.length; offset += 1) {
    const line = block.lines[offset]
    const lineLength = line.length + 1
    if (currentLines.length > 0 && currentLength + lineLength > maxChars) {
      flush(currentStart + currentLines.length - 1)
      currentStart = block.start + offset
    }
    if (lineLength > maxChars) {
      // A single very long line: split it into bounded character windows.
      const chars = Array.from(line)
      for (let index = 0; index < chars.length; index += maxChars) {
        const text = chars.slice(index, index + maxChars).join('')
        chunks.push({
          text,
          startLine: block.start + offset + bodyStart + 1,
          endLine: block.start + offset + bodyStart + 1,
        })
      }
      currentStart = block.start + offset + 1
      continue
    }
    currentLines.push(line)
    currentLength += lineLength
  }
  flush(currentStart + currentLines.length - 1)
  return chunks
}

