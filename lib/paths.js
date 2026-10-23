/**
 * Filesystem path resolution for dsh-memory.
 *
 * Memory lives outside the user's repository under the Harness home. Workspace
 * scopes are keyed the way Grok Build keys them: by the git `origin` identity
 * when one exists (so clones and worktrees share a scope), otherwise by the
 * canonical project directory. The directory name is `{slug}-{hash8}`.
 *
 * @module dsh-memory/paths
 */

import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'

const DSH_HOME_DIR = '.dsh'
const MAX_GIT_CONFIG_BYTES = 256 * 1024

/** Resolve the DeepSeek Harness home the same way dsh-home-paths does. */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured.length > 0) return resolve(expandHome(configured))
  return join(homedir(), DSH_HOME_DIR)
}

/** Expand a bare `~`, `~/…`, or `~\…` prefix; leave everything else untouched. */
export function expandHome(input) {
  if (typeof input !== 'string') return input
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

/** Canonicalize an existing path, falling back to `resolve()` when it is absent. */
export async function canonicalizeExisting(input) {
  try {
    return await realpath(input)
  } catch {
    return resolve(input)
  }
}

/**
 * Walk upward from `cwd` until a directory containing `.git` is found.
 *
 * @param {string} cwd absolute starting directory.
 * @returns {Promise<string|null>} the project root, or null for a non-repository tree.
 */
export async function findProjectRoot(cwd) {
  let current = await canonicalizeExisting(cwd)
  while (true) {
    if (await pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Read the `origin` remote URL from a repository's git config.
 *
 * Supports ordinary repositories, worktrees where `.git` is a `gitdir:` file,
 * and repositories without an origin remote. No `git` process is spawned.
 *
 * @param {string} projectRoot directory containing `.git`.
 * @returns {Promise<string|null>} normalized `org/repo` identity, or null.
 */
export async function readGitRemoteIdentity(projectRoot) {
  const dotGit = join(projectRoot, '.git')
  let gitDir = dotGit
  try {
    const info = await stat(dotGit)
    if (info.isFile()) {
      const pointer = await readFile(dotGit, 'utf8')
      const match = pointer.match(/^gitdir:\s*(.+)$/m)
      if (!match) return null
      const raw = match[1].trim()
      gitDir = isAbsolute(raw) ? raw : resolve(projectRoot, raw)
    }
  } catch {
    return null
  }

  const candidates = [
    join(gitDir, 'config'),
    join(gitDir, '..', 'config'),
    join(gitDir, '..', '..', 'config'),
  ]
  for (const configPath of candidates) {
    const config = await readBounded(configPath, MAX_GIT_CONFIG_BYTES)
    if (config === null) continue
    const url = parseOriginUrl(config)
    if (url === null) continue
    const identity = normalizeRemoteUrl(url)
    if (identity !== null) return identity
  }
  return null
}

/** Parse the first `url` value in the `[remote "origin"]` section. */
function parseOriginUrl(config) {
  let inOrigin = false
  for (const rawLine of config.split(/\r?\n/)) {
    const line = rawLine.trim()
    const section = line.match(/^\[\s*remote\s+"([^"]+)"\s*\]$/)
    if (section) {
      inOrigin = section[1] === 'origin'
      continue
    }
    if (/^\[/.test(line)) {
      inOrigin = false
      continue
    }
    if (!inOrigin) continue
    const match = line.match(/^url\s*=\s*(.+)$/)
    if (match) return match[1].trim()
  }
  return null
}

/**
 * Normalize a git remote URL to `org/repo` (or a longer host-relative path).
 *
 * Accepts scp-like SSH, ssh://, https://, http://, and git:// forms.
 *
 * @param {string} url raw remote URL.
 * @returns {string|null} normalized identity, or null when no repository path is present.
 */
export function normalizeRemoteUrl(url) {
  if (typeof url !== 'string') return null
  let value = url.trim()
  if (value.length === 0) return null

  let path = null
  const schemeIndex = value.indexOf('://')
  if (schemeIndex >= 0) {
    try {
      const parsed = new URL(value)
      path = parsed.pathname
    } catch {
      return null
    }
  } else {
    // scp-like: git@host:org/repo.git
    const match = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
    if (!match) return null
    path = match[2]
  }

  if (path === null) return null
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (path.length === 0 || !path.includes('/')) return null
  // Reject host-like single segments and path traversal.
  if (path.split('/').some((part) => part === '..' || part === '.' || part.length === 0)) return null
  return path
}

/**
 * Resolve one workspace scope identity and directory name.
 *
 * @param {string} cwd absolute session working directory.
 * @param {{skipTemporaryWorkspaces?: boolean}} [options]
 * @returns {Promise<{key:string|null,root:string,projectRoot:string|null,identity:string|null,dirName:string|null,ephemeral:boolean}>}
 */
export async function resolveWorkspaceScope(cwd, options = {}) {
  const root = await canonicalizeExisting(cwd)
  if (options.skipTemporaryWorkspaces && isTemporaryPath(root)) {
    return { key: null, root, projectRoot: null, identity: null, dirName: null, ephemeral: true }
  }

  const projectRoot = (await findProjectRoot(root)) ?? root
  const remote = await readGitRemoteIdentity(projectRoot)
  const identity = remote ?? projectRoot
  const base = remote ? remote.split('/').pop() || 'workspace' : basename(projectRoot)
  const slug = slugify(base, 40) || 'workspace'
  const hash8 = shortHash(identity, 8)
  const dirName = `${slug}-${hash8}`

  return {
    key: hash8,
    root,
    projectRoot,
    identity,
    dirName,
    ephemeral: false,
  }
}

/** True when a path is under a known temporary root. */
export function isTemporaryPath(input) {
  const posix = resolve(input).split(sep).join('/')
  if (posix === '/tmp' || posix.startsWith('/tmp/')) return true
  if (posix === '/var/tmp' || posix.startsWith('/var/tmp/')) return true
  if (posix === '/private/tmp' || posix.startsWith('/private/tmp/')) return true
  if (posix === '/private/var/tmp' || posix.startsWith('/private/var/tmp/')) return true
  if (/^\/private\/var\/folders\/[^/]+\/[^/]+\/T(\/|$)/.test(posix)) return true
  if (/^\/var\/folders\/[^/]+\/[^/]+\/T(\/|$)/.test(posix)) return true
  return false
}

/**
 * Convert any text into a filesystem-safe slug.
 *
 * Unicode letters and digits survive, so Chinese titles keep their meaning.
 *
 * @param {string} input
 * @param {number} [maxLength]
 * @returns {string}
 */
export function slugify(input, maxLength = 48) {
  if (typeof input !== 'string') return ''
  const normalized = input.normalize('NFKC').toLowerCase()
  let result = ''
  let lastDash = false
  for (const char of normalized) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      result += char
      lastDash = false
    } else if (!lastDash) {
      result += '-'
      lastDash = true
    }
  }
  result = result.replace(/^-+|-+$/g, '')
  const chars = Array.from(result)
  if (chars.length > maxLength) result = chars.slice(0, maxLength).join('')
  return result.replace(/-+$/g, '')
}

/** Lowercase SHA-256 prefix used for stable scope keys. */
export function shortHash(input, length = 8) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, Math.max(1, length))
}

/** Whether `target` is `root` or a descendant of `root`. */
export function isWithin(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel))
}

/** Render a path relative to the memory root with forward slashes. */
export function toMemoryPath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join('/')
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readBounded(path, maxBytes) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > maxBytes) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
