/**
 * Configuration normalization for dsh-memory.
 *
 * Values are validated here; every option has a documented default.
 *
 * @module dsh-memory/config
 */

import { resolve as resolvePath } from 'node:path'
import { expandHome, resolveDshHome } from './paths.js'

/** Default values for every accepted option. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  memoryDir: '',
  scopeGlobal: true,
  scopeWorkspace: true,

  toolsEnabled: true,
  promptEnabled: true,
  commandsEnabled: true,
  promptInstructions: '',

  captureEnabled: true,
  captureSubagents: false,
  captureMinTurnChars: 24,
  captureMaxUserChars: 2000,
  captureMaxAssistantChars: 2000,
  captureMaxEntryChars: 6000,
  captureMaxFileBytes: 2_000_000,

  injectEnabled: true,
  injectSubagents: false,
  injectAlways: false,
  injectAfterCompaction: true,
  injectMaxBytes: 4096,
  injectMaxTopics: 40,
  injectMaxObservations: 8,
  injectMaxSessions: 8,

  searchMaxResults: 6,
  searchMinScore: 0.7,
  searchHalfLifeDays: 30,
  searchMmrEnabled: true,
  searchMmrLambda: 0.7,
  searchMaxFiles: 2000,
  searchMaxFileBytes: 2_000_000,
  searchMaxChunks: 600,
  searchStalenessDays: 7,
  searchIncludeIndex: false,
  searchSourceWeights: Object.freeze({ global: 1, workspace: 1, session: 1 }),

  chunkMaxChars: 1600,
  chunkOverlapChars: 320,

  indexMaxBytes: 8192,
  indexMaxEntries: 64,

  skipTemporaryWorkspaces: false,
})

/** Options that accept a value; anything else is reported as unknown. */
const KNOWN_KEYS = new Set(Object.keys(DEFAULT_CONFIG))

/** Source names accepted in `searchSourceWeights`. */
const SOURCE_NAMES = ['global', 'workspace', 'session']

/**
 * @typedef {object} MemoryConfig
 * @property {boolean} enabled
 * @property {string} memoryDir Absolute memory root.
 * @property {string} memoryRootDisplay Stable display form of the memory root.
 * @property {boolean} scopeGlobal
 * @property {boolean} scopeWorkspace
 * @property {boolean} toolsEnabled
 * @property {boolean} promptEnabled
 * @property {boolean} commandsEnabled
 * @property {string} promptInstructions
 * @property {boolean} captureEnabled
 * @property {boolean} captureSubagents
 * @property {number} captureMinTurnChars
 * @property {number} captureMaxUserChars
 * @property {number} captureMaxAssistantChars
 * @property {number} captureMaxEntryChars
 * @property {number} captureMaxFileBytes
 * @property {boolean} injectEnabled
 * @property {boolean} injectSubagents
 * @property {boolean} injectAlways
 * @property {boolean} injectAfterCompaction
 * @property {number} injectMaxBytes
 * @property {number} injectMaxTopics
 * @property {number} injectMaxObservations
 * @property {number} injectMaxSessions
 * @property {number} searchMaxResults
 * @property {number} searchMinScore
 * @property {number} searchHalfLifeDays
 * @property {boolean} searchMmrEnabled
 * @property {number} searchMmrLambda
 * @property {number} searchMaxFiles
 * @property {number} searchMaxFileBytes
 * @property {number} searchMaxChunks
 * @property {number} searchStalenessDays
 * @property {boolean} searchIncludeIndex
 * @property {{global:number,workspace:number,session:number}} searchSourceWeights
 * @property {number} chunkMaxChars
 * @property {number} chunkOverlapChars
 * @property {number} indexMaxBytes
 * @property {number} indexMaxEntries
 * @property {boolean} skipTemporaryWorkspaces
 * @property {string[]} warnings
 */

/**
 * Normalize one raw bundle configuration.
 *
 * @param {unknown} raw The `config` object from `cordis.patch.yml`.
 * @param {{env?: NodeJS.ProcessEnv}} [options] Test seam for environment lookups.
 * @returns {MemoryConfig} frozen, fully resolved configuration.
 */
