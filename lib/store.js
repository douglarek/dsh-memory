/**
 * Scoped Markdown storage for dsh-memory.
 *
 * Layout under the memory root:
 *
 * ```text
 * <root>/
 *   global/
 *     MEMORY.md                  generated index
 *     topics/<topic>.md          curated notes
 *     observations/_inbox/*.md   new observations
 *   workspaces/<slug>-<hash8>/
 *     MEMORY.md
 *     topics/
 *     observations/_inbox/
 *     sessions/YYYY-MM-DD-<slug>-<sid8>.md
 *     .scope.json
 * ```
 *
 * `MEMORY.md` is always generated. Topics and observations are the source of
 * truth; session logs are append-only transcripts used for recall.
 *
 * @module dsh-memory/store
 */

import { basename, join, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'
import {
  ensureDir,
  listFilesRecursive,
  pathExists,
  readTextBounded,
  removePath,
  statSafe,
  writeFileAtomic,
  writeJsonAtomic,
} from './fsutil.js'
import { extractDescription, extractTitle, normalizeNote, parseFrontmatter } from './markdown.js'
import { buildSearchIndex, searchIndex } from './search.js'
import {
  dateStamp,
  escapeClosingTag,
  firstLine,
  isoNow,
  queryTerms,
  truncateText,
  truncateUtf8,
} from './text.js'
import { expandHome, isWithin, slugify, toMemoryPath } from './paths.js'

const SESSION_DIR = 'sessions'
const TOPIC_DIR = 'topics'
const OBSERVATION_DIR = join('observations', '_inbox')
const INDEX_FILE = 'MEMORY.md'
const SCOPE_FILE = '.scope.json'
const VALID_SCOPES = new Set(['global', 'workspace'])
const VALID_KINDS = new Set(['index', 'topic', 'observation', 'session'])

/**
 * @typedef {object} MemoryWorkspace
 * @property {string} key
 * @property {string} root
 * @property {string} projectRoot
 * @property {string} identity
 * @property {string} dirName
 * @property {boolean} ephemeral
 */

export class MemoryStore {
  /**
   * @param {object} options
   * @param {string} options.root Absolute memory root.
   * @param {MemoryWorkspace|null} [options.workspace]
   * @param {import('./config.js').MemoryConfig} options.config
   * @param {{info?:Function,warn?:Function,debug?:Function}} [options.logger]
   */
  constructor(options) {
    this.root = resolve(options.root)
    this.workspace = options.workspace ?? null
    this.config = options.config
    this.logger = options.logger ?? {}
    /** @type {Map<string,{mtimeMs:number,size:number,content:string,title:string}>} */
    this.documentCache = new Map()
    this.searchCache = null
  }

  /** The display prefix for one scope, relative to the memory root. */
  scopePrefix(scope) {
    if (scope === 'global') return 'global'
    if (scope === 'workspace') {
      if (this.workspace === null) throw new Error('dsh-memory: this session has no workspace scope')
      return `workspaces/${this.workspace.dirName}`
    }
    throw new Error(`dsh-memory: unknown memory scope "${scope}"`)
  }

  /** Absolute directory for one scope. */
  scopeDir(scope) {
    return resolve(this.root, this.scopePrefix(scope))
  }

  /** Whether a scope is configured and available in this session. */
  scopeAvailable(scope) {
    if (scope === 'global') return this.config.scopeGlobal
    if (scope === 'workspace') return this.config.scopeWorkspace && this.workspace !== null && !this.workspace.ephemeral
    return false
  }

  /** Enabled scopes, broad to specific. */
  enabledScopes() {
    const scopes = []
    if (this.scopeAvailable('global')) scopes.push('global')
    if (this.scopeAvailable('workspace')) scopes.push('workspace')
    return scopes
  }

  /** Ensure a scope's directory skeleton and generated index exist. */
  async ensureScope(scope) {
    if (!VALID_SCOPES.has(scope)) throw new Error(`dsh-memory: unknown memory scope "${scope}"`)
    if (!this.scopeAvailable(scope)) throw new Error(`dsh-memory: the ${scope} scope is disabled for this session`)
    const dir = this.scopeDir(scope)
    await ensureDir(join(dir, TOPIC_DIR))
    await ensureDir(join(dir, OBSERVATION_DIR))
    await ensureDir(join(dir, SESSION_DIR))
    const scopeFile = join(dir, SCOPE_FILE)
    if (!(await pathExists(scopeFile))) {
      const record = {
        version: 1,
        scope,
        createdAt: isoNow(),
        ...(scope === 'workspace'
          ? {
              dirName: this.workspace.dirName,
              root: this.workspace.root,
              projectRoot: this.workspace.projectRoot,
              identity: this.workspace.identity,
            }
          : {}),
      }
      await writeJsonAtomic(scopeFile, record)
    }
    if (!(await pathExists(join(dir, INDEX_FILE)))) await this.regenerateIndex(scope)
  }

  /**
   * List memory files.
   *
   * @param {{scopes?:'all'|'global'|'workspace', kinds?:'all'|string|string[], maxFiles?:number, includeIndex?:boolean, readTitle?:boolean}} [options]
   */
  async listFiles(options = {}) {
    const scopes = this.selectScopes(options.scopes ?? 'all')
    const kinds = normalizeKinds(options.kinds ?? 'all', options.includeIndex ?? true)
    const maxFiles = options.maxFiles ?? this.config.searchMaxFiles
    const files = []

    for (const scope of scopes) {
      const prefix = this.scopePrefix(scope)
      const dir = this.scopeDir(scope)
      if (!(await pathExists(dir))) continue

      if (kinds.has('index')) {
        const index = join(dir, INDEX_FILE)
        const info = await statSafe(index)
        if (info?.isFile()) {
          files.push(await this.fileInfo(scope, prefix, INDEX_FILE, index, info, options.readTitle))
        }
      }
      if (kinds.has('topic')) {
        for (const entry of await listFilesRecursive(join(dir, TOPIC_DIR), {
          maxFiles,
          extensions: ['.md'],
        })) {
          const rel = relative(dir, entry.path).split(sep).join('/')
          files.push(await this.fileInfo(scope, prefix, rel, entry.path, entry, options.readTitle))
          if (files.length >= maxFiles) break
        }
      }
      if (kinds.has('observation')) {
        for (const entry of await listFilesRecursive(join(dir, OBSERVATION_DIR), {
          maxFiles,
          extensions: ['.md'],
        })) {
          const rel = relative(dir, entry.path).split(sep).join('/')
          files.push(await this.fileInfo(scope, prefix, rel, entry.path, entry, options.readTitle))
          if (files.length >= maxFiles) break
        }
      }
      if (kinds.has('session') && scope === 'workspace') {
        for (const entry of await listFilesRecursive(join(dir, SESSION_DIR), {
          maxFiles,
          extensions: ['.md'],
        })) {
          const rel = relative(dir, entry.path).split(sep).join('/')
          files.push(await this.fileInfo(scope, prefix, rel, entry.path, entry, options.readTitle))
          if (files.length >= maxFiles) break
        }
      }
      if (files.length >= maxFiles) break
    }

    files.sort(compareFiles)
    return files.slice(0, maxFiles)
  }

  async fileInfo(scope, prefix, within, absolute, info, readTitle = false) {
    const result = {
      path: `${prefix}/${within}`,
      absolutePath: absolute,
      scope,
      kind: kindOf(within),
      size: info.size ?? 0,
      mtimeMs: info.mtimeMs ?? 0,
      title: '',
    }
    if (readTitle) {
      const doc = await this.readDocument(absolute)
      result.title = doc?.title ?? ''
    }
    return result
  }

  /** Read one document through the mtime/size cache. */
  async readDocument(absolutePath) {
    const info = await statSafe(absolutePath)
    if (info === null || !info.isFile()) return null
    const cached = this.documentCache.get(absolutePath)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached
    const read = await readTextBounded(absolutePath, Math.max(this.config.searchMaxFileBytes, 512 * 1024))
    if (read === null) return null
    const doc = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      content: read.content,
      title: extractTitle(read.content, basename(absolutePath)),
    }
    this.documentCache.set(absolutePath, doc)
    if (this.documentCache.size > 5000) {
      const first = this.documentCache.keys().next().value
      if (first !== undefined) this.documentCache.delete(first)
    }
    return doc
  }

  /**
   * Resolve a user/model supplied path inside the memory root.
   *
   * Accepts root-relative paths, absolute paths under the root, `~` paths, and
   * `workspace/...` / `global/...` aliases.
   */
  async resolveMemoryPath(input) {
    const raw = expandHome(String(input ?? '').trim())
    if (raw.length === 0) throw new Error('dsh-memory: a memory path is required')
    if (raw.includes('\0')) throw new Error('dsh-memory: memory path contains a NUL byte')

    const aliases = buildAliases(raw, this.workspace?.dirName)
    const candidates = []
    for (const candidate of aliases) {
      if (isAbsolutePath(candidate)) candidates.push(resolve(candidate))
      else {
        candidates.push(resolve(this.root, candidate))
        if (this.workspace !== null && !candidate.startsWith('workspaces/') && !candidate.startsWith('global/')) {
          candidates.push(resolve(this.root, 'workspaces', this.workspace.dirName, candidate))
        }
        if (!candidate.startsWith('global/') && !candidate.startsWith('workspaces/')) {
          candidates.push(resolve(this.root, 'global', candidate))
        }
      }
    }

    const canonicalRoot = await canonicalRootOf(this.root)
    let fallback = null
    for (const candidate of candidates) {
      if (!isWithin(this.root, candidate)) continue
      const info = await statSafe(candidate)
      if (info !== null) {
        const canonicalCandidate = await canonicalPath(candidate)
        if (!isWithin(canonicalRoot, canonicalCandidate)) {
          throw new Error('dsh-memory: memory path resolves outside the memory root')
        }
        const relPath = toMemoryPath(this.root, candidate)
        const classification = this.classify(relPath)
        return {
          absolutePath: candidate,
          relPath,
          scope: classification.scope,
          kind: classification.kind,
          isDirectory: info.isDirectory(),
          size: info.size,
        }
      }
      if (fallback === null) fallback = candidate
    }

    throw new Error(
      `dsh-memory: memory file not found: ${raw}${fallback ? ` (tried ${toMemoryPath(this.root, fallback)})` : ''}`,
    )
  }

  /** Classify a memory-root-relative path. */
  classify(relPath) {
    const parts = relPath.split('/')
    if (parts[0] === 'global') {
      const within = parts.slice(1).join('/')
      return { scope: 'global', kind: kindOf(within), within }
    }
    if (parts[0] === 'workspaces' && parts.length >= 3) {
      const within = parts.slice(2).join('/')
      return { scope: 'workspace', kind: kindOf(within), within, workspaceDir: parts[1] }
    }
    return { scope: 'other', kind: 'unknown', within: relPath }
  }

  /**
   * Read a memory file, optionally limited to a line range.
   *
   * @param {{path:string, from?:number, lines?:number}} request
   */
  async read(request) {
    const resolved = await this.resolveMemoryPath(request.path)
    if (resolved.isDirectory) throw new Error(`dsh-memory: ${resolved.relPath} is a directory, not a memory file`)
    if (!/\.md$/i.test(resolved.absolutePath)) {
      throw new Error('dsh-memory: memory_get can only read Markdown (.md) memory files')
    }
    const read = await readTextBounded(resolved.absolutePath, 512 * 1024)
    if (read === null) throw new Error(`dsh-memory: could not read ${resolved.relPath}`)

    const allLines = read.content.split(/\r?\n/)
    const totalLines = allLines.length
    let from = Number.isInteger(request.from) ? request.from : 1
    if (from <= 0) from = 1
    const maxLines = Number.isInteger(request.lines) ? Math.min(Math.max(request.lines, 1), 2000) : 2000
    const startIndex = Math.min(from - 1, Math.max(0, totalLines - 1))
    const selected = allLines.slice(startIndex, startIndex + maxLines)
    const numbered = selected
      .map((line, index) => `${startIndex + index + 1}→${line}`)
      .join('\n')
    const endLine = startIndex + selected.length

    return {
      path: resolved.relPath,
      content: numbered.length > 0 ? numbered : '(empty file)',
      total_lines: totalLines,
      start_line: startIndex + 1,
      end_line: endLine,
      truncated: read.truncated || endLine < totalLines,
    }
  }

  /**
   * Save a durable note.
   *
   * A topic writes into `topics/<topic>.md` under a Notes section; a note
   * without a topic becomes a standalone observation file.
   *
   * @param {{text:string, scope?:'global'|'workspace', topic?:string}} request
   */
  async remember(request) {
    const scope = request.scope ?? 'workspace'
    if (!VALID_SCOPES.has(scope)) throw new Error(`dsh-memory: unknown memory scope "${scope}"`)
    if (!this.scopeAvailable(scope)) {
      throw new Error(`dsh-memory: the ${scope} scope is not available in this session`)
    }
    const text = String(request.text ?? '').trim()
    if (text.length === 0) throw new Error('dsh-memory: memory_remember requires non-empty text')
    if (text.includes('\0')) throw new Error('dsh-memory: memory text contains a NUL byte')
    if (text.length > 8000) throw new Error('dsh-memory: memory text exceeds the 8000-character limit')
    await this.ensureScope(scope)

    const topic = typeof request.topic === 'string' ? request.topic.trim() : ''
    if (topic.length > 0) {
      return this.rememberInTopic(scope, topic, text)
    }
    return this.rememberObservation(scope, text)
  }

  async rememberInTopic(scope, topic, text) {
    const topicTitle = truncateText(topic, 120)
    const topicSlug = slugify(topic, 48) || 'topic'
    const relPath = `${this.scopePrefix(scope)}/${TOPIC_DIR}/${topicSlug}.md`
    const absolutePath = resolve(this.root, ...relPath.split('/'))
    const info = await statSafe(absolutePath)
    const existing = info === null ? '' : (await readTextBounded(absolutePath, 2 * 1024 * 1024))?.content ?? ''

    const date = dateStamp()
    const bullets = text
      .split(/\r?\n/)
      .map((line, index) => (index === 0 ? `- **${date}**: ${line.trim()}` : `  ${line.trim()}`))
      .join('\n')
    const marker = `- **${date}**: ${firstLine(text)}`
    if (existing.includes(marker)) {
      return { path: relPath, scope, topic: topicTitle, created: false }
    }

    let content
    if (existing.trim().length === 0) {
      content = `# ${topicTitle}\n\n## Notes\n\n${bullets}\n`
    } else if (/^##\s+Notes\s*$/m.test(existing)) {
      content = `${existing.replace(/\s*$/, '')}\n\n${bullets}\n`
    } else {
      content = `${existing.replace(/\s*$/, '')}\n\n## Notes\n\n${bullets}\n`
    }

    await writeFileAtomic(absolutePath, content)
    await this.regenerateIndex(scope)
    return { path: relPath, scope, topic: topicTitle, created: true }
  }

  async rememberObservation(scope, text) {
    const stamp = Date.now()
    const slug = slugify(firstLine(text), 48) || 'note'
    const unique = Math.random().toString(36).slice(2, 6)
    const relPath = `${this.scopePrefix(scope)}/${OBSERVATION_DIR.split(sep).join('/')}/${stamp}-${unique}-${slug}.md`
    const absolutePath = resolve(this.root, ...relPath.split('/'))
    const frontmatter = [
      '---',
      'type: "observation"',
      `scope: "${scope}"`,
      `created: "${isoNow()}"`,
      '---',
      '',
    ].join('\n')
    await writeFileAtomic(absolutePath, `${frontmatter}${normalizeNote(text)}\n`)
    await this.regenerateIndex(scope)
    return { path: relPath, scope, topic: null, created: true }
  }

  /**
   * Best-effort removal. A path removes exactly that file; a query removes
   * matching topic/observation blocks. Session logs are never removed by a
   * query, only by an explicit path.
   *
   * @param {{path?:string, query?:string, scope?:'all'|'global'|'workspace'}} request
   */
  async forget(request) {
    if (typeof request.path === 'string' && request.path.trim().length > 0) {
      const resolved = await this.resolveMemoryPath(request.path)
      if (resolved.kind === 'index') {
        await this.regenerateIndex(resolved.scope)
        return { removed: [], regenerated: [resolved.relPath], count: 0 }
      }
      if (resolved.kind === 'unknown') throw new Error(`dsh-memory: refusing to delete ${resolved.relPath}`)
      await removePath(resolved.absolutePath)
      if (resolved.scope === 'global' || resolved.scope === 'workspace') {
        await this.regenerateIndex(resolved.scope).catch(() => {})
      }
      return { removed: [{ path: resolved.relPath, detail: 'deleted' }], regenerated: [], count: 1 }
    }

    const query = String(request.query ?? '').trim()
    if (query.length === 0) throw new Error('dsh-memory: memory_forget requires a path or a query')
    const terms = queryTerms(query)
    if (terms.length === 0) throw new Error('dsh-memory: forget query has no searchable terms')
    const scope = request.scope ?? 'all'
    const search = await this.search({
      query,
      scope,
      source: 'all',
      maxResults: 50,
      minScore: 0,
      includeIndex: true,
    })
    const touchedScopes = new Set()
    const removed = []
    const seen = new Set()

    for (const result of search.results) {
      if (result.source === 'session') continue
      const resolved = await this.resolveMemoryPath(result.path)
      if (resolved.kind !== 'topic' && resolved.kind !== 'observation') continue
      if (seen.has(resolved.relPath)) continue
      seen.add(resolved.relPath)
      const doc = await this.readDocument(resolved.absolutePath)
      if (doc === null) continue
      const filtered = removeMatchingLines(doc.content, terms)
      if (filtered.removed === 0) continue
      if (filtered.content.trim().length === 0 || !hasSubstantiveContent(filtered.content)) {
        await removePath(resolved.absolutePath)
        removed.push({ path: resolved.relPath, detail: `deleted after removing ${filtered.removed} block(s)` })
      } else {
        await writeFileAtomic(resolved.absolutePath, `${filtered.content.replace(/\s*$/, '')}\n`)
        removed.push({ path: resolved.relPath, detail: `removed ${filtered.removed} block(s)` })
      }
      if (resolved.scope === 'global' || resolved.scope === 'workspace') touchedScopes.add(resolved.scope)
    }

    for (const scopeName of touchedScopes) await this.regenerateIndex(scopeName).catch(() => {})
    return { removed, regenerated: [], count: removed.length }
  }

  /**
   * Search memory.
   *
   * @param {{query:string, scope?:'all'|'global'|'workspace', source?:'all'|'global'|'workspace'|'session', maxResults?:number, minScore?:number, includeIndex?:boolean}} request
   */
  async search(request) {
    const query = String(request.query ?? '').trim()
    if (query.length === 0) throw new Error('dsh-memory: memory_search requires a non-empty query')
    const terms = queryTerms(query)
    if (terms.length === 0) return { query, terms, results: [], total: 0 }

    const scope = request.scope ?? 'all'
    const source = request.source ?? 'all'
    const maxResults = clampInteger(request.maxResults ?? this.config.searchMaxResults, 1, 50, this.config.searchMaxResults)
    const minScore = clampNumber(request.minScore ?? this.config.searchMinScore, 0, 1, this.config.searchMinScore)
    const includeIndex = request.includeIndex ?? this.config.searchIncludeIndex

    let scopes
    let kinds
    if (source === 'session') {
      scopes = scope === 'global' ? [] : this.selectScopes('workspace')
      kinds = ['session']
    } else if (source === 'global') {
      scopes = scope === 'workspace' ? [] : this.selectScopes('global')
      kinds = ['topic', 'observation'].concat(includeIndex ? ['index'] : [])
    } else if (source === 'workspace') {
      scopes = scope === 'global' ? [] : this.selectScopes('workspace')
      kinds = ['topic', 'observation'].concat(includeIndex ? ['index'] : [])
    } else {
      scopes = this.selectScopes(scope)
      kinds = ['topic', 'observation', 'session'].concat(includeIndex ? ['index'] : [])
    }

    const files = await this.listFiles({
      scopes,
      kinds,
      includeIndex,
      maxFiles: this.config.searchMaxFiles,
    })
    const searchable = []
    for (const file of files) {
      if (file.kind === 'index' && !includeIndex) continue
      const doc = await this.readDocument(file.absolutePath)
      if (doc === null) continue
      let mtimeMs = file.mtimeMs
      if (file.kind === 'session') {
        const created = parseFrontmatter(doc.content).data.created
        const parsed = typeof created === 'string' ? Date.parse(created) : Number.NaN
        if (Number.isFinite(parsed)) mtimeMs = parsed
      }
      searchable.push({
        path: file.path,
        source: fileSource(file),
        content: doc.content,
        mtimeMs,
        title: doc.title,
      })
    }

    const signature = searchable.map((doc) => `${doc.path}:${doc.mtimeMs}:${doc.content.length}`).join('|')
    if (this.searchCache === null || this.searchCache.signature !== signature) {
      this.searchCache = {
        signature,
        index: buildSearchIndex(searchable, this.config),
      }
    }

    const results = searchIndex(this.searchCache.index, query, terms, {
      maxResults,
      minScore,
      halfLifeDays: this.config.searchHalfLifeDays,
      sourceWeights: this.config.searchSourceWeights,
      mmrEnabled: this.config.searchMmrEnabled,
      mmrLambda: this.config.searchMmrLambda,
    })

    return {
      query,
      terms,
      results,
      total: results.length,
      scopes,
      source,
      scanned: searchable.length,
    }
  }

  /**
   * Render the injection manifest once per session.
   *
   * @param {{maxBytes?:number, maxTopics?:number, maxObservations?:number, maxSessions?:number, always?:boolean}} [options]
   * @returns {Promise<string>} an empty string when memory has no notes and `always` is false.
   */
  async manifest(options = {}) {
    const maxBytes = options.maxBytes ?? this.config.injectMaxBytes
    const maxTopics = options.maxTopics ?? this.config.injectMaxTopics
    const maxObservations = options.maxObservations ?? this.config.injectMaxObservations
    const maxSessions = options.maxSessions ?? this.config.injectMaxSessions
    const always = options.always ?? this.config.injectAlways
    const sections = []

    for (const scope of this.enabledScopes()) {
      const topics = await this.readEntries(scope, 'topic')
      const observations = await this.readEntries(scope, 'observation')
      if (topics.length === 0 && observations.length === 0) continue

      const label = scope === 'global' ? 'Global memory' : 'Workspace memory'
      const lines = [`## ${label} (\`${this.scopePrefix(scope)}/\`)`]
      if (topics.length > 0) {
        lines.push('### Topics')
        for (const entry of topics.slice(0, maxTopics)) {
          lines.push(renderEntry(entry, true))
        }
        if (topics.length > maxTopics) lines.push(`- … ${topics.length - maxTopics} more topic(s)`)
      }
      if (observations.length > 0 && maxObservations > 0) {
        lines.push('### Pending observations')
        for (const entry of observations.slice(0, maxObservations)) {
          lines.push(renderEntry(entry, true))
        }
        if (observations.length > maxObservations) {
          lines.push(`- … ${observations.length - maxObservations} more observation(s)`)
        }
      }
      sections.push(lines.join('\n'))
    }

    if (this.scopeAvailable('workspace') && maxSessions > 0) {
      const sessions = await this.listFiles({ scopes: 'workspace', kinds: ['session'], readTitle: true, maxFiles: maxSessions })
      if (sessions.length > 0) {
        const lines = ['## Recent session logs']
        for (const session of sessions) {
          const date = new Date(session.mtimeMs).toISOString().slice(0, 10)
          const title = truncateText(session.title || basename(session.path), 100)
          lines.push(`- ${date} — **${title}** (\`${session.path}\`)`)
        }
        sections.push(lines.join('\n'))
      }
    }

    if (sections.length === 0) {
      if (!always) return ''
      return truncateUtf8(
        '<memory-context>\nPersistent memory is enabled, but no notes or session logs have been saved yet. Use memory_remember to save durable facts.\n</memory-context>',
        maxBytes,
      )
    }

    const intro =
      'Persistent memory index for this workspace and user. It lists saved notes; use memory_search for details, memory_get to read a file, memory_remember to save a fact, and memory_forget to remove one. Treat memory as historical context and verify changeable facts before relying on them.'
    const introText = truncateUtf8(intro, Math.max(64, maxBytes - 96))
    const body = escapeClosingTag(sections.join('\n\n'), 'memory-context')
    const frameBytes = Buffer.byteLength(`<memory-context>\n${introText}\n\n\n</memory-context>`, 'utf8')
    const bodyBudget = Math.max(16, maxBytes - frameBytes)
    let content = `<memory-context>\n${introText}\n\n${body}\n</memory-context>`
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      content = `<memory-context>\n${introText}\n\n${truncateUtf8(body, bodyBudget, '\n… (index truncated)')}\n</memory-context>`
    }
    return content
  }

  /** Read title/description entries for one scope and kind. */
  async readEntries(scope, kind) {
    const files = await this.listFiles({ scopes: scope, kinds: [kind], maxFiles: 512 })
    const entries = []
    for (const file of files) {
      const doc = await this.readDocument(file.absolutePath)
      if (doc === null) continue
      entries.push({
        path: file.path,
        title: extractTitle(doc.content, basename(file.path)),
        description: extractDescription(doc.content),
        mtimeMs: file.mtimeMs,
      })
    }
    if (kind === 'topic') entries.sort((left, right) => left.path.localeCompare(right.path))
    else entries.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    return entries
  }

  /** Regenerate a scope's `MEMORY.md` index from topics and observations. */
  async regenerateIndex(scope) {
    if (!this.scopeAvailable(scope)) return ''
    await ensureDir(this.scopeDir(scope))
    const topics = await this.readEntries(scope, 'topic')
    const observations = await this.readEntries(scope, 'observation')
    const content = renderScopeIndex(scope, topics, observations, {
      maxBytes: this.config.indexMaxBytes,
      maxEntries: this.config.indexMaxEntries,
      prefix: this.scopePrefix(scope),
    })
    await writeFileAtomic(join(this.scopeDir(scope), INDEX_FILE), content)
    return content
  }

  /** Count files and return recent entries for `/memory` listings. */
  async stats() {
    const result = { root: this.root, rootDisplay: this.config.memoryRootDisplay, scopes: [] }
    for (const scope of this.enabledScopes()) {
      const files = await this.listFiles({ scopes: scope, kinds: 'all', maxFiles: 5000 })
      const counts = { topic: 0, observation: 0, session: 0, index: 0 }
      for (const file of files) counts[file.kind] = (counts[file.kind] ?? 0) + 1
      const topics = await this.readEntries(scope, 'topic')
      result.scopes.push({
        scope,
        prefix: this.scopePrefix(scope),
        counts,
        topics: topics.slice(0, 8),
        files,
      })
    }
    return result
  }

  /** Remove one scope or all enabled scopes. */
  async clear(scope) {
    const targets = scope === 'all' ? this.enabledScopes() : [scope]
    const removed = []
    for (const target of targets) {
      if (!VALID_SCOPES.has(target)) throw new Error(`dsh-memory: unknown memory scope "${target}"`)
      if (!this.scopeAvailable(target)) continue
      const dir = this.scopeDir(target)
      if (!isWithin(this.root, dir) || dir === this.root) {
        throw new Error('dsh-memory: refusing to clear a directory outside the memory root')
      }
      if (await pathExists(dir)) {
        await removePath(dir)
        removed.push(this.scopePrefix(target))
      }
    }
    return { removed }
  }

  selectScopes(requested) {
    if (Array.isArray(requested)) {
      const result = []
      for (const entry of requested) {
        if (!VALID_SCOPES.has(entry)) throw new Error(`dsh-memory: unknown memory scope "${entry}"`)
        if (this.scopeAvailable(entry) && !result.includes(entry)) result.push(entry)
      }
      return result
    }
    if (requested === 'all' || requested === undefined || requested === null) return this.enabledScopes()
    if (requested === 'global') return this.scopeAvailable('global') ? ['global'] : []
    if (requested === 'workspace') return this.scopeAvailable('workspace') ? ['workspace'] : []
    throw new Error(`dsh-memory: unknown memory scope "${requested}"`)
  }
}

