/**
 * BM25 search, temporal decay, source weighting, and MMR re-ranking.
 *
 * BM25 ranks candidates, scores are min-max normalized to [0,1], session
 * chunks decay by half-life, and optional MMR removes near-duplicate results.
 *
 * @module dsh-memory/search
 */

import { chunkMarkdown, extractTitle } from './markdown.js'
import { ageDays, makeSnippet, tokenize } from './text.js'

const BM25_K1 = 1.2
const BM25_B = 0.75

/**
 * @typedef {object} SearchDoc
 * @property {string} path Memory-root-relative path.
 * @property {'global'|'workspace'|'session'} source
 * @property {string} content
 * @property {number} mtimeMs
 * @property {string} [title]
 */

/**
 * Build a searchable chunk index over already-read documents.
 *
 * @param {SearchDoc[]} docs
 * @param {{chunkMaxChars:number, chunkOverlapChars:number, searchMaxFiles?:number, searchMaxChunks?:number}} config
 * @returns {{chunks:Array<object>, documentFrequency:Map<string,number>, averageLength:number}}
 */
export function buildSearchIndex(docs, config) {
  const chunks = []
  const documentFrequency = new Map()
  const maxChunks = config.searchMaxChunks ?? 600

  for (const doc of docs) {
    if (chunks.length >= maxChunks) break
    const pieces = chunkMarkdown(doc.content, {
      maxChars: config.chunkMaxChars,
      overlapChars: config.chunkOverlapChars,
    })
    for (const piece of pieces) {
      if (chunks.length >= maxChunks) break
      const tokens = tokenize(piece.text)
      if (tokens.length === 0) continue
      const counts = new Map()
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
      for (const token of counts.keys()) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
      }
      chunks.push({
        path: doc.path,
        source: doc.source,
        mtimeMs: doc.mtimeMs,
        title: doc.title ?? extractTitle(doc.content, doc.path),
        text: piece.text,
        startLine: piece.startLine,
        endLine: piece.endLine,
        tokens,
        counts,
        length: tokens.length,
      })
    }
  }

  let totalLength = 0
  for (const chunk of chunks) totalLength += chunk.length
  return {
    chunks,
    documentFrequency,
    averageLength: chunks.length === 0 ? 0 : totalLength / chunks.length,
  }
}

/**
 * Rank one query against an index.
 *
 * @param {{chunks:Array<object>, documentFrequency:Map<string,number>, averageLength:number}} index
 * @param {string} query
 * @param {string[]} terms
 * @param {{maxResults?:number, minScore?:number, halfLifeDays?:number, sourceWeights?:object, mmrEnabled?:boolean, mmrLambda?:number, now?:number}} options
 * @returns {Array<object>}
 */
export function searchIndex(index, query, terms, options = {}) {
  if (index.chunks.length === 0 || terms.length === 0) return []
  const maxResults = options.maxResults ?? 6
  const minScore = options.minScore ?? 0.7
  const halfLifeDays = options.halfLifeDays ?? 30
  const sourceWeights = options.sourceWeights ?? { global: 1, workspace: 1, session: 1 }
  const mmrEnabled = options.mmrEnabled ?? true
  const mmrLambda = options.mmrLambda ?? 0.7
  const now = options.now ?? Date.now()
  const total = index.chunks.length
  const averageLength = index.averageLength || 1

  const raw = []
  for (const chunk of index.chunks) {
    let score = 0
    for (const term of terms) {
      const frequency = chunk.counts.get(term) ?? 0
      if (frequency === 0) continue
      const df = index.documentFrequency.get(term) ?? 0
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
      const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * chunk.length) / averageLength)
      score += idf * ((frequency * (BM25_K1 + 1)) / denominator)
    }
    if (score > 0) raw.push({ chunk, score })
  }
  if (raw.length === 0) return []

  const maxRaw = raw.reduce((best, item) => Math.max(best, item.score), 0)
  const minRaw = raw.reduce((best, item) => Math.min(best, item.score), Number.POSITIVE_INFINITY)
  const range = maxRaw - minRaw

  const ranked = []
  for (const { chunk, score } of raw) {
    const normalized = range <= Number.EPSILON ? 1 : (score - minRaw) / range
    const decay = decayMultiplier(chunk.source, chunk.mtimeMs, now, halfLifeDays)
    const weight = sourceWeights[chunk.source] ?? 1
    const rawScore = normalized * decay * weight
    const displayScore = Math.min(1, Math.max(0, rawScore))
    if (displayScore < minScore) continue
    ranked.push({
      path: chunk.path,
      source: chunk.source,
      title: chunk.title,
      score: displayScore,
      rawScore,
      snippet: makeSnippet(chunk.text, terms),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      mtimeMs: chunk.mtimeMs,
      ageDays: ageDays(chunk.mtimeMs, now),
      tokens: chunk.tokens,
    })
  }
  if (ranked.length === 0) return []

  ranked.sort((left, right) => right.rawScore - left.rawScore || left.path.localeCompare(right.path))
  let results = ranked
  if (mmrEnabled && ranked.length > 1 && mmrLambda < 1) {
    results = mmrRerank(ranked, mmrLambda)
  }
  return results.slice(0, maxResults)
}

/**
 * Temporal decay: curated global/workspace memory never decays; session memory
 * halves every `halfLifeDays`. A half-life of 0 disables decay.
 */
export function decayMultiplier(source, mtimeMs, now, halfLifeDays) {
  if (source === 'global' || source === 'workspace') return 1
  if (!(halfLifeDays > 0)) return 1
  const age = ageDays(mtimeMs, now)
  return Math.exp(-(Math.LN2 / halfLifeDays) * age)
}

/**
 * Greedy Maximal Marginal Relevance re-ranking.
 *
 * @param {Array<object>} results
 * @param {number} lambda 1 = pure relevance, 0 = maximal diversity.
 * @returns {Array<object>}
 */
export function mmrRerank(results, lambda = 0.7) {
  if (results.length <= 1) return results
  const maxScore = results.reduce((best, item) => Math.max(best, item.rawScore), Number.NEGATIVE_INFINITY)
  const minScore = results.reduce((best, item) => Math.min(best, item.rawScore), Number.POSITIVE_INFINITY)
  const range = Math.max(maxScore - minScore, Number.EPSILON)
  const tokenSets = results.map((item) => new Set(item.tokens ?? tokenize(item.snippet)))
  const remaining = results.map((_, index) => index)
  const selected = []

  while (remaining.length > 0) {
    let bestPosition = 0
    let bestValue = Number.NEGATIVE_INFINITY

    for (let position = 0; position < remaining.length; position += 1) {
      const candidateIndex = remaining[position]
      const relevance = (results[candidateIndex].rawScore - minScore) / range
      let similarity = 0
      for (const selectedIndex of selected) {
        similarity = Math.max(similarity, jaccard(tokenSets[candidateIndex], tokenSets[selectedIndex]))
      }
      const value = lambda * relevance - (1 - lambda) * similarity
      const bestIndex = remaining[bestPosition]
      if (value > bestValue || (value === bestValue && results[candidateIndex].rawScore > results[bestIndex].rawScore)) {
        bestValue = value
        bestPosition = position
      }
    }

    selected.push(remaining.splice(bestPosition, 1)[0])
  }

  return selected.map((index) => results[index])
}

/** Jaccard similarity of two token sets. */
export function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  const union = left.size + right.size - intersection
  return union === 0 ? 0 : intersection / union
}
