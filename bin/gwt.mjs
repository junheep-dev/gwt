#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { emitKeypressEvents } from "node:readline"
import { createInterface } from "node:readline/promises"

const PROJECT_CONFIG_FILE = ".gwt.json"
const PORT_MIN = 20_000
const PORT_MAX = 39_999
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const DEFAULT_CONFIG = { worktreeDirectory: ".worktrees", copyFiles: [], ports: [] }
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
  const allowed = new Set(["base", "worktreeDirectory", "copyFiles", "ports", "postCreate", "preRemove"])
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) throw new CliError(`${label} contains an unknown field: ${key}`)
  }

  if (parsed.base !== undefined && (typeof parsed.base !== "string" || parsed.base.length === 0)) {
    throw new CliError("base must be a non-empty string")
  }

  const worktreeDirectory = validateRelativePath(parsed.worktreeDirectory ?? ".worktrees", "worktreeDirectory")
  if (worktreeDirectory.split(/[\\/]+/).some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new CliError("worktreeDirectory can only contain letters, digits, '.', '_', '-', and path separators")
  }
  if (!Array.isArray(parsed.copyFiles ?? [])) throw new CliError("copyFiles must be an array")
  const copyFiles = (parsed.copyFiles ?? []).map((path, index) => validateRelativePath(path, `copyFiles[${index}]`))
  if (new Set(copyFiles).size !== copyFiles.length) throw new CliError("copyFiles cannot contain duplicates")

  if (!Array.isArray(parsed.ports ?? [])) throw new CliError("ports must be an array")
  const ports = (parsed.ports ?? []).map((name, index) => {
    if (typeof name !== "string" || !ENV_NAME.test(name)) throw new CliError(`ports[${index}] is not a valid environment variable name`)
    return name
  })
  if (new Set(ports).size !== ports.length) throw new CliError("ports cannot contain duplicates")
  if (ports.length > 100) throw new CliError("ports cannot contain more than 100 entries")

  for (const hook of ["postCreate", "preRemove"]) {
    if (parsed[hook] !== undefined) validateRelativePath(parsed[hook], hook)
  }

  return {
    ...parsed,
    worktreeDirectory,
    copyFiles,
    ports,
  }
}

function configHome() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
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
    .filter((worktree) => isInside(canonical(worktree.path), resolvedCwd))
    .sort((left, right) => right.path.length - left.path.length)[0] ?? null
}

function resolveWorktree(repository, selector, options = {}) {
  if (!selector) {
    const current = currentWorktree(repository)
    if (!current) throw new CliError("The current directory is not inside a registered worktree")
    return current
  }

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
  const pathMatch = repository.worktrees.find((worktree) => resolve(worktree.path) === candidatePath)
  if (pathMatch) return pathMatch

  throw new CliError(`No worktree matches '${selector}'`)
}

function generateId(repository, config) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomBytes(4).toString("hex")
    const target = join(repository.primaryPath, config.worktreeDirectory, id)
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
  if (hooks.length === 0) return null
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
  console.error("This repository wants to run:")
  for (const hook of hooks) console.error(`  ${hook.name}: ${hook.configuredPath}`)
  const allowed = await ask("Allow and remember? [y/N] ")
  if (!allowed) throw new CliError("Project hooks are not trusted. Run 'gwt trust' to approve them")
  saveTrust(repository, fingerprint)
}

function hookContext(repository, worktree, metadata) {
  return {
    id: metadata?.id ?? "",
    path: canonical(worktree.path),
    primaryPath: repository.primaryPath,
    branch: worktree.branch ?? "",
    ports: metadata?.ports ?? {},
  }
}