/** Render one scope's generated index. */
export function renderScopeIndex(scope, topics, observations, options) {
  const maxBytes = options.maxBytes
  const maxEntries = options.maxEntries
  const heading = scope === 'global' ? 'Global memory index' : 'Workspace memory index'
  const lines = [
    `# ${heading}`,
    '',
    'Generated by dsh-memory from `topics/` and `observations/_inbox/`. This file is rebuilt after every memory write; edit the topic or observation files instead.',
    '',
    'Paths are relative to the memory root and can be passed to memory_get.',
  ]

  let included = 0
  if (topics.length > 0) {
    lines.push('', '## Topics')
    for (const topic of topics) {
      if (included >= maxEntries) break
      lines.push(renderEntry(topic, true))
      included += 1
    }
  }
  if (observations.length > 0) {
    lines.push('', '## Pending observations')
    let observationCount = 0
    for (const observation of observations) {
      if (included >= maxEntries) break
      lines.push(renderEntry(observation, true))
      included += 1
      observationCount += 1
    }
    if (observations.length > observationCount) {
      lines.push(`- … ${observations.length - observationCount} more observation(s)`)
    }
  }
  if (included === 0) {
    lines.push('', 'No notes yet. Use `memory_remember` to save a durable fact.')
  }

  let content = lines.join('\n') + '\n'
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    content = truncateUtf8(content, maxBytes, '\n… (index truncated)\n')
  }
  return content
}

