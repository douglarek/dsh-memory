/**
 * Text utilities: slugs, truncation, timestamps, tokenization, and snippets.
 *
 * The tokenizer keeps Latin/digit runs as words and indexes CJK runs as both
 * unigrams and bigrams, so Chinese notes are searchable without a word
 * segmenter.
 *
 * @module dsh-memory/text
 */

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u

/** Articles, pronouns, and filler removed from queries (Grok's stop-word set). */
export const STOP_WORDS = new Set([
  // Articles & determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  // Pronouns
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'him', 'her', 'its',
  'them', 'us',
  // Common verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'can', 'may', 'might',
  // Prepositions
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'about', 'into', 'through', 'during',
  'before', 'after', 'above', 'below',
  // Conjunctions
  'and', 'or', 'but', 'if', 'then', 'because', 'as', 'while', 'when', 'where', 'what', 'which',
  'who', 'how', 'why',
  // Vague references
  'thing', 'things', 'stuff', 'something', 'anything', 'everything', 'one', 'some', 'any', 'all',
  'each', 'every', 'both', 'few', 'more',
  // Time references
  'yesterday', 'today', 'tomorrow', 'earlier', 'later', 'recently', 'now', 'just', 'already',
  'still', 'yet',
  // Request words
  'please', 'help', 'find', 'show', 'get', 'tell', 'give', 'make',
  // Common filler
  'not', 'no', 'yes', 'also', 'too', 'very', 'really', 'actually', 'maybe', 'perhaps', 'like',
  'want', 'need', 'use', 'using', 'used', 'was', 'were', 'been',
  // Chinese function words
  '的', '了', '是', '在', '和', '我', '你', '他', '她', '它', '们', '这', '那', '有', '与', '及',
  '或', '但', '而', '也', '就', '都', '还', '又', '很', '更', '最', '一', '个', '些', '什么',
  '怎么', '如何', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '请', '帮', '想', '要', '能', '可以',
  '已经', '正在', '之前', '之后', '现在', '今天', '昨天', '明天',
])

/**
 * Tokenize text for indexing and search.
 *
 * @param {string} text
 * @returns {string[]} lowercase word tokens in document order.
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const chars = Array.from(text.normalize('NFKC').toLowerCase())
  const tokens = []
  let index = 0

  while (index < chars.length) {
    const char = chars[index]

    if (CJK_RE.test(char)) {
      const run = []
      while (index < chars.length && CJK_RE.test(chars[index])) {
        run.push(chars[index])
        index += 1
      }
      for (const value of run) tokens.push(value)
      for (let i = 0; i + 1 < run.length; i += 1) tokens.push(run[i] + run[i + 1])
      continue
    }

    if (WORD_CHAR_RE.test(char)) {
      let word = ''
      while (index < chars.length && !CJK_RE.test(chars[index]) && WORD_CHAR_RE.test(chars[index])) {
        word += chars[index]
        index += 1
      }
      tokens.push(word)
      continue
    }

    index += 1
  }

  return tokens
}

/**
 * Deduplicate query tokens and remove stop words. When a query consists only
 * of stop words, the original tokens are returned so search still has input.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function queryTerms(query) {
  const tokens = tokenize(query)
  const unique = []
  const seen = new Set()
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    unique.push(token)
  }
  const meaningful = unique.filter((token) => !STOP_WORDS.has(token))
  return meaningful.length > 0 ? meaningful : unique
}

/** Number of distinct query terms present in a token list. */
export function countMatchingTerms(tokens, terms) {
  if (terms.length === 0) return 0
  const present = new Set(tokens)
  let count = 0
  for (const term of terms) if (present.has(term)) count += 1
  return count
}

/** True when the string contains at least one CJK character. */
export function hasCjk(text) {
  return typeof text === 'string' && CJK_RE.test(text)
}

/** Collapse all whitespace runs into single spaces. */
export function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** Return the first non-empty line, trimmed and stripped of heading markers. */
export function firstLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const value = line.replace(/^\s*#{1,6}\s+/, '').trim()
    if (value.length > 0 && !value.startsWith('<!--')) return value
  }
  return ''
}

/** Truncate by Unicode code points, appending `…` when shortened. */
export function truncateText(text, maxChars, suffix = '…') {
  const value = String(text ?? '')
  const chars = Array.from(value)
  if (chars.length <= maxChars) return value
  return chars.slice(0, Math.max(0, maxChars)).join('') + suffix
}

/** Truncate to a UTF-8 byte budget without splitting a code point. */
export function truncateUtf8(text, maxBytes, suffix = '') {
  const value = String(text ?? '')
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let bytes = 0
  let result = ''
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))) break
    result += char
    bytes += size
  }
  return result + suffix
}

/** Escape a closing frame tag so note content cannot close a plugin-owned frame. */
export function escapeClosingTag(text, tag) {
  return String(text ?? '').split(`</${tag}>`).join(`<\\/${tag}>`)
}

/** Deep-freeze a plain JSON value in place. */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** Current time as an ISO string. */
export function isoNow(date = new Date()) {
  return date.toISOString()
}

/** UTC date stamp used in file names. */
export function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

/** Age in whole days between a timestamp and now. */
export function ageDays(timestamp, now = Date.now()) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 0
  return Math.max(0, (now - timestamp) / 86_400_000)
}

/**
 * Build a bounded snippet centered on the densest cluster of query terms.
 *
 * @param {string} text
 * @param {string[]} terms
 * @param {number} [maxChars]
 * @returns {string}
 */
export function makeSnippet(text, terms, maxChars = 600) {
  const value = String(text ?? '').trim()
  if (value.length <= maxChars) return value
  const lowered = value.toLowerCase()
  let bestStart = 0
  let bestScore = -1

  for (const term of terms) {
    let from = 0
    while (from < lowered.length) {
      const at = lowered.indexOf(term, from)
      if (at < 0) break
      const start = Math.max(0, at - Math.floor(maxChars / 3))
      const window = lowered.slice(start, start + maxChars)
      let score = 0
      for (const candidate of terms) if (window.includes(candidate)) score += 1
      if (score > bestScore) {
        bestScore = score
        bestStart = start
      }
      from = at + Math.max(1, term.length)
      if (bestScore >= terms.length) break
    }
    if (bestScore >= terms.length) break
  }

  let snippet = safeSlice(value, bestStart, bestStart + maxChars).trim()
  if (bestStart > 0) snippet = `…${snippet}`
  if (bestStart + maxChars < value.length) snippet = `${snippet}…`
  return snippet
}

function safeSlice(value, start, end) {
  let from = start
  let to = end
  if (from > 0 && isLowSurrogate(value.charCodeAt(from))) from -= 1
  if (to < value.length && isLowSurrogate(value.charCodeAt(to))) to += 1
  return value.slice(from, to)
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Render a relative or absolute memory path for display. */
export function displayPath(path) {
  return String(path ?? '').split('\\').join('/')
}