export function resolveConfig(raw, options = {}) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('dsh-memory: config must be a mapping of option names to values')
  }

  const warnings = []
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown config option "${key}" was ignored`)
  }

  const env = options.env ?? process.env
  const dshHome = resolveDshHome(env)
  const configuredDir = optionalString(raw.memoryDir, 'memoryDir')
  const memoryDir = configuredDir
    ? resolvePath(expandHome(configuredDir))
    : resolvePath(dshHome, 'memory')

  /** @type {MemoryConfig} */
  const config = {
    enabled: bool(raw.enabled, DEFAULT_CONFIG.enabled, 'enabled'),
    memoryDir,
    memoryRootDisplay: displayMemoryDir(configuredDir, memoryDir, dshHome, env),
    scopeGlobal: bool(raw.scopeGlobal, DEFAULT_CONFIG.scopeGlobal, 'scopeGlobal'),
    scopeWorkspace: bool(raw.scopeWorkspace, DEFAULT_CONFIG.scopeWorkspace, 'scopeWorkspace'),

    toolsEnabled: bool(raw.toolsEnabled, DEFAULT_CONFIG.toolsEnabled, 'toolsEnabled'),
    promptEnabled: bool(raw.promptEnabled, DEFAULT_CONFIG.promptEnabled, 'promptEnabled'),
    commandsEnabled: bool(raw.commandsEnabled, DEFAULT_CONFIG.commandsEnabled, 'commandsEnabled'),
    promptInstructions: optionalString(raw.promptInstructions, 'promptInstructions') ?? '',

    captureEnabled: bool(raw.captureEnabled, DEFAULT_CONFIG.captureEnabled, 'captureEnabled'),
    captureSubagents: bool(raw.captureSubagents, DEFAULT_CONFIG.captureSubagents, 'captureSubagents'),
    captureMinTurnChars: number(raw.captureMinTurnChars, DEFAULT_CONFIG.captureMinTurnChars, 'captureMinTurnChars', {
      min: 0,
      max: 10_000,
      integer: true,
    }),
    captureMaxUserChars: number(raw.captureMaxUserChars, DEFAULT_CONFIG.captureMaxUserChars, 'captureMaxUserChars', {
      min: 1,
      max: 100_000,
      integer: true,
    }),
    captureMaxAssistantChars: number(
      raw.captureMaxAssistantChars,
      DEFAULT_CONFIG.captureMaxAssistantChars,
      'captureMaxAssistantChars',
      { min: 1, max: 100_000, integer: true },
    ),
    captureMaxEntryChars: number(raw.captureMaxEntryChars, DEFAULT_CONFIG.captureMaxEntryChars, 'captureMaxEntryChars', {
      min: 200,
      max: 200_000,
      integer: true,
    }),
    captureMaxFileBytes: number(
      raw.captureMaxFileBytes,
      DEFAULT_CONFIG.captureMaxFileBytes,
      'captureMaxFileBytes',
      { min: 4096, max: 100_000_000, integer: true },
    ),

    injectEnabled: bool(raw.injectEnabled, DEFAULT_CONFIG.injectEnabled, 'injectEnabled'),
    injectSubagents: bool(raw.injectSubagents, DEFAULT_CONFIG.injectSubagents, 'injectSubagents'),
    injectAlways: bool(raw.injectAlways, DEFAULT_CONFIG.injectAlways, 'injectAlways'),
    injectAfterCompaction: bool(
      raw.injectAfterCompaction,
      DEFAULT_CONFIG.injectAfterCompaction,
      'injectAfterCompaction',
    ),
    injectMaxBytes: number(raw.injectMaxBytes, DEFAULT_CONFIG.injectMaxBytes, 'injectMaxBytes', {
      min: 256,
      max: 65_536,
      integer: true,
    }),
    injectMaxTopics: number(raw.injectMaxTopics, DEFAULT_CONFIG.injectMaxTopics, 'injectMaxTopics', {
      min: 1,
      max: 512,
      integer: true,
    }),
    injectMaxObservations: number(
      raw.injectMaxObservations,
      DEFAULT_CONFIG.injectMaxObservations,
      'injectMaxObservations',
      { min: 0, max: 512, integer: true },
    ),
    injectMaxSessions: number(raw.injectMaxSessions, DEFAULT_CONFIG.injectMaxSessions, 'injectMaxSessions', {
      min: 0,
      max: 512,
      integer: true,
    }),

    searchMaxResults: number(raw.searchMaxResults, DEFAULT_CONFIG.searchMaxResults, 'searchMaxResults', {
      min: 1,
      max: 50,
      integer: true,
    }),
    searchMinScore: number(raw.searchMinScore, DEFAULT_CONFIG.searchMinScore, 'searchMinScore', {
      min: 0,
      max: 1,
    }),
    searchHalfLifeDays: number(raw.searchHalfLifeDays, DEFAULT_CONFIG.searchHalfLifeDays, 'searchHalfLifeDays', {
      min: 0,
      max: 3650,
    }),
    searchMmrEnabled: bool(raw.searchMmrEnabled, DEFAULT_CONFIG.searchMmrEnabled, 'searchMmrEnabled'),
    searchMmrLambda: number(raw.searchMmrLambda, DEFAULT_CONFIG.searchMmrLambda, 'searchMmrLambda', {
      min: 0,
      max: 1,
    }),
    searchMaxFiles: number(raw.searchMaxFiles, DEFAULT_CONFIG.searchMaxFiles, 'searchMaxFiles', {
      min: 1,
      max: 20_000,
      integer: true,
    }),
    searchMaxFileBytes: number(raw.searchMaxFileBytes, DEFAULT_CONFIG.searchMaxFileBytes, 'searchMaxFileBytes', {
      min: 1024,
      max: 100_000_000,
      integer: true,
    }),
    searchMaxChunks: number(raw.searchMaxChunks, DEFAULT_CONFIG.searchMaxChunks, 'searchMaxChunks', {
      min: 1,
      max: 50_000,
      integer: true,
    }),
    searchStalenessDays: number(raw.searchStalenessDays, DEFAULT_CONFIG.searchStalenessDays, 'searchStalenessDays', {
      min: 0,
      max: 3650,
      integer: true,
    }),
    searchIncludeIndex: bool(raw.searchIncludeIndex, DEFAULT_CONFIG.searchIncludeIndex, 'searchIncludeIndex'),
    searchSourceWeights: sourceWeights(raw.searchSourceWeights),

    chunkMaxChars: number(raw.chunkMaxChars, DEFAULT_CONFIG.chunkMaxChars, 'chunkMaxChars', {
      min: 200,
      max: 40_000,
      integer: true,
    }),
    chunkOverlapChars: number(raw.chunkOverlapChars, DEFAULT_CONFIG.chunkOverlapChars, 'chunkOverlapChars', {
      min: 0,
      max: 20_000,
      integer: true,
    }),
    indexMaxBytes: number(raw.indexMaxBytes, DEFAULT_CONFIG.indexMaxBytes, 'indexMaxBytes', {
      min: 512,
      max: 65_536,
      integer: true,
    }),
    indexMaxEntries: number(raw.indexMaxEntries, DEFAULT_CONFIG.indexMaxEntries, 'indexMaxEntries', {
      min: 1,
      max: 2048,
      integer: true,
    }),

    skipTemporaryWorkspaces: bool(
      raw.skipTemporaryWorkspaces,
      DEFAULT_CONFIG.skipTemporaryWorkspaces,
      'skipTemporaryWorkspaces',
    ),
    warnings,
  }

  if (config.chunkOverlapChars > Math.floor(config.chunkMaxChars / 2)) {
    throw new RangeError('dsh-memory: chunkOverlapChars must not exceed half of chunkMaxChars')
  }
  if (config.memoryDir.length === 0) throw new Error('dsh-memory: memoryDir resolved to an empty path')
  if (!config.scopeGlobal && !config.scopeWorkspace) {
    warnings.push('both scopeGlobal and scopeWorkspace are disabled; memory tools will find nothing')
  }

  return Object.freeze(config)
}

/** Resolve a stable user-facing path for the memory root. */
function displayMemoryDir(configured, memoryDir, dshHome, env) {
  if (!configured) {
    return env.DSH_HOME && env.DSH_HOME.trim()
      ? '$DSH_HOME/memory'
      : '~/.dsh/memory'
  }
  if (memoryDir === resolvePath(dshHome, 'memory')) {
    return env.DSH_HOME && env.DSH_HOME.trim() ? '$DSH_HOME/memory' : '~/.dsh/memory'
  }
  return memoryDir
}

function bool(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`dsh-memory: ${name} must be a boolean`)
  return value
}

function optionalString(value, name) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new TypeError(`dsh-memory: ${name} must be a string`)
  return value.trim()
}

function number(value, fallback, name, bounds) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`dsh-memory: ${name} must be a finite number`)
  }
  if (bounds.integer && !Number.isInteger(value)) {
    throw new TypeError(`dsh-memory: ${name} must be an integer`)
  }
  if (value < bounds.min || value > bounds.max) {
    throw new RangeError(`dsh-memory: ${name} must be between ${bounds.min} and ${bounds.max}`)
  }
  return value
}

function sourceWeights(value) {
  const result = {
    global: DEFAULT_CONFIG.searchSourceWeights.global,
    workspace: DEFAULT_CONFIG.searchSourceWeights.workspace,
    session: DEFAULT_CONFIG.searchSourceWeights.session,
  }
  if (value === undefined) return Object.freeze(result)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('dsh-memory: searchSourceWeights must be an object of source names to numbers')
  }
  for (const [key, raw] of Object.entries(value)) {
    if (!SOURCE_NAMES.includes(key)) {
      throw new TypeError(`dsh-memory: searchSourceWeights has unknown source "${key}"`)
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
      throw new RangeError(`dsh-memory: searchSourceWeights.${key} must be a number between 0 and 100`)
    }
    result[key] = raw
  }
  return Object.freeze(result)
}
