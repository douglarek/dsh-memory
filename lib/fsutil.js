/**
 * Small filesystem helpers shared by the memory store and capture pipeline.
 *
 * Memory files are private user data: directories are created with mode 0700
 * and files with mode 0600 (subject to umask). Replacing a generated index is
 * atomic so a concurrent reader never sees a partial file.
 *
 * @module dsh-memory/fsutil
 */

import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

/** Ensure a directory exists with private permissions. */
export async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE })
}

/** True when the path exists (file or directory). */
export async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Stat a path, returning null instead of throwing for absent entries. */
export async function statSafe(path) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/**
 * Read a UTF-8 file with a byte ceiling.
 *
 * @returns {Promise<{content:string,bytes:number,truncated:boolean}|null>}
 */
export async function readTextBounded(path, maxBytes) {
  const info = await statSafe(path)
  if (info === null || !info.isFile()) return null
  const bytes = Math.min(info.size, maxBytes)
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    const content = buffer.subarray(0, bytesRead).toString('utf8')
    return { content, bytes: info.size, truncated: info.size > bytes }
  } finally {
    await handle.close()
  }
}

/** Replace a file atomically through a same-directory temporary file. */
export async function writeFileAtomic(path, content) {
  const directory = dirname(path)
  await ensureDir(directory)
  const temp = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: FILE_MODE })
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** Append UTF-8 text, creating the file with private permissions. */
export async function appendText(path, content) {
  await ensureDir(dirname(path))
  await appendFile(path, content, { encoding: 'utf8', mode: FILE_MODE })
}

/** Remove a file or directory tree, ignoring absence. */
export async function removePath(path) {
  await rm(path, { recursive: true, force: true })
}

/** Read a JSON file, returning null for absence or invalid JSON. */
export async function readJson(path) {
  const read = await readTextBounded(path, 1024 * 1024)
  if (read === null) return null
  try {
    return JSON.parse(read.content)
  } catch {
    return null
  }
}

/** Write JSON atomically. */
export async function writeJsonAtomic(path, value) {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * List regular files under a directory without following symlinks.
 *
 * @param {string} root
 * @param {{maxFiles?: number, extensions?: string[]}} [options]
 * @returns {Promise<Array<{path:string, size:number, mtimeMs:number}>>}
 */
export async function listFilesRecursive(root, options = {}) {
  const maxFiles = options.maxFiles ?? 5000
  const extensions = options.extensions ?? null
  const results = []
  const queue = [resolve(root)]

  while (queue.length > 0 && results.length < maxFiles) {
    const current = queue.shift()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break
      if (entry.name.startsWith('.')) continue
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        queue.push(path)
        continue
      }
      if (!entry.isFile()) continue
      if (extensions !== null && !extensions.some((extension) => entry.name.endsWith(extension))) continue
      const info = await statSafe(path)
      if (info === null || !info.isFile()) continue
      results.push({ path, size: info.size, mtimeMs: info.mtimeMs })
    }
  }

  return results
}
