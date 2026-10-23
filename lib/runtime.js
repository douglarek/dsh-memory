/**
 * Plugin runtime: workspace resolution, store caching, first-turn injection,
 * post-compaction refresh, prompt contribution, and capture wiring.
 *
 * @module dsh-memory/runtime
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { resolveWorkspaceScope, slugify, shortHash } from './paths.js'
import { MemoryStore } from './store.js'
import { CaptureManager } from './capture.js'
import { deepFreeze } from './text.js'

const MAX_STORE_CACHE = 64
const MAX_WORKSPACE_CACHE = 128
const INJECTION_SECTION_ORDER = 4000

export class MemoryRuntime {
  /**
   * @param {object} options
   * @param {object} options.ctx Cordis context.
   * @param {import('./config.js').MemoryConfig} options.config
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.logger = options.ctx.logger ?? {}
    /** @type {Map<string,MemoryStore>} */
    this.stores = new Map()
    /** @type {Map<string,object>} */
    this.workspaces = new Map()
    /** @type {WeakSet<object>} */
    this.injected = new WeakSet()
    /** @type {WeakSet<object>} */
    this.pendingRefresh = new WeakSet()
    this.capture = new CaptureManager({
      config: this.config,
      resolveStore: (session) => this.storeForSession(session),
      logger: this.logger,
    })
  }

  /** Install prompt/listener contributions. Tools and commands are registered by the entry module. */
  install(ctx) {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && systemPrompt !== null && this.config.promptEnabled) {
      const text = this.config.promptInstructions.length > 0 ? this.config.promptInstructions : this.defaultPrompt()
      ctx.effect(
        () =>
          systemPrompt.section({
            name: 'dsh-memory:instructions',
            order: INJECTION_SECTION_ORDER,
            text,
            interpolate: false,
          }),
        'dsh-memory.prompt',
      )
    }

    ctx.on('session/event', (session, event) => {
      try {
        this.capture.observe(session, event)
      } catch (error) {
        this.logger.warn?.('dsh-memory: capture observer failed:', error)
      }
      if (
        this.config.injectEnabled &&
        this.config.injectAfterCompaction &&
        event?.type === 'compaction/end'
      ) {
        this.pendingRefresh.add(session)
      }
    })

    if (this.config.injectEnabled) {
      ctx.on('agent/pre-step', (payload, next) => this.preStep(payload, next))
    }
  }

  /** The default model-facing instructions section. */
  defaultPrompt() {
    return [
      '<memory>',
      'You have persistent cross-session memory. It is a user-controlled Markdown knowledge base of what earlier sessions learned, stored at ' + this.config.memoryRootDisplay + '.',
      '',
      'Use the memory tools proactively:',
      '- `memory_search` before asking the user to repeat context, when a request references prior work or decisions, when you need project conventions or preferences, or after compaction.',
      '- `memory_get` to read a full note or a line range after a search result points at it.',
      '- `memory_remember` when the user asks you to remember something, or when a fact is stable, specific, useful across sessions, and not already obvious from the repository. Use scope `workspace` for this project and scope `global` for cross-project preferences. Prefer a focused `topic` file over repeating the same fact.',
      '- `memory_forget` to remove a note the user asks you to forget, or to remove a superseded observation after saving its replacement.',
      '',
      'Do not store secrets, credentials, tokens, transient task state, speculative conclusions, or facts likely to become stale. Memory is historical context, not current truth: verify paths, commands, repository state, and external facts with live tools before relying on them, and prefer current evidence when it conflicts with memory. The user\'s instructions in this conversation override memory.',
      '</memory>',
    ].join('\n')
  }

  /** Resolve the Session working directory, falling back to the header project. */
  async resolveCwd(agent, signal) {
    const workingDirectory = this.ctx.get('workingDirectory')
    if (workingDirectory !== undefined && workingDirectory !== null && typeof workingDirectory.ensure === 'function') {
      try {
        const cwd = await workingDirectory.ensure(agent, signal)
        if (typeof cwd === 'string' && cwd.length > 0) return cwd
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    const headerCwd = agent?.session?.header?.cwd
    if (typeof headerCwd === 'string' && headerCwd.length > 0) return headerCwd
    return process.cwd()
  }

  /** Resolve a store for one live agent. */
  async storeForAgent(agent, signal) {
    const cwd = await this.resolveCwd(agent, signal)
    return this.storeForCwd(cwd)
  }

  /** Resolve a store for one session (capture path, header cwd only). */
  async storeForSession(session) {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    return this.storeForCwd(cwd)
  }

  /** Resolve or create the cached store for a working directory. */
  async storeForCwd(cwd) {
    const workspace = await this.resolveWorkspace(cwd)
    const key = workspace?.dirName ?? 'global-only'
    let store = this.stores.get(key)
    if (store === undefined) {
      store = new MemoryStore({
        root: this.config.memoryDir,
        workspace,
        config: this.config,
        logger: this.logger,
      })
      this.stores.set(key, store)
      while (this.stores.size > MAX_STORE_CACHE) {
        const first = this.stores.keys().next().value
        if (first === undefined) break
        this.stores.delete(first)
      }
    }
    return { store, workspace }
  }

  async resolveWorkspace(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const key = `${cwd}:${this.config.skipTemporaryWorkspaces ? '1' : '0'}`
    const cached = this.workspaces.get(key)
    if (cached !== undefined) return cached
    let workspace
    try {
      workspace = await resolveWorkspaceScope(cwd, {
        skipTemporaryWorkspaces: this.config.skipTemporaryWorkspaces,
      })
    } catch (error) {
      this.logger.warn?.('dsh-memory: workspace discovery failed, using a path-derived scope:', error)
      workspace = {
        key: shortHash(cwd, 8),
        root: cwd,
        projectRoot: cwd,
        identity: cwd,
        dirName: `${slugify(basename(cwd), 40) || 'workspace'}-${shortHash(cwd, 8)}`,
        ephemeral: false,
      }
    }
    this.workspaces.set(key, workspace)
    while (this.workspaces.size > MAX_WORKSPACE_CACHE) {
      const first = this.workspaces.keys().next().value
      if (first === undefined) break
      this.workspaces.delete(first)
    }
    return workspace
  }

  /** First-turn baseline and post-compaction refresh injection. */
  async preStep(payload, next) {
    const decision = await next()
    try {
      if (!this.config.injectEnabled) return decision
      if (decision.kind === 'reject') return decision
      if (payload.step === 1 && decision.messages.length === 0) return decision

      const agent = payload.agent
      const session = agent?.session
      if (session === undefined || session === null) return decision
      if (session.header?.parentSession != null && !this.config.injectSubagents) return decision

      const refresh = this.pendingRefresh.has(session)
      const alreadyInjected = this.hasInjected(session)
      if (alreadyInjected && !refresh) return decision
      if (refresh) this.pendingRefresh.delete(session)

      const { store, workspace } = await this.storeForAgent(agent, payload.signal)
      const text = await store.manifest({
        maxBytes: refresh
          ? Math.min(this.config.injectMaxBytes, Math.max(1024, Math.floor(this.config.injectMaxBytes / 2)))
          : this.config.injectMaxBytes,
        always: this.config.injectAlways,
      })
      if (text.length === 0) return decision

      if (payload.signal?.aborted) return decision
      const form = refresh ? 'refresh' : 'baseline'
      const duplicate = decision.messages.some(
        (message) =>
          message?.source?.kind === 'dsh-memory' &&
          JSON.stringify(message.content) === JSON.stringify([{ type: 'text', text }]),
      )
      if (duplicate) {
        this.injected.add(session)
        return decision
      }

      const message = createMemoryMessage(text, {
        form,
        workspace: workspace?.dirName ?? null,
      })
      const lastClaimed = decision.messages.findLastIndex((candidate) => payload.messages.includes(candidate))
      const entered = decision.messages.toSpliced(lastClaimed + 1, 0, message)
      this.injected.add(session)
      return { ...decision, messages: entered }
    } catch (error) {
      this.logger.warn?.('dsh-memory: memory injection failed:', error)
      return decision
    }
  }

  /** Whether this session already carries a dsh-memory context message. */
  hasInjected(session) {
    if (this.injected.has(session)) return true
    try {
      const nodes = session.surface?.nodes
      if (nodes !== undefined && nodes !== null && typeof session.eventAt === 'function') {
        for (const seq of nodes) {
          const event = session.eventAt(seq)
          if (event?.type === 'user/message' && event.data?.source?.kind === 'dsh-memory') {
            this.injected.add(session)
            return true
          }
        }
      }
    } catch {
      // A detached or older session may not expose its surface; injection is
      // best-effort and must never block the turn.
    }
    return false
  }

  /** Stop background capture and wait for queued writes. */
  async dispose() {
    await this.capture.drain()
  }
}

/**
 * Create one identified, immutable user-role memory context message.
 */
export function createMemoryMessage(text, source) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'dsh-memory',
      ...source,
    },
  })
}
