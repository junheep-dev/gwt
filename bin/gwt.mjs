#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { emitKeypressEvents } from "node:readline"
import { createInterface } from "node:readline/promises"

const PROJECT_CONFIG_FILE = ".gwt.json"
const PORT_MIN = 20_000
const PORT_MAX = 39_999
const PICKER_ESCAPE_CODE_TIMEOUT_MS = 50
const JOB_START_GRACE_MS = 30_000
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SHELL_ENV_STATE = "GWT_SHELL_ENV_STATE"
const DEFAULT_CONFIG = { copyFiles: [], ports: [], env: {} }
const SKILL_DIRECTORIES = { claude: ".claude", codex: ".agents" }
const SKILL_USAGE = `Usage: gwt skill install <${Object.keys(SKILL_DIRECTORIES).join("|")}> [--project] [--dry-run] [--yes]`

class CliError extends Error {}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
  })

  if (result.error) throw new CliError(`${command}: ${result.error.message}`)
  if (result.status !== 0 && !options.allowFailure) {
    const detail = result.stderr?.trim() || result.stdout?.trim()
    throw new CliError(detail || `${command} exited with status ${result.status}`)
  }

  return result
}

function git(args, cwd, options = {}) {
  return run("git", args, { cwd, ...options })
}

function gitOutput(args, cwd) {
  return git(args, cwd).stdout.trim()
}

function pathExists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function canonical(path) {
  return realpathSync(resolve(path))
}

function isInside(root, path) {
  const pathFromRoot = relative(root, path)
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
}

function parseWorktrees(raw) {
  const worktrees = []
  let current = null

  for (const field of raw.split("\0")) {
    if (!field) {
      if (current) worktrees.push(current)
      current = null
      continue
    }

    const separator = field.indexOf(" ")
    const key = separator === -1 ? field : field.slice(0, separator)
    const value = separator === -1 ? true : field.slice(separator + 1)
    if (key === "worktree") current = { path: value, branch: null, head: null, bare: false, detached: false, locked: false }
    else if (!current) throw new CliError("Git returned an invalid worktree record")
    else if (key === "HEAD") current.head = value
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "")
    else if (key === "bare") current.bare = true
    else if (key === "detached") current.detached = true
    else if (key === "locked") current.locked = value === true ? true : value
    else if (key === "prunable") current.prunable = value === true ? true : value
  }

  if (current) worktrees.push(current)
  return worktrees
}

function discoverRepository(cwd = process.cwd()) {
  const raw = git(["worktree", "list", "--porcelain", "-z"], cwd).stdout
  const worktrees = parseWorktrees(raw)
  if (worktrees.length === 0) throw new CliError("No Git worktrees found")

  const primary = worktrees[0]
  const commonDir = resolve(cwd, gitOutput(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd))
  const primaryPath = canonical(primary.path)
  return { commonDir, primary: { ...primary, path: primaryPath }, primaryPath, worktrees }
}

function validateRelativePath(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new CliError(`${field} must be a non-empty string`)
  if (isAbsolute(value)) throw new CliError(`${field} must be a relative path`)
  const normalized = value.split(/[\\/]+/)
  if (normalized.some((part) => part === "..")) throw new CliError(`${field} cannot contain '..'`)
  return value
}

function validateConfig(parsed, label) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CliError(`${label} must contain an object`)
  const allowed = new Set(["base", "worktreeDirectory", "copyFiles", "ports", "env", "postCreate", "preRemove"])
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new CliError(`${label} contains an unknown field: ${key}`)
  }

  if (parsed.base !== undefined && (typeof parsed.base !== "string" || parsed.base.length === 0)) {
    throw new CliError("base must be a non-empty string")
  }

  let worktreeDirectory
  if (parsed.worktreeDirectory !== undefined) {
    worktreeDirectory = validateRelativePath(parsed.worktreeDirectory, "worktreeDirectory")
    if (worktreeDirectory.split(/[\\/]+/).some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
      throw new CliError("worktreeDirectory can only contain letters, digits, '.', '_', '-', and path separators")
    }
  }
  if (!Array.isArray(parsed.copyFiles ?? [])) throw new CliError("copyFiles must be an array")
  const copyFiles = (parsed.copyFiles ?? []).map((path, index) => validateRelativePath(path, `copyFiles[${index}]`))
  if (new Set(copyFiles).size !== copyFiles.length) throw new CliError("copyFiles cannot contain duplicates")

  if (!Array.isArray(parsed.ports ?? [])) throw new CliError("ports must be an array")
  const ports = (parsed.ports ?? []).map((name, index) => {
    if (typeof name !== "string" || !ENV_NAME.test(name)) throw new CliError(`ports[${index}] is not a valid environment variable name`)
    if (name.startsWith("GWT_")) throw new CliError(`ports[${index}] cannot use the reserved GWT_ prefix`)
    return name
  })
  if (new Set(ports).size !== ports.length) throw new CliError("ports cannot contain duplicates")
  if (ports.length > 100) throw new CliError("ports cannot contain more than 100 entries")

  if (!parsed.env || typeof parsed.env !== "object" || Array.isArray(parsed.env)) {
    if (parsed.env !== undefined) throw new CliError("env must be an object")
  }
  const envEntries = Object.entries(parsed.env ?? {})
  if (envEntries.length > 100) throw new CliError("env cannot contain more than 100 entries")
  const env = Object.fromEntries(envEntries.map(([name, value]) => {
    if (!ENV_NAME.test(name)) throw new CliError(`env.${name} is not a valid environment variable name`)
    if (name.startsWith("GWT_")) throw new CliError(`env.${name} cannot use the reserved GWT_ prefix`)
    if (ports.includes(name)) throw new CliError(`env.${name} conflicts with a configured port`)
    if (typeof value !== "string") throw new CliError(`env.${name} must be a string`)

    const remainder = value.replace(/\$\{([^}]*)\}/g, (_, reference) => {
      if (!ENV_NAME.test(reference) || !ports.includes(reference)) {
        throw new CliError(`env.${name} references unknown port ${reference || "(empty)"}`)
      }
      return ""
    })
    if (remainder.includes("${")) throw new CliError(`env.${name} contains an invalid port reference`)
    return [name, value]
  }))

  for (const hook of ["postCreate", "preRemove"]) {
    if (parsed[hook] !== undefined) validateRelativePath(parsed[hook], hook)
  }

  const config = {
    ...parsed,
    copyFiles,
    ports,
    env,
  }
  if (worktreeDirectory !== undefined) config.worktreeDirectory = worktreeDirectory
  return config
}

function resolveConfiguredEnv(config, ports) {
  return Object.fromEntries(Object.entries(config.env).map(([name, template]) => [
    name,
    template.replace(/\$\{([^}]*)\}/g, (_, reference) => {
      if (!Object.hasOwn(ports, reference)) {
        throw new CliError(`Cannot resolve env.${name}: this worktree has no assigned ${reference}`)
      }
      return String(ports[reference])
    }),
  ]))
}

function configHome() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
}

function gwtHome() {
  const path = process.env.GWT_HOME || join(homedir(), ".gwt")
  if (!isAbsolute(path)) throw new CliError("GWT_HOME must be an absolute path")
  return path
}

function repositoryUsesDirectory(repository, directory) {
  const resolvedDirectory = pathExists(directory) ? canonical(directory) : resolve(directory)
  return repository.worktrees.some((worktree) => {
    if (!pathExists(worktree.path)) return false
    const worktreePath = canonical(worktree.path)
    return worktreePath !== repository.primaryPath && dirname(worktreePath) === resolvedDirectory
  })
}

function directoryIsEmpty(path) {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length === 0
  } catch {
    return false
  }
}

function defaultWorktreeDirectory(repository) {
  const root = join(gwtHome(), "worktrees")
  const name = basename(repository.primaryPath)
  const namedDirectory = join(root, name)
  const digest = createHash("sha256").update(repository.primaryPath).digest("hex").slice(0, 8)
  const disambiguatedDirectory = join(root, `${name}-${digest}`)

  if (repositoryUsesDirectory(repository, disambiguatedDirectory)) return disambiguatedDirectory
  if (repositoryUsesDirectory(repository, namedDirectory)) return namedDirectory
  if (!pathExists(namedDirectory) || directoryIsEmpty(namedDirectory)) return namedDirectory
  return disambiguatedDirectory
}

function resolveWorktreeDirectory(repository, config) {
  return config.worktreeDirectory
    ? resolve(repository.primaryPath, config.worktreeDirectory)
    : defaultWorktreeDirectory(repository)
}

function userConfigPath() {
  return join(configHome(), "gwt", "config.json")
}

function projectConfigPath(repository) {
  return join(repository.primaryPath, PROJECT_CONFIG_FILE)
}

function projectIdentifier(repository) {
  const remotes = git(["remote"], repository.primaryPath).stdout.trim().split("\n").filter(Boolean)
  const remote = remotes.includes("origin") ? "origin" : remotes[0]
  if (!remote) return repository.primaryPath

  const url = gitOutput(["remote", "get-url", remote], repository.primaryPath)
  const scp = url.includes("://") ? null : url.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`

  try {
    const parsed = new URL(url)
    if (parsed.host && parsed.pathname) {
      return `${parsed.host.toLowerCase()}/${parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`
    }
  } catch {}

  return repository.primaryPath
}

function readUserConfig() {
  const path = userConfigPath()
  if (!existsSync(path)) return { path, raw: "", value: { projects: {} } }
  const raw = readFileSync(path, "utf8")
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new CliError(`${path} is not valid JSON: ${error.message}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError(`${path} must contain an object`)
  for (const key of Object.keys(value)) {
    if (key !== "projects") throw new CliError(`${path} contains an unknown field: ${key}`)
  }
  if (value.projects !== undefined && (!value.projects || typeof value.projects !== "object" || Array.isArray(value.projects))) {
    throw new CliError(`${path} projects must contain an object`)
  }
  return { path, raw, value: { ...value, projects: value.projects ?? {} } }
}

function loadConfig(repository) {
  const projectPath = projectConfigPath(repository)
  if (existsSync(projectPath)) {
    const raw = readFileSync(projectPath, "utf8")
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new CliError(`${PROJECT_CONFIG_FILE} is not valid JSON: ${error.message}`)
    }
    return {
      source: "project",
      requiresTrust: true,
      raw,
      path: projectPath,
      value: validateConfig(parsed, PROJECT_CONFIG_FILE),
    }
  }

  const user = readUserConfig()
  const identifier = projectIdentifier(repository)
  if (Object.hasOwn(user.value.projects, identifier)) {
    const parsed = user.value.projects[identifier]
    return {
      source: "user",
      requiresTrust: false,
      raw: `${JSON.stringify(parsed)}\n`,
      path: user.path,
      identifier,
      value: validateConfig(parsed, `projects[${JSON.stringify(identifier)}]`),
    }
  }

  return {
    source: "default",
    requiresTrust: false,
    raw: "",
    path: null,
    identifier,
    value: { ...DEFAULT_CONFIG },
  }
}