function runHook(name, repository, configDocument, worktree, metadata) {
  const configuredPath = configDocument.value[name]
  if (!configuredPath) return
  const hook = hookPaths(configDocument, canonical(worktree.path)).find((item) => item.name === name)
  const context = hookContext(repository, worktree, metadata)
  const env = {
    ...process.env,
    GWT_ID: context.id,
    GWT_PATH: context.path,
    GWT_PRIMARY_PATH: context.primaryPath,
    GWT_BRANCH: context.branch,
    ...Object.fromEntries(Object.entries(context.ports).map(([key, value]) => [key, String(value)])),
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
    writeJson(metadataPath(repository, id), metadata)
  }

  try {
    copyConfiguredFiles(repository, configDocument.value, targetPath)
    if (options.noHooks) {
      metadata = updateMetadata(repository, metadata, { setup: "incomplete" })
      return metadata
    }
    await ensureTrusted(repository, configDocument, targetPath)
    runHook("postCreate", repository, configDocument, worktree, metadata)
    metadata = updateMetadata(repository, metadata, { setup: "complete" })
    return metadata
  } catch (error) {
    updateMetadata(repository, metadata, { setup: "failed", setupError: error.message })
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

function validateBranch(branch, cwd) {
  const result = git(["check-ref-format", "--branch", branch], cwd, { allowFailure: true })
  if (result.status !== 0) throw new CliError(`Invalid branch name: ${branch}`)
  const exists = git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd, { allowFailure: true }).status === 0
  if (exists) throw new CliError(`Branch already exists: ${branch}`)
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

async function commandNew(args) {
  const { options, positionals } = parseOptions(args, { "--base": "value", "--no-hooks": "boolean" })
  if (positionals.length > 1) throw new CliError("Usage: gwt new [branch] [--base <ref>] [--no-hooks]")
  const repository = discoverRepository()
  const configDocument = loadConfig(repository)
  ensureCopySources(repository, configDocument.value)
  const id = generateId(repository, configDocument.value)
  const branch = positionals[0] ?? `scratch/${id}`
  validateBranch(branch, repository.primaryPath)
  const requestedBase = options.base ?? configDocument.value.base
  const base = requestedBase
    ? gitOutput(["rev-parse", "--verify", `${requestedBase}^{commit}`], repository.primaryPath)
    : gitOutput(["rev-parse", "HEAD"], repository.primaryPath)
  const target = join(repository.primaryPath, configDocument.value.worktreeDirectory, id)
  ensureLocalExclude(repository, configDocument.value.worktreeDirectory)

  git(["worktree", "add", "-b", branch, target, base], repository.primaryPath, { stdio: "inherit" })
  const refreshed = discoverRepository(repository.primaryPath)
  const worktree = refreshed.worktrees.find((item) => resolve(item.path) === resolve(target))

  try {
    const metadata = await setupWorktree(refreshed, configDocument, worktree, {
      id,
      noHooks: options["no-hooks"],
    })
    console.log(`Worktree ${metadata.id} is ready at ${target}`)
    console.log(`Branch: ${branch}`)
    for (const [name, port] of Object.entries(metadata.ports)) console.log(`${name}: ${port}`)
    writeCdDirective(target)
  } catch (error) {
    console.error(`Setup failed; worktree retained at ${target}`)
    console.error(`Retry: gwt setup ${id}`)
    console.error(`Remove: gwt remove ${id}`)
    throw error
  }
}

async function chooseWorktree(repository) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError("A worktree selector is required in non-interactive mode")
  const current = currentWorktree(repository)
  const choices = repository.worktrees.map((worktree, index) => {
    const metadata = metadataForWorktree(repository, worktree)
    const relativePath = relative(repository.primaryPath, worktree.path)
    return {
      worktree,
      current: resolve(current?.path ?? "") === resolve(worktree.path),
      branch: worktree.branch ?? "(detached)",
      id: metadata?.id ?? (index === 0 ? "primary" : "native"),
      path: relativePath === "" ? "." : relativePath.startsWith(`..${sep}`) ? worktree.path : relativePath,
    }
  })

  return new Promise((resolveChoice, rejectChoice) => {
    let query = ""
    let filtering = false
    let selected = Math.max(0, choices.findIndex((choice) => choice.current))
    let renderedLines = 0
    const wasRaw = process.stdin.isRaw
    const colors = process.env.NO_COLOR === undefined
      ? { cyan: "\x1b[36m", yellow: "\x1b[33m", dim: "\x1b[2m", reset: "\x1b[0m" }
      : { cyan: "", yellow: "", dim: "", reset: "" }

    const clear = () => {
      if (renderedLines > 0) process.stdout.write(`\x1b[${renderedLines}A\r\x1b[J`)
      renderedLines = 0
    }

    const render = () => {
      const normalizedQuery = query.toLowerCase()
      const filtered = choices.filter((choice) => [choice.branch, choice.id, choice.path]
        .some((value) => value.toLowerCase().includes(normalizedQuery)))
      if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1)

      const terminalWidth = Math.max(40, process.stdout.columns ?? 100)
      const numberWidth = String(Math.max(1, filtered.length)).length
      const idWidth = 8
      const longestBranch = Math.max(12, ...filtered.map((choice) => choice.branch.length))
      const branchWidth = Math.min(32, longestBranch, terminalWidth - numberWidth - idWidth - 22)
      const pathWidth = Math.max(8, terminalWidth - numberWidth - branchWidth - idWidth - 10)
      const fit = (value, width) => value.length > width
        ? `${value.slice(0, Math.max(0, width - 1))}…`
        : value.padEnd(width)
      const visibleCount = Math.max(3, (process.stdout.rows ?? 24) - 5)
      const start = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), filtered.length - visibleCount))
      const visible = filtered.slice(start, start + visibleCount)
      const lines = [
        `${colors.dim}${fit("Switch worktree  ↑↓/jk/C-n/C-p move · 1-9 select · / filter · Enter", terminalWidth)}${colors.reset}`,
        fit(`Filter: ${filtering ? "/" : ""}${query}`, terminalWidth),
        `${colors.dim}  ${fit("#", numberWidth)}    ${fit("BRANCH", branchWidth)}  ${fit("ID", idWidth)}  ${fit("PATH", pathWidth)}${colors.reset}`,
      ]

      if (visible.length === 0) {
        lines.push(`${colors.dim}  No matching worktrees${colors.reset}`)
      } else {
        visible.forEach((choice, visibleIndex) => {
          const index = start + visibleIndex
          const selection = index === selected ? `${colors.cyan}>${colors.reset}` : " "
          const currentMarker = choice.current ? `${colors.yellow}@${colors.reset}` : " "
          lines.push(`${selection} ${fit(String(index + 1), numberWidth)}  ${currentMarker} ${fit(choice.branch, branchWidth)}  ${fit(choice.id, idWidth)}  ${fit(choice.path, pathWidth)}`)
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
          filtering = false
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
      } else if (!filtering && /^[1-9]$/.test(text)) {
        const choice = filtered[Number(text) - 1]
        if (choice) finish(null, choice)
        else process.stdout.write("\x07")
        return
      } else if (filtering && text && !key.ctrl && !key.meta) {
        query += text.replace(/[\x00-\x1f\x7f]/g, "")
        selected = 0
      }
      render()
    }

    emitKeypressEvents(process.stdin)
    process.stdin.on("keypress", onKeypress)
    process.stdout.on("resize", render)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdout.write("\x1b[?25l")
    render()
  })
}