function renderEntry(entry, withDescription) {
  const title = truncateText(entry.title || basename(entry.path), 100)
  const description = withDescription ? truncateText(entry.description || '', 180) : ''
  const suffix = description.length > 0 ? ` — ${description}` : ''
  return `- **${title}**${suffix} (\`${entry.path}\`)`
}

function normalizeKinds(kinds, includeIndex) {
  let list
  if (kinds === 'all' || kinds === undefined || kinds === null) {
    list = ['index', 'topic', 'observation', 'session']
  } else {
    list = Array.isArray(kinds) ? kinds : [kinds]
  }
  const result = new Set()
  for (const kind of list) {
    if (!VALID_KINDS.has(kind)) throw new Error(`dsh-memory: unknown memory file kind "${kind}"`)
    if (kind === 'index' && !includeIndex) continue
    result.add(kind)
  }
  return result
}

function kindOf(within) {
  if (within === INDEX_FILE) return 'index'
  if (within.startsWith(`${TOPIC_DIR}/`)) return 'topic'
  if (within.startsWith(`${OBSERVATION_DIR.split(sep).join('/')}/`)) return 'observation'
  if (within.startsWith(`${SESSION_DIR}/`)) return 'session'
  return 'unknown'
}

function fileSource(file) {
  if (file.scope === 'global') return 'global'
  if (file.kind === 'session') return 'session'
  return 'workspace'
}