function metadataDirectory(repository) {
  return join(repository.commonDir, "gwt", "worktrees")
}

function metadataPath(repository, id) {
  return join(metadataDirectory(repository), `${id}.json`)
}

function setupLogPath(repository, id) {
  return join(repository.commonDir, "gwt", "logs", `${id}.log`)
}

function jobStatus(metadata) {
  if (metadata?.setup !== "running") return metadata?.setup
  const pid = metadata.job?.pid
  if (!pid) {
    const startedAt = Date.parse(metadata.job?.startedAt ?? "")
    return Number.isNaN(startedAt) || Date.now() - startedAt < JOB_START_GRACE_MS ? "running" : "interrupted"
  }
  try {
    process.kill(pid, 0)
    return "running"
  } catch (error) {
    return error.code === "EPERM" ? "running" : "interrupted"
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new CliError(`Cannot read ${path}: ${error.message}`)
  }
}

function writeJson(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(temporaryPath, path)
}

function loadMetadata(repository) {
  const directory = metadataDirectory(repository)
  if (!existsSync(directory)) return []

  const paths = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name))

  return paths.map((path) => ({ ...readJson(path), metadataPath: path }))
}

function metadataForWorktree(repository, worktree) {
  const resolvedPath = resolve(worktree.path)
  return loadMetadata(repository).find((metadata) => resolve(metadata.path) === resolvedPath) ?? null
}

function currentWorktree(repository, cwd = process.cwd()) {
  const resolvedCwd = canonical(cwd)
  return repository.worktrees
    .filter((worktree) => pathExists(worktree.path) && isInside(canonical(worktree.path), resolvedCwd))
    .sort((left, right) => right.path.length - left.path.length)[0] ?? null
}

function findWorktree(repository, selector, options = {}) {
  if (!selector) {
    const current = currentWorktree(repository)
    if (!current) throw new CliError("The current directory is not inside a registered worktree")
    return current
  }

  if (selector === "primary") return repository.primary

  const metadata = loadMetadata(repository)
  const idMatch = metadata.find((item) => item.id === selector)
  if (idMatch) {
    const match = repository.worktrees.find((worktree) => resolve(worktree.path) === resolve(idMatch.path))
    if (match) return match
    throw new CliError(`Worktree ${selector} is no longer registered with Git`)
  }

  const branchMatch = repository.worktrees.find((worktree) => worktree.branch === selector)
  if (branchMatch) return branchMatch

  const candidatePath = resolve(options.cwd ?? process.cwd(), selector)
  return repository.worktrees.find((worktree) => resolve(worktree.path) === candidatePath) ?? null
}

function resolveWorktree(repository, selector, options = {}) {
  const worktree = findWorktree(repository, selector, options)
  if (!worktree) throw new CliError(`No worktree matches '${selector}'`)
  return worktree
}

function generateId(repository, config) {
  const directory = resolveWorktreeDirectory(repository, config)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomBytes(4).toString("hex")
    const target = join(directory, id)
    if (!existsSync(metadataPath(repository, id)) && !pathExists(target)) return id
  }
  throw new CliError("Could not generate a unique worktree ID")
}

function portIsAvailable(port) {
  return new Promise((resolveAvailability, rejectAvailability) => {
    const server = createServer()
    server.unref()
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolveAvailability(false)
      else rejectAvailability(new CliError(`Cannot check port ${port}: ${error.message}`))
    })
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolveAvailability(true))
    })
  })
}

async function allocatePorts(repository, id, names) {
  if (names.length === 0) return {}
  const reserved = new Set(loadMetadata(repository).flatMap((metadata) => Object.values(metadata.ports ?? {})))
  const availableStarts = PORT_MAX - PORT_MIN - names.length + 2
  const digest = createHash("sha256").update(`${repository.primaryPath}\0${id}`).digest()
  const initial = PORT_MIN + (digest.readUInt32BE(0) % availableStarts)

  for (let offset = 0; offset < availableStarts; offset += 1) {
    const start = PORT_MIN + ((initial - PORT_MIN + offset) % availableStarts)
    const candidates = names.map((_, index) => start + index)
    if (candidates.some((port) => reserved.has(port))) continue
    const availability = await Promise.all(candidates.map(portIsAvailable))
    if (!availability.every(Boolean)) continue
    return Object.fromEntries(names.map((name, index) => [name, candidates[index]]))
  }

  throw new CliError(`No free port block is available in ${PORT_MIN}-${PORT_MAX}`)
}

function hookPaths(configDocument, worktreePath) {
  const config = configDocument.value
  const root = configDocument.source === "user"
    ? canonical(dirname(configDocument.path))
    : canonical(worktreePath)
  const location = configDocument.source === "user" ? "user config directory" : "worktree"

  return ["postCreate", "preRemove"]
    .filter((name) => config[name])
    .map((name) => {
      const configuredPath = resolve(root, config[name])
      if (!isInside(root, configuredPath)) throw new CliError(`${name} must be inside the ${location}`)
      if (!existsSync(configuredPath)) throw new CliError(`${name} does not exist: ${config[name]}`)
      const path = canonical(configuredPath)
      if (!isInside(root, path)) throw new CliError(`${name} must resolve inside the ${location}`)
      if (!statSync(path).isFile()) throw new CliError(`${name} must point to a file`)
      try {
        accessSync(path, constants.X_OK)
      } catch {
        throw new CliError(`${name} is not executable: ${config[name]}`)
      }
      return { name, configuredPath: config[name], path }
    })
}

function trustFingerprint(repository, configDocument, worktreePath) {
  const hooks = hookPaths(configDocument, worktreePath)
  if (hooks.length === 0 && configDocument.value.ports.length === 0 && Object.keys(configDocument.value.env).length === 0) return null
  const hash = createHash("sha256")
  hash.update(repository.primaryPath)
  hash.update("\0")
  hash.update(configDocument.raw)
  for (const hook of hooks) {
    hash.update("\0")
    hash.update(hook.name)
    hash.update("\0")
    hash.update(readFileSync(hook.path))
  }
  return hash.digest("hex")
}

function approvalsPath() {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(configHome, "gwt", "approvals.json")
}

function readApprovals() {
  const path = approvalsPath()
  return existsSync(path) ? readJson(path) : { version: 1, repositories: {} }
}

function approvalKey(repository) {
  return createHash("sha256").update(repository.primaryPath).digest("hex")
}

function isTrusted(repository, fingerprint) {
  if (!fingerprint) return true
  return readApprovals().repositories?.[approvalKey(repository)]?.fingerprint === fingerprint
}

function saveTrust(repository, fingerprint) {
  const path = approvalsPath()
  const approvals = readApprovals()
  approvals.version = 1
  approvals.repositories ??= {}
  approvals.repositories[approvalKey(repository)] = {
    path: repository.primaryPath,
    fingerprint,
    approvedAt: new Date().toISOString(),
  }
  writeJson(path, approvals)
}

function revokeTrust(repository) {
  const path = approvalsPath()
  const approvals = readApprovals()
  if (approvals.repositories) delete approvals.repositories[approvalKey(repository)]
  writeJson(path, approvals)
}

async function ask(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(question)
    return /^y(?:es)?$/i.test(answer.trim())
  } finally {
    prompt.close()
  }
}

async function ensureTrusted(repository, configDocument, worktreePath) {
  if (!configDocument.requiresTrust) return
  const fingerprint = trustFingerprint(repository, configDocument, worktreePath)
  if (!fingerprint || isTrusted(repository, fingerprint)) return

  const hooks = hookPaths(configDocument, worktreePath)
  console.error("This repository wants to configure your development environment:")
  for (const hook of hooks) console.error(`  ${hook.name}: ${hook.configuredPath}`)
  for (const name of configDocument.value.ports) console.error(`  port: ${name}`)
  for (const name of Object.keys(configDocument.value.env)) console.error(`  env: ${name}`)
  const allowed = await ask("Allow and remember? [y/N] ")
  if (!allowed) throw new CliError("Project configuration is not trusted. Run 'gwt trust' to approve it")
  saveTrust(repository, fingerprint)
}

function hookContext(repository, config, worktree, metadata) {
  const ports = metadata?.ports ?? {}
  return {
    id: metadata?.id ?? "",
    path: canonical(worktree.path),
    primaryPath: repository.primaryPath,
    branch: worktree.branch ?? "",
    ports,
    environment: resolveConfiguredEnv(config, ports),
  }
}

function runHook(name, repository, configDocument, worktree, metadata) {
  const configuredPath = configDocument.value[name]
  if (!configuredPath) return
  const hook = hookPaths(configDocument, canonical(worktree.path)).find((item) => item.name === name)
  const context = hookContext(repository, configDocument.value, worktree, metadata)
  const env = {
    ...process.env,
    GWT_ID: context.id,
    GWT_PATH: context.path,
    GWT_PRIMARY_PATH: context.primaryPath,
    GWT_BRANCH: context.branch,
    ...Object.fromEntries(Object.entries(context.ports).map(([key, value]) => [key, String(value)])),
    ...context.environment,
  }
  console.log(`Running ${name}...`)
  const result = run(hook.path, [], {
    cwd: context.path,
    env,
    input: `${JSON.stringify(context)}\n`,
    allowFailure: true,
    stdio: ["pipe", "inherit", "inherit"],
  })
  if (result.status !== 0) throw new CliError(`${name} failed with status ${result.status}`)
}

function copyConfiguredFiles(repository, config, targetPath) {
  for (const relativePath of config.copyFiles) {
    const source = resolve(repository.primaryPath, relativePath)
    const target = resolve(targetPath, relativePath)
    if (!isInside(repository.primaryPath, source) || !isInside(targetPath, target)) {
      throw new CliError(`copyFiles path escapes the repository: ${relativePath}`)
    }
    if (!existsSync(source)) throw new CliError(`Copy source does not exist: ${relativePath}`)
    if (!statSync(source).isFile()) throw new CliError(`Copy source is not a file: ${relativePath}`)
    if (existsSync(target)) continue
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    chmodSync(target, statSync(source).mode)
  }
}