async function commandSwitch(args) {
  if (args.length > 1) throw new CliError("Usage: gwt switch [id|branch|path]")
  const repository = discoverRepository()
  const worktree = args[0] ? resolveWorktree(repository, args[0]) : await chooseWorktree(repository)
  writeCdDirective(canonical(worktree.path))
  console.log(canonical(worktree.path))
}

function worktreeRows(repository) {
  const current = currentWorktree(repository)
  const metadata = loadMetadata(repository)
  const rows = repository.worktrees.map((worktree, index) => {
    const item = metadata.find((entry) => resolve(entry.path) === resolve(worktree.path))
    return {
      current: current && resolve(current.path) === resolve(worktree.path),
      id: item?.id ?? (index === 0 ? "primary" : "-"),
      branch: worktree.branch ?? "(detached)",
      setup: item?.setup ?? (index === 0 ? "-" : "unmanaged"),
      path: worktree.path,
    }
  })
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

function commandList(args) {
  if (args.length > 0) throw new CliError("Usage: gwt list")
  const repository = discoverRepository()
  const rows = worktreeRows(repository)
  const widths = {
    id: Math.max(2, ...rows.map((row) => displayWidth(row.id))),
    branch: Math.max(6, ...rows.map((row) => displayWidth(row.branch))),
    setup: Math.max(5, ...rows.map((row) => displayWidth(row.setup))),
  }
  console.log(`  ${padDisplay("ID", widths.id)}  ${padDisplay("BRANCH", widths.branch)}  ${padDisplay("SETUP", widths.setup)}  PATH`)
  for (const row of rows) {
    console.log(`${row.current ? "*" : " "} ${padDisplay(row.id, widths.id)}  ${padDisplay(row.branch, widths.branch)}  ${padDisplay(row.setup, widths.setup)}  ${row.path}`)
  }
}

function commandInfo(args) {
  if (args.length > 1) throw new CliError("Usage: gwt info [id|branch|path]")
  const repository = discoverRepository()
  const worktree = resolveWorktree(repository, args[0])
  const metadata = metadataForWorktree(repository, worktree)
  console.log(`ID: ${metadata?.id ?? (resolve(worktree.path) === resolve(repository.primaryPath) ? "primary" : "unmanaged")}`)
  console.log(`Path: ${canonical(worktree.path)}`)
  console.log(`Branch: ${worktree.branch ?? "(detached)"}`)
  console.log(`HEAD: ${worktree.head}`)
  console.log(`Setup: ${metadata?.setup ?? "unmanaged"}`)
  for (const [name, port] of Object.entries(metadata?.ports ?? {})) console.log(`${name}: ${port}`)
  if (metadata?.setupError) console.log(`Setup error: ${metadata.setupError}`)
}

async function commandSetup(args) {
  const { options, positionals } = parseOptions(args, { "--no-hooks": "boolean" })
  if (positionals.length > 1) throw new CliError("Usage: gwt setup [id|branch|path] [--no-hooks]")
  const repository = discoverRepository()
  const configDocument = loadConfig(repository)
  const worktree = resolveWorktree(repository, positionals[0])
  const metadata = await setupWorktree(repository, configDocument, worktree, { noHooks: options["no-hooks"] })
  console.log(`Setup ${metadata.setup}: ${metadata.id}`)
  for (const [name, port] of Object.entries(metadata.ports)) console.log(`${name}: ${port}`)
}

async function confirmDiscard(worktree) {
  console.error(`Discard all changes and delete branch '${worktree.branch ?? "(detached)"}'?`)
  return ask("Type yes to continue [y/N] ")
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
  const dirty = git(["status", "--porcelain"], worktree.path).stdout.length > 0
  if (dirty && !options.discard) throw new CliError("Worktree has uncommitted changes; commit them or use --discard")
  if (options.discard && !options.yes && !(await confirmDiscard(worktree))) throw new CliError("Removal cancelled")
  const wasCurrent = currentWorktree(repository)?.path === worktree.path

  if (!options["no-hooks"]) {
    const configDocument = loadConfig(repository)
    await ensureTrusted(repository, configDocument, targetPath)
    runHook("preRemove", repository, configDocument, worktree, metadata)
  }

  const removeArgs = ["worktree", "remove"]
  if (options.discard) removeArgs.push("--force")
  removeArgs.push(targetPath)
  console.log(`Removing worktree ${metadata?.id ?? targetPath}...`)
  git(removeArgs, repository.primaryPath)
  if (metadata?.metadataPath && existsSync(metadata.metadataPath)) unlinkSync(metadata.metadataPath)

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
  if (wasCurrent) writeCdDirective(repository.primaryPath)
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
      ? "User config hooks are trusted automatically"
      : "This repository has no project config to approve")
    return
  }
  const fingerprint = trustFingerprint(repository, configDocument, canonical(current.path))
  if (!fingerprint) {
    console.log("This repository has no project hooks to approve")
    return
  }
  saveTrust(repository, fingerprint)
  console.log(`Trusted project hooks for ${repository.primaryPath}`)
}

