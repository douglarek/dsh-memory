#!/usr/bin/env node
/**
 * Lightweight release check: syntax-check every JavaScript file, parse every
 * JSON file, and verify that the bundle's declared entry points exist.
 */

import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = []

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.isFile()) files.push(path)
  }
}

await walk(root)

let failed = false
for (const file of files.filter((path) => path.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    console.log(`ok  ${file.slice(root.length + 1)}`)
  } catch (error) {
    failed = true
    console.error(`ERR ${file.slice(root.length + 1)}`)
    console.error(error.stderr?.toString() ?? error.message)
  }
}

for (const file of files.filter((path) => path.endsWith('.json'))) {
  try {
    JSON.parse(await readFile(file, 'utf8'))
    console.log(`ok  ${file.slice(root.length + 1)}`)
  } catch (error) {
    failed = true
    console.error(`ERR ${file.slice(root.length + 1)}: ${error.message}`)
  }
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const requiredFiles = [manifest.main, manifest.dsh?.bundle?.patch, './icon.svg', './locale/en.json', './locale/zh.json']
for (const relativePath of requiredFiles.filter(Boolean)) {
  const path = resolve(root, relativePath)
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('not a regular file')
    console.log(`ok  ${relativePath}`)
  } catch (error) {
    failed = true
    console.error(`ERR missing ${relativePath}: ${error.message}`)
  }
}

if (failed) process.exitCode = 1