function updateMetadata(repository, metadata, update) {
  const next = { ...metadata, ...update, updatedAt: new Date().toISOString() }
  writeJson(metadataPath(repository, next.id), next)
  return next
}

function startBackgroundHook(repository, metadata) {
  const path = setupLogPath(repository, metadata.id)
  mkdirSync(dirname(path), { recursive: true })

  const started = updateMetadata(repository, metadata, {
    setup: "running",
    setupError: undefined,
    job: { logPath: path, startedAt: new Date().toISOString() },
  })

  const descriptor = openSync(path, "w")
  const environment = { ...process.env }
  delete environment.GWT_CD_FILE
  try {
    const child = spawn(process.execPath, [import.meta.filename, "__run-hook", "postCreate", started.id], {
      cwd: repository.primaryPath,
      detached: true,
      env: environment,
      stdio: ["ignore", descriptor, descriptor],
    })
    child.unref()
  } finally {
    closeSync(descriptor)
  }
  return started
}

async function setupWorktree(repository, configDocument, worktree, options = {}) {
  if (resolve(worktree.path) === resolve(repository.primaryPath)) throw new CliError("The primary worktree does not need setup")
  const targetPath = canonical(worktree.path)
  ensureCopySources(repository, configDocument.value)
  let metadata = metadataForWorktree(repository, worktree)

  if (!metadata) {
    const id = options.id ?? generateId(repository, configDocument.value)
    metadata = {
      version: 1,
      id,
      path: targetPath,
      ports: await allocatePorts(repository, id, configDocument.value.ports),
      setup: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    if (options.scratchBranch) metadata.scratchBranch = options.scratchBranch
    writeJson(metadataPath(repository, id), metadata)
  }

  try {
    copyConfiguredFiles(repository, configDocument.value, targetPath)
    if (options.noHooks) {
      metadata = updateMetadata(repository, metadata, { setup: "incomplete" })
      return metadata
    }
    await ensureTrusted(repository, configDocument, targetPath)
    if (options.background && configDocument.value.postCreate) return startBackgroundHook(repository, metadata)
    runHook("postCreate", repository, configDocument, worktree, metadata)
    metadata = updateMetadata(repository, metadata, { setup: "complete", setupError: undefined, job: undefined })
    return metadata
  } catch (error) {
    updateMetadata(repository, metadata, { setup: "failed", setupError: error.message, job: undefined })
    throw error
  }
}

function ensureCopySources(repository, config) {
  for (const relativePath of config.copyFiles) {
    const source = resolve(repository.primaryPath, relativePath)
    if (!existsSync(source)) throw new CliError(`Copy source does not exist: ${relativePath}`)
    if (!statSync(source).isFile()) throw new CliError(`Copy source is not a file: ${relativePath}`)
    const ignored = git(["check-ignore", "--quiet", "--", relativePath], repository.primaryPath, { allowFailure: true }).status === 0
    if (!ignored) throw new CliError(`Copy source must be ignored by Git: ${relativePath}`)
  }
}

function ensureLocalExclude(repository, directory) {
  const infoExclude = join(repository.commonDir, "info", "exclude")
  const pattern = `/${directory.replaceAll("\\", "/").replace(/\/+$/, "")}/`
  mkdirSync(dirname(infoExclude), { recursive: true })
  const current = existsSync(infoExclude) ? readFileSync(infoExclude, "utf8") : ""
  if (current.split("\n").includes(pattern)) return
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : ""
  writeFileSync(infoExclude, `${current}${separator}${pattern}\n`)
}

function isBranchName(branch, cwd) {
  const result = git(["check-ref-format", "--branch", branch], cwd, { allowFailure: true })
  return result.status === 0 && result.stdout.trim() === branch
}

function validateBranchName(branch, cwd) {
  if (!isBranchName(branch, cwd)) throw new CliError(`Invalid branch name: ${branch}`)
}

function branchState(repository, branch) {
  const remoteNames = git(["remote"], repository.primaryPath).stdout.split("\n").filter(Boolean)
  const localRef = `refs/heads/${branch}`
  const remoteRefs = new Map(remoteNames.map((name) => [`refs/remotes/${name}/${branch}`, name]))
  const raw = git([
    "for-each-ref",
    "--format=%(refname)%09%(worktreepath)",
    localRef,
    ...remoteRefs.keys(),
  ], repository.primaryPath).stdout

  let local = null
  const remotes = []
  for (const line of raw.split("\n").filter(Boolean)) {
    const [refname, worktreePath = ""] = line.split("\t")
    if (refname === localRef) local = { branch, worktreePath: worktreePath || null }
    else if (remoteRefs.has(refname)) remotes.push(remoteRefs.get(refname))
  }
  return { local, remotes: [...new Set(remotes)].sort() }
}

function localBranch(repository, branch) {
  return branchState(repository, branch).local
}

function resolveBranchTarget(repository, branch, explicitBase) {
  validateBranchName(branch, repository.primaryPath)
  const { local, remotes } = branchState(repository, branch)

  if (local) {
    if (local.worktreePath) {
      throw new CliError(`Branch '${branch}' is already checked out at ${local.worktreePath}\nSwitch to it with: gwt switch ${branch}`)
    }
    if (explicitBase) {
      throw new CliError(`Branch '${branch}' already exists, so --base would be ignored\nDrop --base to create a worktree for the existing branch`)
    }
    return { origin: "existing", branch }
  }

  if (explicitBase) return { origin: "new", branch }

  if (remotes.length === 1) return { origin: "remote", branch, remoteRef: `${remotes[0]}/${branch}` }
  if (remotes.length > 1) {
    throw new CliError(`Branch '${branch}' exists on several remotes: ${remotes.join(", ")}\nChoose one with: gwt new ${branch} --base ${remotes[0]}/${branch}`)
  }
  return { origin: "new", branch }
}

function worktreeAddArguments(target, resolution, base) {
  if (resolution.origin === "existing") return ["worktree", "add", target, resolution.branch]
  if (resolution.origin === "remote") return ["worktree", "add", "--track", "-b", resolution.branch, target, resolution.remoteRef]
  return ["worktree", "add", "-b", resolution.branch, target, base]
}

function branchSummary(resolution) {
  if (resolution.origin === "existing") return `Branch: ${resolution.branch} (existing)`
  if (resolution.origin === "remote") return `Branch: ${resolution.branch} (new, tracking ${resolution.remoteRef})`
  return `Branch: ${resolution.branch}`
}

function writeCdDirective(path) {
  if (process.env.GWT_CD_FILE) writeFileSync(process.env.GWT_CD_FILE, path)
}

function parseOptions(args, definitions = {}) {
  const options = {}
  const positionals = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const definition = definitions[argument]
    if (!definition) {
      if (argument.startsWith("-")) throw new CliError(`Unknown option: ${argument}`)
      positionals.push(argument)
      continue
    }
    if (definition === "boolean") options[argument.slice(2)] = true
    else {
      index += 1
      if (index >= args.length) throw new CliError(`${argument} requires a value`)
      options[argument.slice(2)] = args[index]
    }
  }
  return { options, positionals }
}

async function createWorktree(repository, configDocument, options = {}) {
  ensureCopySources(repository, configDocument.value)
  const id = generateId(repository, configDocument.value)
  const scratch = !options.branch
  const branch = options.branch ?? `scratch/${id}`

  let resolution
  if (scratch) {
    validateBranchName(branch, repository.primaryPath)
    if (localBranch(repository, branch)) throw new CliError(`Branch already exists: ${branch}`)
    resolution = { origin: "new", branch }
  } else {
    resolution = resolveBranchTarget(repository, branch, options.base)
  }

  let base = null
  if (resolution.origin === "new") {
    const requestedBase = options.base ?? configDocument.value.base
    base = requestedBase
      ? gitOutput(["rev-parse", "--verify", `${requestedBase}^{commit}`], repository.primaryPath)
      : gitOutput(["rev-parse", "HEAD"], repository.primaryPath)
  }

  const target = join(resolveWorktreeDirectory(repository, configDocument.value), id)
  if (configDocument.value.worktreeDirectory) {
    ensureLocalExclude(repository, configDocument.value.worktreeDirectory)
  }

  git(worktreeAddArguments(target, resolution, base), repository.primaryPath, { stdio: "inherit" })
  const targetPath = canonical(target)
  const refreshed = discoverRepository(repository.primaryPath)
  const worktree = refreshed.worktrees.find((item) => resolve(item.path) === targetPath)

  try {
    const metadata = await setupWorktree(refreshed, configDocument, worktree, {
      id,
      noHooks: options.noHooks,
      background: options.background,
      scratchBranch: scratch ? branch : undefined,
    })
    return { metadata, targetPath, resolution }
  } catch (error) {
    console.error(`Setup failed; worktree retained at ${targetPath}`)
    console.error(`Retry: gwt setup ${id}`)
    console.error(`Remove: gwt remove ${id}`)
    throw error
  }
}

function reportWorktree({ metadata, targetPath, resolution }) {
  console.log(`Worktree ${metadata.id} is ready at ${targetPath}`)
  console.log(branchSummary(resolution))
  for (const [name, port] of Object.entries(metadata.ports)) console.log(`${name}: ${port}`)
  if (metadata.setup === "running") {
    console.log(`Setup is running in the background; log: ${metadata.job.logPath}`)
  }
  writeCdDirective(targetPath)
}

async function commandNew(args) {
  const { options, positionals } = parseOptions(args, {
    "--base": "value",
    "--no-hooks": "boolean",
    "--background": "boolean",
  })
  if (positionals.length > 1) throw new CliError("Usage: gwt new [branch] [--base <ref>] [--no-hooks] [--background]")
  if (options.background && options["no-hooks"]) throw new CliError("--background and --no-hooks cannot be combined")
  const repository = discoverRepository()
  const configDocument = loadConfig(repository)

  reportWorktree(await createWorktree(repository, configDocument, {
    branch: positionals[0],
    base: options.base,
    noHooks: options["no-hooks"],
    background: options.background,
  }))
}

function linkedWorktreeRows(repository, metadata = loadMetadata(repository)) {
  const current = currentWorktree(repository)
  return repository.worktrees.map((worktree, index) => {
    const item = metadata.find((entry) => resolve(entry.path) === resolve(worktree.path))
    return {
      worktree,
      current: current && resolve(current.path) === resolve(worktree.path),
      id: item?.id ?? (index === 0 ? "primary" : "-"),
      branch: worktree.branch ?? "(detached)",
      setup: jobStatus(item) ?? (index === 0 ? "-" : "unmanaged"),
      path: worktree.path,
    }
  })
}