function configScaffold() {
  return { worktreeDirectory: ".worktrees", copyFiles: [], ports: [] }
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
  console.log(JSON.stringify(active.value, null, 2))
}

function commandConfig(args) {
  if (args[0] === "create") return commandConfigCreate(args.slice(1))
  if (args[0] === "show") return commandConfigShow(args.slice(1))
  throw new CliError("Usage: gwt config <create [--project]|show>")
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
    return $exit_code
  }

  _gwt_worktrees() {
    local -a targets
    targets=("\${(@f)$(command gwt __complete worktrees 2>/dev/null)}")
    compadd -a targets
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
      'switch:Switch to a worktree'
      'info:Show worktree details'
      'remove:Remove a worktree'
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
          '2:branch name:' \
          '--base[base Git revision]:revision:_gwt_refs' \
          '--no-hooks[skip project hooks]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      setup)
        _arguments \
          '2:worktree:_gwt_worktrees' \
          '--no-hooks[skip project hooks]' \
          '(-h --help)'{-h,--help}'[show help]'
        ;;
      list)
        _arguments '(-h --help)'{-h,--help}'[show help]'
        ;;
      switch|info)
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

- Hooks declared by a committed \`.gwt.json\` do not run until the repository is
  approved with \`gwt trust\`. Approval is invalidated whenever the config or a
  hook changes, so a repository that worked before can start asking again.
- A failed setup keeps the worktree and records the failure. Retry it with
  \`gwt setup <id>\` rather than removing and recreating the worktree.
- Ports are assigned per worktree. Read them from \`gwt info\` instead of assuming
  a project default; two worktrees of the same project never share a port.
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

function commandComplete(args) {
  if (args.length !== 1) throw new CliError("Invalid completion request")

  if (args[0] === "worktrees") {
    const repository = discoverRepository()
    const values = []
    for (const worktree of repository.worktrees) {
      const metadata = metadataForWorktree(repository, worktree)
      if (metadata?.id) values.push(metadata.id)
      if (worktree.branch) values.push(worktree.branch)
    }
    console.log([...new Set(values)].join("\n"))
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
  const topic = [command, subcommand].filter(Boolean).join(" ")
  const texts = {
    "": `gwt ${version()} - lightweight native Git worktree workflows