function compareFiles(left, right) {
  const order = { index: 0, topic: 1, observation: 2, session: 3, unknown: 4 }
  const byKind = (order[left.kind] ?? 4) - (order[right.kind] ?? 4)
  if (byKind !== 0) return byKind
  if (left.kind === 'session' || left.kind === 'observation') {
    return right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)
  }
  return left.path.localeCompare(right.path)
}

function buildAliases(raw, workspaceDirName) {
  const aliases = [raw]
  if (raw.startsWith('workspace/')) {
    const rest = raw.slice('workspace/'.length)
    if (workspaceDirName) aliases.push(`workspaces/${workspaceDirName}/${rest}`)
  } else if (raw === 'workspace') {
    if (workspaceDirName) aliases.push(`workspaces/${workspaceDirName}`)
  } else if (raw.startsWith('global/')) {
    aliases.push(raw)
  }
  return aliases
}

function isAbsolutePath(path) {
  return /^(?:[A-Za-z]:[\\/]|~[\\/]|\/)/.test(path) || path.startsWith('\\\\')
}

async function canonicalRootOf(root) {
  const info = await statSafe(root)
  if (info === null) return resolve(root)
  return canonicalPath(root)
}

async function canonicalPath(path) {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** Remove body lines containing any query term, preserving headings and frontmatter. */
function removeMatchingLines(content, terms) {
  const lines = String(content).split(/\r?\n/)
  const kept = []
  let removed = 0
  let inFrontmatter = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (index === 0 && trimmed === '---') {
      inFrontmatter = true
      kept.push(line)
      continue
    }
    if (inFrontmatter) {
      kept.push(line)
      if (trimmed === '---') inFrontmatter = false
      continue
    }
    if (trimmed === '' || /^#{1,6}\s+/.test(trimmed) || trimmed.startsWith('<!--')) {
      kept.push(line)
      continue
    }
    const lower = line.toLowerCase()
    if (terms.some((term) => lower.includes(term))) {
      removed += 1
      continue
    }
    kept.push(line)
  }

  const contentOut = []
  let blanks = 0
  for (const line of kept) {
    if (line.trim() === '') {
      blanks += 1
      if (blanks > 2) continue
    } else {
      blanks = 0
    }
    contentOut.push(line)
  }
  return { content: contentOut.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed }
}

/** Whether content has more than headings, comments, and whitespace. */
function hasSubstantiveContent(content) {
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (/^#{1,6}\s+/.test(trimmed)) continue
    if (trimmed.startsWith('<!--') || trimmed.startsWith('-->')) continue
    return true
  }
  return false
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

// Re-export helpers used by tests and adjacent modules.
export { kindOf, fileSource, removeMatchingLines }