function terminalColors() {
  if (!process.stdout.isTTY || process.env.NO_COLOR !== undefined) {
    return { cyan: "", yellow: "", dim: "", reset: "" }
  }
  return { cyan: "\x1b[36m", yellow: "\x1b[33m", dim: "\x1b[2m", reset: "\x1b[0m" }
}

async function chooseWorktree(repository) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError("A worktree selector is required in non-interactive mode")
  const choices = linkedWorktreeRows(repository).map((row) => {
    const { worktree } = row
    const relativePath = relative(repository.primaryPath, worktree.path)
    return {
      ...row,
      path: relativePath === "" ? "." : relativePath.startsWith(`..${sep}`) ? worktree.path : relativePath,
    }
  })

  return new Promise((resolveChoice, rejectChoice) => {
    let query = ""
    let filtering = false
    const initialSelected = Math.max(0, choices.findIndex((choice) => choice.current))
    let selected = initialSelected
    let renderedLines = 0
    const wasRaw = process.stdin.isRaw
    const colors = terminalColors()

    const clear = () => {
      if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}A\r\x1b[J`)
      renderedLines = 0
    }

    const render = () => {
      const normalizedQuery = query.toLowerCase()
      const filtered = choices.filter((choice) => [choice.branch, choice.id, choice.path]
        .some((value) => value.toLowerCase().includes(normalizedQuery)))
      if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1)

      const terminalWidth = Math.max(48, process.stdout.columns ?? 100)
      const idWidth = 8
      const setupWidth = Math.max(5, ...filtered.map((choice) => displayWidth(choice.setup)))
      const longestBranch = Math.max(12, ...filtered.map((choice) => displayWidth(choice.branch)))
      const flexibleWidth = terminalWidth - idWidth - setupWidth - 10
      const branchWidth = Math.min(32, longestBranch, Math.max(8, flexibleWidth - 8))
      const pathWidth = Math.max(8, flexibleWidth - branchWidth)
      const visibleCount = Math.max(3, (process.stdout.rows ?? 24) - 5)
      const start = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), filtered.length - visibleCount))
      const visible = filtered.slice(start, start + visibleCount)
      const escapeAction = filtering ? "clear" : "cancel"
      const lines = [
        `${colors.dim}${fitDisplay(`Switch worktree  Esc ${escapeAction} · Enter select · ↑↓/jk/C-n/C-p · / filter`, terminalWidth)}${colors.reset}`,
        ...(filtering ? [fitDisplay(`Filter: /${query}`, terminalWidth)] : []),
        `${colors.dim}    ${fitDisplay("BRANCH", branchWidth)}  ${fitDisplay("ID", idWidth)}  ${fitDisplay("SETUP", setupWidth)}  ${fitDisplay("PATH", pathWidth)}${colors.reset}`,
      ]

      if (visible.length === 0) {
        lines.push(`${colors.dim}  No matching worktrees${colors.reset}`)
      } else {
        visible.forEach((choice, visibleIndex) => {
          const index = start + visibleIndex
          const selection = index === selected ? `${colors.cyan}>${colors.reset}` : " "
          const currentMarker = choice.current ? `${colors.yellow}*${colors.reset}` : " "
          lines.push(`${selection} ${currentMarker} ${fitDisplay(choice.branch, branchWidth)}  ${fitDisplay(choice.id, idWidth)}  ${fitDisplay(choice.setup, setupWidth)}  ${fitDisplay(choice.path, pathWidth)}`)
        })
      }

      clear()
      process.stdout.write(`${lines.join("\n")}\n`)
      renderedLines = lines.length
      return filtered
    }

    const finish = (error, choice) => {
      process.stdin.off("keypress", onKeypress)
      process.stdout.off("resize", render)
      if (!wasRaw) process.stdin.setRawMode(false)
      process.stdin.pause()
      clear()
      process.stdout.write("\x1b[?25h")
      if (error) rejectChoice(error)
      else resolveChoice(choice.worktree)
    }

    const onKeypress = (text, key) => {
      const filtered = choices.filter((choice) => [choice.branch, choice.id, choice.path]
        .some((value) => value.toLowerCase().includes(query.toLowerCase())))

      if (key.ctrl && key.name === "c") {
        finish(new CliError("Selection cancelled"))
        return
      }
      if (key.name === "escape") {
        if (filtering) {
          const selectedChoice = filtered[selected]
          filtering = false
          query = ""
          selected = selectedChoice ? choices.indexOf(selectedChoice) : initialSelected
          render()
        } else {
          finish(new CliError("Selection cancelled"))
        }
        return
      }

      const moveUp = key.name === "up" || (key.ctrl && key.name === "p") || (!filtering && key.name === "k")
      const moveDown = key.name === "down" || (key.ctrl && key.name === "n") || (!filtering && key.name === "j")
      if (moveUp && filtered.length > 0) selected = (selected - 1 + filtered.length) % filtered.length
      else if (moveDown && filtered.length > 0) selected = (selected + 1) % filtered.length
      else if (key.name === "return") {
        if (filtered[selected]) finish(null, filtered[selected])
        else process.stdout.write("\x07")
        return
      } else if (!filtering && text === "/") {
        filtering = true
      } else if (filtering && key.name === "backspace") {
        query = [...query].slice(0, -1).join("")
        selected = 0
      } else if (filtering && text && !key.ctrl && !key.meta) {
        query += text.replace(/[\x00-\x1f\x7f]/g, "")
        selected = 0
      }
      render()
    }

    emitKeypressEvents(process.stdin, { escapeCodeTimeout: PICKER_ESCAPE_CODE_TIMEOUT_MS })
    process.stdin.on("keypress", onKeypress)
    process.stdout.on("resize", render)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.write("\x1b[?25l")
    render()
  })
}

function looksLikePath(selector) {
  return isAbsolute(selector) || selector.startsWith(".")
}

async function createMissingWorktree(repository, selector, force) {
  const unmatched = new CliError(`No worktree matches '${selector}'`)
  if (looksLikePath(selector) || !isBranchName(selector, repository.primaryPath)) throw unmatched

  const resolution = resolveBranchTarget(repository, selector, undefined)
  if (!force) {
    const question = resolution.origin === "new"
      ? `Branch '${selector}' does not exist. Create it and a worktree? [y/N] `
      : `No worktree for branch '${selector}'. Create one? [y/N] `
    if (!(await ask(question))) {
      throw new CliError(`No worktree matches '${selector}'\nCreate one with: gwt new ${selector}`)
    }
  }

  return createWorktree(repository, loadConfig(repository), { branch: selector })
}

async function commandSwitch(args) {
  const { options, positionals } = parseOptions(args, { "--create": "boolean" })
  if (positionals.length > 1) throw new CliError("Usage: gwt switch [primary|id|branch|path] [--create]")
  const repository = discoverRepository()
  const selector = positionals[0]
  if (!selector && options.create) throw new CliError("--create requires a branch name")

  const worktree = selector ? findWorktree(repository, selector) : await chooseWorktree(repository)
  if (!worktree) {
    reportWorktree(await createMissingWorktree(repository, selector, options.create))
    return
  }

  writeCdDirective(canonical(worktree.path))
  console.log(canonical(worktree.path))
}

function worktreeRows(repository) {
  const metadata = loadMetadata(repository)
  const rows = linkedWorktreeRows(repository, metadata)
  const registeredPaths = new Set(repository.worktrees.map((worktree) => resolve(worktree.path)))
  for (const item of metadata.filter((entry) => !registeredPaths.has(resolve(entry.path)))) {
    rows.push({ current: false, id: item.id, branch: "-", setup: "stale", path: item.path })
  }
  return rows
}

function displayWidth(value) {
  let width = 0
  for (const character of value.normalize("NFC")) {
    const codePoint = character.codePointAt(0)
    if (/\p{Mark}/u.test(character) || codePoint === 0x200d) continue
    const fullWidth = codePoint >= 0x1100 && (
      codePoint <= 0x115f
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
    width += fullWidth ? 2 : 1
  }
  return width
}

function padDisplay(value, width) {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`
}

function fitDisplay(value, width) {
  const normalized = value.normalize("NFC")
  if (displayWidth(normalized) <= width) return padDisplay(normalized, width)

  const contentWidth = width - displayWidth("…")
  let fitted = ""
  let fittedWidth = 0
  for (const character of normalized) {
    const characterWidth = displayWidth(character)
    if (fittedWidth + characterWidth > contentWidth) break
    fitted += character
    fittedWidth += characterWidth
  }
  return padDisplay(`${fitted}…`, width)
}

function truncateDisplayTail(value, width) {
  const normalized = value.normalize("NFC")
  if (displayWidth(normalized) <= width) return normalized

  const contentWidth = width - displayWidth("…")
  let fitted = ""
  let fittedWidth = 0
  for (const character of [...normalized].reverse()) {
    const characterWidth = displayWidth(character)
    if (fittedWidth + characterWidth > contentWidth) break
    fitted = `${character}${fitted}`
    fittedWidth += characterWidth
  }
  return `…${fitted}`
}

function commandList(args) {
  if (args.length > 0) throw new CliError("Usage: gwt list")
  const repository = discoverRepository()
  const rows = worktreeRows(repository)
  const colors = terminalColors()
  const widths = {
    branch: Math.max(6, ...rows.map((row) => displayWidth(row.branch))),
    id: Math.max(2, ...rows.map((row) => displayWidth(row.id))),
    setup: Math.max(5, ...rows.map((row) => displayWidth(row.setup))),
  }
  let pathWidth = null
  if (process.stdout.isTTY) {
    const minimumWidth = 8 + 6 + widths.id + widths.setup + 4
    const terminalWidth = Math.max(minimumWidth, process.stdout.columns || 100)
    const flexibleWidth = terminalWidth - widths.id - widths.setup - 8
    widths.branch = Math.min(32, widths.branch, Math.max(6, flexibleWidth - 12))
    pathWidth = flexibleWidth - widths.branch
  }

  console.log(`${colors.dim}  ${fitDisplay("BRANCH", widths.branch)}  ${fitDisplay("ID", widths.id)}  ${fitDisplay("SETUP", widths.setup)}  PATH${colors.reset}`)
  for (const row of rows) {
    const currentMarker = row.current ? `${colors.yellow}*${colors.reset}` : " "
    const path = pathWidth === null ? row.path : truncateDisplayTail(row.path, pathWidth)
    console.log(`${currentMarker} ${fitDisplay(row.branch, widths.branch)}  ${fitDisplay(row.id, widths.id)}  ${fitDisplay(row.setup, widths.setup)}  ${path}`)
  }
}

function commandInfo(args) {
  if (args.length > 1) throw new CliError("Usage: gwt info [primary|id|branch|path]")
  const repository = discoverRepository()
  const worktree = resolveWorktree(repository, args[0])
  const metadata = metadataForWorktree(repository, worktree)
  console.log(`ID: ${metadata?.id ?? (resolve(worktree.path) === resolve(repository.primaryPath) ? "primary" : "unmanaged")}`)
  console.log(`Path: ${pathExists(worktree.path) ? canonical(worktree.path) : resolve(worktree.path)}`)
  console.log(`Branch: ${worktree.branch ?? "(detached)"}`)
  console.log(`HEAD: ${worktree.head}`)
  console.log(`Setup: ${jobStatus(metadata) ?? "unmanaged"}`)
  for (const [name, port] of Object.entries(metadata?.ports ?? {})) console.log(`${name}: ${port}`)
  if (metadata?.setupError) console.log(`Setup error: ${metadata.setupError}`)
}

async function commandSetup(args) {
  const { options, positionals } = parseOptions(args, { "--no-hooks": "boolean", "--background": "boolean" })
  if (positionals.length > 1) throw new CliError("Usage: gwt setup [id|branch|path] [--no-hooks] [--background]")
  if (options.background && options["no-hooks"]) throw new CliError("--background and --no-hooks cannot be combined")
  const repository = discoverRepository()
  const configDocument = loadConfig(repository)
  const worktree = resolveWorktree(repository, positionals[0])

  const existing = metadataForWorktree(repository, worktree)
  if (jobStatus(existing) === "running") {
    throw new CliError(`Setup is already running for ${existing.id} (pid ${existing.job?.pid ?? "starting"})`)
  }

  const metadata = await setupWorktree(repository, configDocument, worktree, {
    noHooks: options["no-hooks"],
    background: options.background,
  })
  console.log(`Setup ${metadata.setup}: ${metadata.id}`)
  for (const [name, port] of Object.entries(metadata.ports)) console.log(`${name}: ${port}`)
  if (metadata.setup === "running") console.log(`Log: ${metadata.job.logPath}`)
}

async function confirmDiscard(worktree) {
  console.error(`Discard all changes and delete branch '${worktree.branch ?? "(detached)"}'?`)
  return ask("Type yes to continue [y/N] ")
}

function scratchBranchIsContained(repository, metadata, worktree) {
  const scratch = metadata?.scratchBranch
  if (!scratch || scratch === worktree.branch || !worktree.head) return false
  return git(["merge-base", "--is-ancestor", scratch, worktree.head], repository.primaryPath, { allowFailure: true }).status === 0
}

async function removeScratchBranch(repository, metadata, worktree, options, contained) {
  const scratch = metadata?.scratchBranch
  if (!scratch || scratch === worktree.branch || options["keep-branch"]) return null
  if (!localBranch(repository, scratch)) return null

  const deleteArgs = ["branch", options.discard || contained ? "-D" : "-d", "--", scratch]
  if (git(deleteArgs, repository.primaryPath, { allowFailure: true }).status === 0) {
    return `Deleted scratch branch: ${scratch}`
  }
  if (!options.discard && !options.yes) {
    console.log(`Scratch branch '${scratch}' could not be deleted safely.`)
    if (await ask("Force-delete the scratch branch? [y/N] ")) {
      git(["branch", "-D", "--", scratch], repository.primaryPath)
      return `Deleted scratch branch: ${scratch}`
    }
  }
  return `Kept scratch branch: ${scratch}\nDelete later: git branch -D -- ${scratch}`
}

async function commandRemove(args) {
  const { options, positionals } = parseOptions(args, {
    "--keep-branch": "boolean",
    "--discard": "boolean",
    "--yes": "boolean",
    "--no-hooks": "boolean",
  })
  if (positionals.length > 1) throw new CliError("Usage: gwt remove [id|branch|path] [--keep-branch|--discard] [--yes] [--no-hooks]")
  if (options["keep-branch"] && options.discard) throw new CliError("--keep-branch and --discard cannot be combined")
  const repository = discoverRepository()
  const worktree = resolveWorktree(repository, positionals[0])
  if (resolve(worktree.path) === resolve(repository.primaryPath)) throw new CliError("The primary worktree cannot be removed")
  const targetPath = canonical(worktree.path)
  const metadata = metadataForWorktree(repository, worktree)
  if (jobStatus(metadata) === "running" && !options.discard) {
    throw new CliError(`Setup is still running for ${metadata.id} (pid ${metadata.job?.pid ?? "starting"})\nWait for it to finish, or force removal with --discard`)
  }
  const scratchContained = scratchBranchIsContained(repository, metadata, worktree)
  const dirty = git(["status", "--porcelain"], worktree.path).stdout.length > 0
  if (dirty && !options.discard) throw new CliError("Worktree has uncommitted changes; commit them or use --discard")
  if (options.discard && !options.yes && !(await confirmDiscard(worktree))) throw new CliError("Removal cancelled")
  const wasCurrent = currentWorktree(repository)?.path === worktree.path

  if (!options["no-hooks"]) {
    const configDocument = loadConfig(repository)
    if (configDocument.value.preRemove) {
      await ensureTrusted(repository, configDocument, targetPath)
      runHook("preRemove", repository, configDocument, worktree, metadata)
    }
  }

  const removeArgs = ["worktree", "remove"]
  if (options.discard) removeArgs.push("--force")
  removeArgs.push(targetPath)
  console.log(`Removing worktree ${metadata?.id ?? targetPath}...`)
  git(removeArgs, repository.primaryPath)
  if (metadata?.metadataPath && existsSync(metadata.metadataPath)) unlinkSync(metadata.metadataPath)
  if (metadata?.id) {
    const log = setupLogPath(repository, metadata.id)
    if (existsSync(log)) unlinkSync(log)
  }

  let branchMessage = "No branch to delete"
  if (worktree.branch && !options["keep-branch"]) {
    const deleteArgs = ["branch", options.discard ? "-D" : "-d", "--", worktree.branch]
    const result = git(deleteArgs, repository.primaryPath, { allowFailure: true })
    if (result.status === 0) {
      branchMessage = `Deleted branch: ${worktree.branch}`
    } else if (!options.discard) {
      console.log(`Branch '${worktree.branch}' could not be deleted safely.`)
      const forceDelete = await ask("Force-delete the branch? [y/N] ")
      if (forceDelete) {
        git(["branch", "-D", "--", worktree.branch], repository.primaryPath)
        branchMessage = `Deleted branch: ${worktree.branch}`
      } else {
        branchMessage = `Kept branch: ${worktree.branch}\nDelete later: git branch -D -- ${worktree.branch}`
      }
    } else {
      branchMessage = `Kept branch: ${worktree.branch}`
    }
  } else if (worktree.branch) branchMessage = `Kept branch: ${worktree.branch}`

  console.log(`Removed worktree: ${metadata?.id ?? targetPath}`)
  console.log(branchMessage)
  const scratchMessage = await removeScratchBranch(repository, metadata, worktree, options, scratchContained)
  if (scratchMessage) console.log(scratchMessage)
  if (wasCurrent) writeCdDirective(repository.primaryPath)
}

function branchContainedElsewhere(repository, branch) {
  const result = git([
    "for-each-ref",
    "--format=%(refname:short)",
    "--contains",
    `refs/heads/${branch}`,
    "refs/heads",
    "refs/remotes",
  ], repository.primaryPath, { allowFailure: true })
  if (result.status !== 0) return []
  return result.stdout.split("\n").filter(Boolean).filter((reference) => reference !== branch)
}

function pruneCandidates(repository) {
  const metadata = loadMetadata(repository)
  const prunable = repository.worktrees.filter((worktree) => worktree.prunable)
  const live = new Set(repository.worktrees
    .filter((worktree) => !worktree.prunable)
    .map((worktree) => resolve(worktree.path)))

  const stale = []
  const running = []
  for (const item of metadata) {
    if (live.has(resolve(item.path))) continue
    if (jobStatus(item) === "running") running.push(item)
    else stale.push(item)
  }

  const branches = stale
    .filter((item) => item.scratchBranch && localBranch(repository, item.scratchBranch))
    .map((item) => ({ branch: item.scratchBranch, containedIn: branchContainedElsewhere(repository, item.scratchBranch) }))

  const retained = new Set(metadata.filter((item) => !stale.includes(item)).map((item) => item.id))
  const directory = join(repository.commonDir, "gwt", "logs")
  const logs = existsSync(directory)
    ? readdirSync(directory)
      .filter((name) => name.endsWith(".log") && !retained.has(basename(name, ".log")))
      .map((name) => join(directory, name))
    : []

  return { prunable, stale, running, branches, logs }
}

async function commandPrune(args) {
  const { options, positionals } = parseOptions(args, { "--dry-run": "boolean", "--yes": "boolean" })
  if (positionals.length > 0) throw new CliError("Usage: gwt prune [--dry-run] [--yes]")
  const repository = discoverRepository()
  const { prunable, stale, running, branches, logs } = pruneCandidates(repository)
  const removable = branches.filter((item) => item.containedIn.length > 0)
  const retained = branches.filter((item) => item.containedIn.length === 0)
  const total = prunable.length + stale.length + removable.length + logs.length

  for (const item of retained) {
    console.log(`Keeping scratch branch ${item.branch}: no other branch contains its commits`)
  }
  for (const item of running) console.log(`Keeping metadata ${item.id}: setup is still running`)
  if (total === 0) {
    console.log("Nothing to prune")
    return
  }

  for (const worktree of prunable) console.log(`Worktree registration: ${worktree.path}`)
  for (const item of stale) console.log(`Metadata: ${item.id}`)
  for (const item of removable) console.log(`Scratch branch: ${item.branch} (contained in ${item.containedIn[0]})`)
  for (const path of logs) console.log(`Setup log: ${basename(path)}`)

  if (options["dry-run"]) return
  if (!options.yes && !(await ask("Prune? [y/N] "))) throw new CliError("Prune cancelled")

  if (prunable.length > 0) git(["worktree", "prune"], repository.primaryPath)
  for (const item of stale) if (existsSync(item.metadataPath)) unlinkSync(item.metadataPath)
  for (const item of removable) git(["branch", "-D", "--", item.branch], repository.primaryPath)
  for (const path of logs) if (existsSync(path)) unlinkSync(path)
  console.log(`Pruned ${total} item${total === 1 ? "" : "s"}`)
}

function commandTrust(args) {
  const { options, positionals } = parseOptions(args, { "--revoke": "boolean" })
  if (positionals.length > 0) throw new CliError("Usage: gwt trust [--revoke]")
  const repository = discoverRepository()
  if (options.revoke) {
    revokeTrust(repository)
    console.log(`Revoked trust for ${repository.primaryPath}`)
    return
  }
  const current = currentWorktree(repository)
  const configDocument = loadConfig(repository)
  if (!configDocument.requiresTrust) {
    console.log(configDocument.source === "user"
      ? "User configuration is trusted automatically"
      : "This repository has no project config to approve")
    return
  }
  const fingerprint = trustFingerprint(repository, configDocument, canonical(current.path))
  if (!fingerprint) {
    console.log("This repository has no project configuration that requires approval")
    return
  }
  saveTrust(repository, fingerprint)
  console.log(`Trusted project configuration for ${repository.primaryPath}`)
}

function configScaffold() {
  return { copyFiles: [], ports: [], env: {} }
}

function commandConfigCreate(args) {
  const { options, positionals } = parseOptions(args, { "--project": "boolean" })
  if (positionals.length > 0) throw new CliError("Usage: gwt config create [--project]")
  const repository = discoverRepository()

  if (options.project) {
    const path = projectConfigPath(repository)
    if (existsSync(path)) throw new CliError(`Project config already exists: ${path}`)
    const active = loadConfig(repository)
    const value = active.source === "user" ? { ...active.value } : configScaffold()
    const skippedHooks = ["postCreate", "preRemove"].filter((name) => value[name])
    for (const hook of skippedHooks) delete value[hook]
    writeJson(path, value, 0o644)
    console.log(`Created project config: ${path}`)
    if (skippedHooks.length > 0) {
      console.log(`Skipped user hooks: ${skippedHooks.join(", ")}. Add repository-relative hook paths explicitly.`)
    }
    return
  }

  const user = readUserConfig()
  const identifier = projectIdentifier(repository)
  if (Object.hasOwn(user.value.projects, identifier)) {
    throw new CliError(`User config already contains project: ${identifier}`)
  }
  user.value.projects[identifier] = configScaffold()
  writeJson(user.path, user.value)
  console.log(`Created user config for ${identifier}: ${user.path}`)
}

function commandConfigShow(args) {
  if (args.length > 0) throw new CliError("Usage: gwt config show")
  const repository = discoverRepository()
  const identifier = projectIdentifier(repository)
  const user = readUserConfig()
  const projectPath = projectConfigPath(repository)
  const active = loadConfig(repository)
  const userFileExists = existsSync(user.path)
  const userConfigured = Object.hasOwn(user.value.projects, identifier)
  const activeLabel = active.source === "user"
    ? "user"
    : active.source === "project"
      ? "repository"
      : "built-in defaults"

  console.log(`Project: ${identifier}`)
  console.log(`User config: ${userConfigured ? "configured" : userFileExists ? "project not configured" : "not created"}`)
  if (userFileExists) console.log(`  File: ${user.path}`)
  const repositoryConfigured = existsSync(projectPath)
  console.log(`Repository config: ${repositoryConfigured ? "configured" : "not created"}`)
  if (repositoryConfigured) console.log(`  File: ${projectPath}`)
  console.log(`Active config: ${activeLabel}`)
  console.log(`Worktree directory: ${resolveWorktreeDirectory(repository, active.value)}`)
  console.log(JSON.stringify(active.value, null, 2))
}

function commandConfig(args) {
  if (args[0] === "create") return commandConfigCreate(args.slice(1))
  if (args[0] === "show") return commandConfigShow(args.slice(1))
  throw new CliError("Usage: gwt config <create [--project]|show>")
}

function configuredShellEnvironment() {
  const insideRepository = git(["rev-parse", "--is-inside-work-tree"], process.cwd(), { allowFailure: true })
  if (insideRepository.status !== 0) return {}

  const repository = discoverRepository()
  const worktree = currentWorktree(repository)
  if (!worktree || resolve(worktree.path) === resolve(repository.primaryPath)) return {}

  const metadata = metadataForWorktree(repository, worktree)
  if (!metadata) return {}

  const configDocument = loadConfig(repository)
  if (configDocument.requiresTrust) {
    const fingerprint = trustFingerprint(repository, configDocument, canonical(worktree.path))
    if (!isTrusted(repository, fingerprint)) return {}
  }

  const ports = Object.fromEntries(configDocument.value.ports.map((name) => {
    if (!Object.hasOwn(metadata.ports ?? {}, name)) {
      throw new CliError(`This worktree has no assigned ${name}; recreate it after changing ports`)
    }
    return [name, String(metadata.ports[name])]
  }))
  return { ...ports, ...resolveConfiguredEnv(configDocument.value, metadata.ports ?? {}) }
}

function readShellEnvironmentState() {
  const encoded = process.env[SHELL_ENV_STATE]
  if (!encoded) return { originals: {} }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
    if (!parsed || typeof parsed.originals !== "object" || Array.isArray(parsed.originals)) throw new Error()
    const originals = Object.fromEntries(Object.entries(parsed.originals).map(([name, original]) => {
      if (!ENV_NAME.test(name) || name.startsWith("GWT_")) throw new Error()
      if (!original || typeof original !== "object" || typeof original.present !== "boolean") throw new Error()
      if (original.present && typeof original.value !== "string") throw new Error()
      return [name, original.present ? { present: true, value: original.value } : { present: false }]
    }))
    return { originals }
  } catch {
    return { originals: {} }
  }
}

function quoteZsh(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function shellEnvironmentCommands(environment) {
  const previous = readShellEnvironmentState()
  const names = new Set([...Object.keys(previous.originals), ...Object.keys(environment)])
  const originals = {}
  const commands = []

  for (const name of names) {
    const original = previous.originals[name] ?? (Object.hasOwn(process.env, name)
      ? { present: true, value: process.env[name] }
      : { present: false })

    if (Object.hasOwn(environment, name)) {
      originals[name] = original
      commands.push(`export ${name}=${quoteZsh(environment[name])}`)
    } else if (original.present) {
      commands.push(`export ${name}=${quoteZsh(original.value)}`)
    } else {
      commands.push(`unset ${name}`)
    }
  }

  if (Object.keys(originals).length === 0) {
    commands.push(`unset ${SHELL_ENV_STATE}`)
  } else {
    const state = Buffer.from(JSON.stringify({ originals })).toString("base64url")
    commands.push(`export ${SHELL_ENV_STATE}=${quoteZsh(state)}`)
  }
  return commands.join("\n")
}

function commandShellEnvironment(args) {
  if (args.length !== 1 || args[0] !== "zsh") throw new CliError("Invalid shell environment request")
  let environment = {}
  try {
    environment = configuredShellEnvironment()
  } catch {}
  console.log(shellEnvironmentCommands(environment))
}

function zshIntegration() {
  return `# gwt shell integration for zsh
if command -v gwt >/dev/null 2>&1; then
  gwt() {
    local cd_file exit_code=0
    cd_file="$(mktemp)" || return
    GWT_CD_FILE="$cd_file" command gwt "$@" || exit_code=$?
    if [[ $exit_code -eq 0 && -s "$cd_file" ]]; then
      builtin cd -- "$(<"$cd_file")" || exit_code=$?
    fi
    rm -f -- "$cd_file"
    if [[ $exit_code -eq 0 ]]; then
      _gwt_sync_env
    fi
    return $exit_code
  }

  _gwt_sync_env() {
    local commands
    commands="$(command gwt __shell_env zsh 2>/dev/null)" || return 0
    [[ -n "$commands" ]] && eval "$commands"
  }

  _gwt_worktrees() {
    local -a lines selectors aliases
    local line id branch tab=$'\\t'
    lines=("\${(@f)$(command gwt __complete worktrees 2>/dev/null)}")
    for line in $lines; do
      id="\${line%%\${tab}*}"
      branch="\${line#*\${tab}}"
      if [[ -n "$branch" ]]; then
        selectors+=("\${branch}:\${id:-unmanaged}")
        [[ -n "$id" ]] && aliases+=("$id")
      elif [[ -n "$id" ]]; then
        selectors+=("\${id}:detached")
      fi
    done
    (( $#selectors )) && _describe -t worktrees 'worktree' selectors
    [[ -n "$PREFIX" ]] && (( $#aliases )) && compadd -n -a aliases
  }

  _gwt_refs() {
    local -a refs
    refs=("\${(@f)$(command gwt __complete refs 2>/dev/null)}")
    compadd -a refs
  }

  _gwt() {
    local -a commands
    commands=(
      'new:Create and set up a worktree'
      'setup:Set up an existing worktree'
      'list:List worktrees'
      'ls:List worktrees'
      'switch:Switch to a worktree'
      'info:Show worktree details'
      'remove:Remove a worktree'
      'prune:Clean up records of removed worktrees'
      'trust:Approve project hooks'
      'config:Manage user and project configuration'
      'shell:Install shell integration'
      'skill:Install the gwt skill for coding agents'
    )

    if (( CURRENT == 2 )); then
      _describe 'command' commands
      return
    fi

    case "$words[2]" in
      new)
        _arguments \
          '2:branch name:_gwt_refs' \
          '--base[base Git revision]:revision:_gwt_refs' \
          '--no-hooks[skip project hooks]' \
          '--background[run postCreate in the background]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      setup)
        _arguments \
          '2:worktree:_gwt_worktrees' \
          '--no-hooks[skip project hooks]' \
          '--background[run postCreate in the background]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      list|ls)
        _arguments '(-h --help)'{-h,--help}'[show help]'
        ;;
      switch)
        _arguments \
          '2:worktree:_gwt_worktrees' \
          '--create[create a worktree for a branch without one]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      info)
        _arguments \
          '2:worktree:_gwt_worktrees' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      remove)
        _arguments \
          '2:worktree:_gwt_worktrees' \
          '--keep-branch[keep the worktree branch]' \
          '--discard[discard uncommitted changes]' \
          '--yes[skip removal confirmation]' \
          '--no-hooks[skip project hooks]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      prune)
        _arguments \
          '--dry-run[show what would be pruned]' \
          '--yes[skip the confirmation]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      trust)
        _arguments \
          '--revoke[revoke project hook approval]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      config)
        _arguments \
          '2:action:(create show)' \
          '--project[create a config in the repository]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      shell)
        _arguments \
          '2:action:(install)' \
          '3:shell:(zsh)' \
          '--dry-run[show the change without writing]' \
          '--yes[skip installation confirmation]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      skill)
        _arguments \
          '2:action:(install)' \
          '3:agent:(claude codex)' \
          '--project[install into the repository instead of the home directory]' \
          '--dry-run[show the change without writing]' \
          '--yes[skip installation confirmation]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
    esac
  }

  if (( $+functions[compdef] )); then
    compdef _gwt gwt
  fi

  typeset -ga chpwd_functions
  if (( ! \${chpwd_functions[(I)_gwt_sync_env]} )); then
    chpwd_functions+=(_gwt_sync_env)
  fi
  _gwt_sync_env
fi`
}

function agentSkill() {
  return `---
name: gwt
description: Use gwt to create, list, switch, and remove Git worktrees. Use whenever a task needs an isolated worktree, or in place of running 'git worktree' directly.
---

gwt wraps native Git worktrees and prepares each one with the project's local
files, assigned ports, and setup hooks.

## Prefer gwt over 'git worktree'

Create worktrees with \`gwt new\`, not \`git worktree add\`. A worktree added with
plain Git skips the configured file copies, port assignment, and postCreate
hook, and records no gwt metadata, so \`gwt list\` and \`gwt remove\` cannot manage
it. Adopt an existing one with \`gwt setup <path>\`.

## Read the help instead of guessing flags

\`gwt --help\` lists the commands, \`gwt <command> --help\` documents arguments,
options, and behavior, and nested commands such as \`gwt config create --help\`
have their own help. This skill does not repeat command signatures so that they
stay accurate across versions.

## What the help does not make obvious

- Ports, environment variables, and hooks declared by a committed \`.gwt.json\`
  are not applied until the repository is approved with \`gwt trust\`. Approval
  is invalidated whenever the config or a hook changes, so a repository that
  worked before can start asking again.
- A failed setup keeps the worktree and records the failure. Retry it with
  \`gwt setup <id>\` rather than removing and recreating the worktree.
- Ports are assigned per worktree. With shell integration installed, assigned
  ports and configured environment variables load automatically. Read ports
  from \`gwt info\` instead of assuming a project default; two worktrees of the
  same project never share a port.
- \`gwt switch\` changes the shell's directory only when the shell integration is
  installed. Otherwise it just prints the path.
- \`gwt switch\` with no target opens an interactive picker, so always pass an
  explicit target when running non-interactively.

## Removal is destructive

\`gwt remove\` deletes the worktree and, by default, its branch. Confirm with the
user before running it, and never pass \`--discard --yes\` on your own: together
they discard uncommitted changes and force-delete an unmerged branch.
`
}

function skillPath(agent, project) {
  const base = project ? discoverRepository().primaryPath : homedir()
  return join(base, SKILL_DIRECTORIES[agent], "skills", "gwt", "SKILL.md")
}

async function installSkill(agent, args) {
  const { options, positionals } = parseOptions(args, {
    "--project": "boolean",
    "--dry-run": "boolean",
    "--yes": "boolean",
  })
  if (positionals.length > 0) throw new CliError(SKILL_USAGE)

  const path = skillPath(agent, options.project)
  const contents = agentSkill()
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null
  if (existing === contents) {
    console.log(`Skill is already installed in ${path}`)
    return
  }

  const verb = existing === null ? "Create" : "Replace"
  console.log(`${verb} ${path}`)
  if (options["dry-run"]) {
    console.log(`\n${contents}`)
    return
  }
  if (!options.yes && !(await ask(`${verb}? [y/N] `))) throw new CliError("Skill installation cancelled")

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  console.log(`Installed skill in ${path}`)
}

async function commandSkill(args) {
  if (args[0] === "install" && Object.hasOwn(SKILL_DIRECTORIES, args[1])) {
    return installSkill(args[1], args.slice(2))
  }
  throw new CliError(SKILL_USAGE)
}

function zshConfigPath() {
  return join(process.env.ZDOTDIR ? resolve(process.env.ZDOTDIR) : homedir(), ".zshrc")
}

async function installZshIntegration(args) {
  const { options, positionals } = parseOptions(args, { "--dry-run": "boolean", "--yes": "boolean" })
  if (positionals.length > 0) throw new CliError("Usage: gwt shell install zsh [--dry-run] [--yes]")

  const path = zshConfigPath()
  const current = existsSync(path) ? readFileSync(path, "utf8") : ""
  const installed = current
    .split("\n")
    .some((line) => !line.trimStart().startsWith("#") && line.includes("gwt shell init zsh"))
  if (installed) {
    console.log(`Shell integration is already installed in ${path}`)
    return
  }

  const line = 'eval "$(command gwt shell init zsh)"'
  console.log(`Add to ${path}:\n\n${line}`)
  if (options["dry-run"]) return
  if (!options.yes && !(await ask("Install? [y/N] "))) throw new CliError("Shell integration installation cancelled")

  mkdirSync(dirname(path), { recursive: true })
  const separator = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n"
  writeFileSync(path, `${current}${separator}# gwt shell integration\n${line}\n`)
  console.log(`Installed shell integration in ${path}`)
  console.log("Restart zsh or run: source ~/.zshrc")
}

async function commandShell(args) {
  if (args[0] === "init" && args[1] === "zsh" && args.length === 2) {
    console.log(zshIntegration())
    return
  }
  if (args[0] === "install" && args[1] === "zsh") return installZshIntegration(args.slice(2))
  throw new CliError("Usage: gwt shell install zsh [--dry-run] [--yes]")
}

function commandRunHook(args) {
  if (args.length !== 2 || args[0] !== "postCreate") throw new CliError("Invalid hook request")
  const repository = discoverRepository()
  const metadata = loadMetadata(repository).find((item) => item.id === args[1])
  if (!metadata) throw new CliError(`No worktree metadata for ${args[1]}`)
  const worktree = repository.worktrees.find((item) => resolve(item.path) === resolve(metadata.path))
  if (!worktree) throw new CliError(`Worktree ${metadata.id} is no longer registered with Git`)

  const configDocument = loadConfig(repository)
  const claimed = updateMetadata(repository, metadata, { job: { ...metadata.job, pid: process.pid } })
  const finish = (update) => {
    if (!existsSync(metadataPath(repository, claimed.id))) return
    updateMetadata(repository, claimed, {
      ...update,
      job: { ...claimed.job, finishedAt: new Date().toISOString() },
    })
  }

  try {
    if (configDocument.requiresTrust) {
      const fingerprint = trustFingerprint(repository, configDocument, canonical(worktree.path))
      if (!isTrusted(repository, fingerprint)) {
        throw new CliError("Project configuration is not trusted. Run 'gwt trust' to approve it")
      }
    }
    runHook("postCreate", repository, configDocument, worktree, claimed)
    finish({ setup: "complete", setupError: undefined })
  } catch (error) {
    finish({ setup: "failed", setupError: error.message })
    throw error
  }
}

function commandComplete(args) {
  if (args.length !== 1) throw new CliError("Invalid completion request")

  if (args[0] === "worktrees") {
    const repository = discoverRepository()
    const lines = [`primary\t${repository.primary.branch ?? ""}`]
    for (const worktree of repository.worktrees) {
      if (resolve(worktree.path) === resolve(repository.primaryPath)) continue
      const metadata = metadataForWorktree(repository, worktree)
      const id = metadata?.id ?? ""
      const branch = worktree.branch ?? ""
      if (id || branch) lines.push(`${id}\t${branch}`)
    }
    console.log(lines.join("\n"))
    return
  }

  if (args[0] === "refs") {
    const refs = git([
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ], process.cwd()).stdout.trim()
    console.log(["HEAD", ...refs.split("\n").filter(Boolean)].join("\n"))
    return
  }

  throw new CliError("Invalid completion request")
}

function version() {
  const path = join(import.meta.dirname, "..", "package.json")
  return JSON.parse(readFileSync(path, "utf8")).version
}

function help(command, subcommand) {
  const aliases = { ls: "list" }
  const requested = [command, subcommand].filter(Boolean).join(" ")
  const topic = aliases[requested] ?? requested
  const texts = {
    "": `gwt ${version()} - lightweight native Git worktree workflows

Usage:
  gwt <command> [options]

Commands:
  new       Create and set up a worktree
  setup     Set up an existing worktree
  list      List registered worktrees (alias: ls)
  switch    Switch the current shell to a worktree
  info      Show worktree details and assigned ports
  remove    Safely remove a worktree and optionally its branch
  prune     Clean up leftovers from worktrees that are already gone
  trust     Approve or revoke repository project configuration
  config    Create or inspect configuration
  shell     Install shell integration
  skill     Install the gwt skill for coding agents

Options:
  -h, --help      Show help.
  -V, --version   Show the gwt version.

Examples:
  gwt new feature/auth
  gwt switch
  gwt remove
  gwt prune
  gwt config create
  gwt shell install zsh
  gwt skill install claude

Run 'gwt <command> --help' for command behavior and more examples.`,
    new: `Create a worktree, prepare its development environment, and switch to it.

Usage:
  gwt new [branch] [--base <ref>] [--no-hooks] [--background]

Arguments:
  branch          Branch to check out. An existing local branch is reused, a
                  branch that exists on exactly one remote is checked out with
                  tracking, and anything else is created. Defaults to
                  scratch/<id>.

Options:
  --base <ref>    Create the branch from this Git revision instead of the
                  configured base or the primary worktree's current commit.
                  Rejected when the branch already exists locally.
  --no-hooks      Copy files and allocate ports, but skip postCreate.
  --background    Run postCreate detached so the shell returns immediately.
  -h, --help      Show help for this command.

Behavior:
  The worktree receives an immutable 8-character ID. gwt creates it below the
  resolved worktree directory, copies configured local files, assigns stable
  ports, and runs postCreate. A setup failure keeps the worktree so setup can
  be retried. With shell integration installed, the current shell moves into
  the new worktree after setup succeeds. Without worktreeDirectory, the default
  is $GWT_HOME/worktrees or ~/.gwt/worktrees when GWT_HOME is not set. A short
  repository hash is added to the directory name only when needed to avoid a
  name collision.

  A branch already checked out in another worktree is refused; switch to that
  worktree instead. With --background, files are copied, ports are assigned,
  and project configuration is approved before postCreate is detached, so the
  worktree is usable right away. 'gwt list' shows it as running until the
  hook finishes, and its output is written to .git/gwt/logs/<id>.log.

Examples:
  gwt new feature/auth
  gwt new
  gwt new hotfix/login --base origin/main
  gwt new feature/from-remote
  gwt new heavy-project --background`,
    setup: `Prepare an existing linked worktree using the active gwt configuration.

Usage:
  gwt setup [id|branch|path] [--no-hooks] [--background]

Arguments:
  id|branch|path  Worktree to set up. Defaults to the current worktree.

Options:
  --no-hooks      Copy files and allocate ports, but skip postCreate.
  --background    Run postCreate detached so the shell returns immediately.
  -h, --help      Show help for this command.

Behavior:
  Use this to adopt a worktree created with native 'git worktree add' or to
  retry a failed setup. Existing copied files and assigned ports are preserved.
  Setup refuses to start while a background setup is already running for the
  same worktree.

Examples:
  gwt setup
  gwt setup feature/auth
  gwt setup a1b2c3d4 --no-hooks
  gwt setup a1b2c3d4 --background`,
    list: `List Git worktrees together with gwt IDs and setup status.

Usage:
  gwt list
  gwt ls

Options:
  -h, --help      Show help for this command.

The current worktree is marked with '*'. Native worktrees that have not been
set up by gwt are shown as unmanaged. 'gwt ls' is an alias for 'gwt list'.

Examples:
  gwt list
  gwt ls`,
    switch: `Switch the current shell to another worktree.

Usage:
  gwt switch [primary|id|branch|path] [--create]

Arguments:
  selector        Worktree to switch to. Opens the picker when omitted.

Options:
  --create        Create the worktree without asking when the selector names a
                  branch that has none.
  -h, --help      Show help for this command.

Behavior:
  'primary' is the reserved ID for the primary worktree. Other worktrees can be
  selected by ID, exact branch name, or path. The picker supports arrow keys,
  j/k, Ctrl-n/Ctrl-p, and '/' filtering. Shell integration must be installed for
  gwt to change the parent shell's directory; otherwise the path is only printed.

  When nothing matches and the selector is a valid branch name, gwt offers to
  create the worktree, reusing an existing branch or tracking a remote one just
  like 'gwt new'. Selectors that look like paths are never treated as branch
  names. Non-interactive use requires --create.

Examples:
  gwt switch
  gwt switch primary
  gwt switch feature/auth
  gwt switch a1b2c3d4
  gwt switch feature/review --create`,
    info: `Show a worktree's identity, Git state, setup status, and assigned ports.

Usage:
  gwt info [primary|id|branch|path]

Arguments:
  selector        'primary', an ID, an exact branch name, or a path. Defaults
                  to the current worktree.

Options:
  -h, --help      Show help for this command.

Examples:
  gwt info
  gwt info primary
  gwt info feature/auth`,
    remove: `Safely remove a linked worktree and, by default, its branch.

Usage:
  gwt remove [id|branch|path] [--keep-branch|--discard] [--yes] [--no-hooks]

Arguments:
  id|branch|path  Worktree to remove. Defaults to the current worktree.

Options:
  --keep-branch   Remove the worktree but retain its branch.
  --discard       Allow uncommitted changes to be discarded and force-delete
                  the branch.
  --yes           Skip the confirmation required by --discard.
  --no-hooks      Skip preRemove.
  -h, --help      Show help for this command.

Behavior:
  Without --discard, dirty worktrees are rejected and branches are deleted only
  when 'git branch -d' considers deletion safe. If safe deletion fails, an
  interactive terminal asks whether to force-delete the branch; non-interactive
  use keeps it. The primary worktree cannot be removed. Removing the current
  worktree returns an integrated shell to the primary worktree.

  A worktree created without a branch argument records its scratch/<id> branch.
  If the worktree later moved to another branch, removal deletes that leftover
  scratch branch when the branch it moved to already contains every scratch
  commit, so nothing is lost. A scratch branch holding commits that were left
  behind is kept and reported instead. --keep-branch keeps it either way.
  Removal refuses to run while a background setup is still in progress; use
  --discard to force it. Configuration approval is requested only when
  preRemove is configured, because removal applies nothing else from the
  configuration.

Examples:
  gwt remove
  gwt remove feature/auth --keep-branch
  gwt remove a1b2c3d4 --discard --yes`,
    prune: `Clean up records left behind by worktrees that are already gone.

Usage:
  gwt prune [--dry-run] [--yes]

Options:
  --dry-run       Print what would be pruned without changing anything.
  --yes           Prune without asking for confirmation.
  -h, --help      Show help for this command.

Behavior:
  Prune reports what it would remove and asks before touching anything, so
  running it with no options is safe. It unregisters worktrees whose directory
  is gone, deletes metadata and setup logs with no worktree left, and deletes
  the scratch branch such a worktree recorded.

  A scratch branch is deleted only when another local or remote branch already
  contains its commits, so nothing is lost. One holding commits no other branch
  contains is reported and kept. Only branches gwt recorded at creation are
  considered; other branches are never touched. Metadata for a setup that is
  still running is left alone.

Examples:
  gwt prune
  gwt prune --dry-run
  gwt prune --yes`,
    trust: `Approve or revoke active configuration declared by the repository's .gwt.json.

Usage:
  gwt trust [--revoke]

Options:
  --revoke        Remove the stored approval for this repository.
  -h, --help      Show help for this command.

Approval is required before repository-defined ports or environment variables
are applied, or repository hooks run. It is tied to the configuration and hook
contents, so changing either requires approval again. User configuration is
trusted automatically.

Examples:
  gwt trust
  gwt trust --revoke`,
    config: `Create or inspect configuration for the current repository.

Usage:
  gwt config <create|show>

Commands:
  create          Create a user config entry or a repository config file
  show            Show config availability, source, and resolved values

Options:
  -h, --help      Show help for this command.

Examples:
  gwt config create
  gwt config create --project
  gwt config show

Run 'gwt config <command> --help' for details.`,
    "config create": `Create configuration for the current repository.

Usage:
  gwt config create [--project]

Options:
  --project       Create .gwt.json in the primary worktree instead of adding
                  an entry to the user config.
  -h, --help      Show help for this command.

By default, the project is added to the user config:
  ${userConfigPath()}

With --project, the active user configuration's non-hook fields are copied
when available; otherwise a default scaffold is created. User hooks are omitted
because repository hooks use worktree-relative paths. Repository configuration
takes precedence and can be committed for the team.

Examples:
  gwt config create
  gwt config create --project`,
    "config show": `Show configuration availability and the active resolved values.

Usage:
  gwt config show

Options:
  -h, --help      Show help for this command.

The output distinguishes a missing user config file from an existing file that
does not configure the current project. It also shows the resolved worktree
directory. Repository configuration takes precedence over user configuration.

Example:
  gwt config show`,
    shell: `Install shell integration for navigation and completion.

Usage:
  gwt shell install zsh [--dry-run] [--yes]

Options:
  -h, --help      Show help for this command.

The integration lets gwt change the current shell's directory after new,
switch, and removal of the current worktree. It also loads the worktree's
assigned ports and configured environment, and installs completion.

Example:
  gwt shell install zsh`,
    "shell install": `Install gwt navigation and completion in Zsh.

Usage:
  gwt shell install zsh [--dry-run] [--yes]

Options:
  --dry-run       Print the .zshrc change without writing it.
  --yes           Install without asking for confirmation.
  -h, --help      Show help for this command.

The command adds one initialization line to ~/.zshrc, or to $ZDOTDIR/.zshrc
when ZDOTDIR is set. Restart Zsh or source the file after installation. The
integration updates the environment when Zsh starts or changes directory and
restores previous values after leaving a managed worktree.

Examples:
  gwt shell install zsh
  gwt shell install zsh --dry-run`,
    skill: `Install the gwt skill so coding agents use gwt correctly.

Usage:
  gwt skill install <claude|codex> [--project] [--dry-run] [--yes]

Options:
  -h, --help      Show help for this command.

The skill teaches an agent to prefer gwt over native 'git worktree', to read
'gwt <command> --help' for command details, and to treat removal as
destructive. It does not duplicate command signatures, so it stays accurate
as gwt changes.

Examples:
  gwt skill install claude
  gwt skill install codex`,
    "skill install": `Install the gwt skill for a coding agent.

Usage:
  gwt skill install <claude|codex> [--project] [--dry-run] [--yes]

Arguments:
  claude          Install for Claude Code, under .claude/skills.
  codex           Install for Codex, under .agents/skills.

Options:
  --project       Write the skill inside the primary worktree, so it can be
                  committed for the team, instead of the home directory.
  --dry-run       Print the target path and the skill without writing it.
  --yes           Install without asking for confirmation.
  -h, --help      Show help for this command.

Both agents read the same SKILL.md format and only differ in location, so the
installed skill is identical. Install it once per agent.

Reinstall after upgrading gwt to pick up a revised skill. The command reports
an unchanged file as already installed and asks before replacing a modified
one.

Examples:
  gwt skill install claude
  gwt skill install codex
  gwt skill install codex --project
  gwt skill install claude --dry-run`,
  }

  if (!Object.hasOwn(texts, topic)) throw new CliError(`Unknown help topic: ${topic}`)
  console.log(texts[topic])
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === "--help" || command === "-h") return help()
  if (command === "help") return help(args[0], args[1])
  if (command === "--version" || command === "-V") return console.log(version())
  if (args.includes("--help") || args.includes("-h")) {
    const subcommand = ["config", "shell", "skill"].includes(command)
      ? args.find((argument) => !argument.startsWith("-"))
      : undefined
    return help(command, subcommand)
  }
  if (command === "new") return commandNew(args)
  if (command === "setup") return commandSetup(args)
  if (command === "list" || command === "ls") return commandList(args)
  if (command === "switch") return commandSwitch(args)
  if (command === "info") return commandInfo(args)
  if (command === "remove") return commandRemove(args)
  if (command === "prune") return commandPrune(args)
  if (command === "trust") return commandTrust(args)
  if (command === "config") return commandConfig(args)
  if (command === "shell") return commandShell(args)
  if (command === "skill") return commandSkill(args)
  if (command === "__complete") return commandComplete(args)
  if (command === "__run-hook") return commandRunHook(args)
  if (command === "__shell_env") return commandShellEnvironment(args)
  throw new CliError(`Unknown command: ${command}`)
}

try {
  await main()
} catch (error) {
  if (error instanceof CliError) {
    console.error(`gwt: ${error.message}`)
    process.exitCode = 1
  } else {
    throw error
  }
}