Usage:
  gwt <command> [options]

Commands:
  new       Create and set up a worktree
  setup     Set up an existing worktree
  list      List registered worktrees
  switch    Switch the current shell to a worktree
  info      Show worktree details and assigned ports
  remove    Safely remove a worktree and optionally its branch
  trust     Approve or revoke repository project hooks
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
  gwt config create
  gwt shell install zsh
  gwt skill install claude

Run 'gwt <command> --help' for command behavior and more examples.`,
    new: `Create a worktree, prepare its development environment, and switch to it.

Usage:
  gwt new [branch] [--base <ref>] [--no-hooks]

Arguments:
  branch          New local branch name. Defaults to scratch/<id>.

Options:
  --base <ref>    Start from this Git revision instead of the configured base
                  or the primary worktree's current commit.
  --no-hooks      Copy files and allocate ports, but skip postCreate.
  -h, --help      Show help for this command.

Behavior:
  The worktree receives an immutable 8-character ID. gwt creates it below the
  configured worktreeDirectory, copies configured local files, assigns stable
  ports, and runs postCreate. A setup failure keeps the worktree so setup can
  be retried. With shell integration installed, the current shell moves into
  the new worktree after setup succeeds.

Examples:
  gwt new feature/auth
  gwt new
  gwt new hotfix/login --base origin/main
  gwt new experiment --no-hooks`,
    setup: `Prepare an existing linked worktree using the active gwt configuration.

Usage:
  gwt setup [id|branch|path] [--no-hooks]

Arguments:
  id|branch|path  Worktree to set up. Defaults to the current worktree.

Options:
  --no-hooks      Copy files and allocate ports, but skip postCreate.
  -h, --help      Show help for this command.

Behavior:
  Use this to adopt a worktree created with native 'git worktree add' or to
  retry a failed setup. Existing copied files and assigned ports are preserved.

Examples:
  gwt setup
  gwt setup feature/auth
  gwt setup a1b2c3d4 --no-hooks`,
    list: `List Git worktrees together with gwt IDs and setup status.

Usage:
  gwt list

Options:
  -h, --help      Show help for this command.

The current worktree is marked with '*'. Native worktrees that have not been
set up by gwt are shown as unmanaged.

Example:
  gwt list`,
    switch: `Switch the current shell to another worktree.

Usage:
  gwt switch [id|branch|path]

Arguments:
  id|branch|path  Worktree to switch to. Opens the picker when omitted.

Options:
  -h, --help      Show help for this command.

Behavior:
  The picker supports arrow keys, j/k, Ctrl-n/Ctrl-p, number shortcuts, and
  '/' filtering. Shell integration must be installed for gwt to change the
  parent shell's directory; otherwise the selected path is only printed.

Examples:
  gwt switch
  gwt switch feature/auth
  gwt switch a1b2c3d4`,
    info: `Show a worktree's identity, Git state, setup status, and assigned ports.

Usage:
  gwt info [id|branch|path]

Arguments:
  id|branch|path  Worktree to inspect. Defaults to the current worktree.

Options:
  -h, --help      Show help for this command.

Examples:
  gwt info
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

Examples:
  gwt remove
  gwt remove feature/auth --keep-branch
  gwt remove a1b2c3d4 --discard --yes`,
    trust: `Approve or revoke hooks declared by the repository's .gwt.json.

Usage:
  gwt trust [--revoke]

Options:
  --revoke        Remove the stored approval for this repository.
  -h, --help      Show help for this command.

Approval is tied to the configuration and hook contents, so changing either
requires approval again. Hooks declared in user configuration are trusted
automatically.

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
does not configure the current project. Repository configuration takes
precedence over user configuration.

Example:
  gwt config show`,
    shell: `Install shell integration for navigation and completion.

Usage:
  gwt shell install zsh [--dry-run] [--yes]

Options:
  -h, --help      Show help for this command.

The integration lets gwt change the current shell's directory after new,
switch, and removal of the current worktree. It also installs completion.

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
when ZDOTDIR is set. Restart Zsh or source the file after installation.

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
  if (command === "list") return commandList(args)
  if (command === "switch") return commandSwitch(args)
  if (command === "info") return commandInfo(args)
  if (command === "remove") return commandRemove(args)
  if (command === "trust") return commandTrust(args)
  if (command === "config") return commandConfig(args)
  if (command === "shell") return commandShell(args)
  if (command === "skill") return commandSkill(args)
  if (command === "__complete") return commandComplete(args)
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
