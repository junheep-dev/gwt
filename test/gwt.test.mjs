import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, test } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"

const cli = resolve(import.meta.dirname, "../bin/gwt.mjs")
const temporaryDirectories = []

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    input: options.input,
  })
  if (result.error) throw result.error
  return result
}

function git(cwd, ...args) {
  const result = run("git", args, { cwd })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function createRepository() {
  const root = mkdtempSync(join(tmpdir(), "gwt-test-"))
  temporaryDirectories.push(root)
  const repository = join(root, "repo with spaces")
  const configHome = join(root, "config")
  mkdirSync(repository, { recursive: true })
  git(repository, "init", "-b", "main")
  git(repository, "config", "user.name", "GWT Test")
  git(repository, "config", "user.email", "gwt@example.com")
  git(repository, "config", "commit.gpgsign", "false")
  writeFileSync(join(repository, "README.md"), "fixture\n")
  writeFileSync(join(repository, ".gitignore"), ".worktrees/\n.env\n")
  git(repository, "add", "README.md", ".gitignore")
  git(repository, "commit", "-m", "Initial commit")
  const env = { ...process.env, XDG_CONFIG_HOME: configHome }
  return { root, repository, configHome, env }
}

function gwt(fixture, args, options = {}) {
  return run(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? fixture.repository,
    env: fixture.env,
    input: options.input,
  })
}

function writeConfig(repository, value) {
  writeFileSync(join(repository, ".gwt.json"), `${JSON.stringify(value, null, 2)}\n`)
  git(repository, "add", ".gwt.json")
  git(repository, "commit", "-m", "Add worktree config")
}

function writeUserConfig(fixture, value, identifier = realpathSync(fixture.repository)) {
  const path = join(fixture.configHome, "gwt", "config.json")
  mkdirSync(join(fixture.configHome, "gwt"), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ projects: { [identifier]: value } }, null, 2)}\n`)
  return path
}

function metadataFiles(repository) {
  const commonDir = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir")
  const directory = join(commonDir, "gwt", "worktrees")
  return readdirSync(directory).map((name) => join(directory, name))
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("help", () => {
  test("shows concise root help and detailed command examples outside a repository", () => {
    const fixture = createRepository()
    const rootHelp = gwt(fixture, [])
    assert.equal(rootHelp.status, 0, rootHelp.stderr)
    assert.match(rootHelp.stdout, /Commands:/)
    assert.match(rootHelp.stdout, /new\s+Create and set up a worktree/)
    assert.match(rootHelp.stdout, /Examples:/)
    assert.match(rootHelp.stdout, /gwt new feature\/auth/)
    assert.doesNotMatch(rootHelp.stdout, /User configuration:/)
    assert.doesNotMatch(rootHelp.stdout, /Repository configuration:/)

    const newHelp = gwt(fixture, ["new", "--help"], { cwd: fixture.root })
    assert.equal(newHelp.status, 0, newHelp.stderr)
    assert.match(newHelp.stdout, /Usage:\n  gwt new/)
    assert.match(newHelp.stdout, /Behavior:/)
    assert.match(newHelp.stdout, /setup failure keeps the worktree/)
    assert.match(newHelp.stdout, /Examples:/)
  })

  test("reports the packaged version", () => {
    const fixture = createRepository()
    const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"))

    const reported = gwt(fixture, ["--version"])
    assert.equal(reported.status, 0, reported.stderr)
    assert.equal(reported.stdout.trim(), version)
    assert.match(gwt(fixture, []).stdout, new RegExp(`^gwt ${version} `))
  })

  test("supports help for nested and common commands", () => {
    const fixture = createRepository()

    const switchHelp = gwt(fixture, ["help", "switch"])
    assert.equal(switchHelp.status, 0, switchHelp.stderr)
    assert.match(switchHelp.stdout, /Opens the picker when omitted/)
    assert.match(switchHelp.stdout, /gwt switch feature\/auth/)
    assert.doesNotMatch(switchHelp.stdout, /number shortcut/)

    const removeHelp = gwt(fixture, ["remove", "-h"])
    assert.equal(removeHelp.status, 0, removeHelp.stderr)
    assert.match(removeHelp.stdout, /--discard/)
    assert.match(removeHelp.stdout, /git branch -d/)

    const configHelp = gwt(fixture, ["config", "create", "--help"])
    assert.equal(configHelp.status, 0, configHelp.stderr)
    assert.match(configHelp.stdout, /Usage:\n  gwt config create/)
    assert.match(configHelp.stdout, /--project/)

    const shellHelp = gwt(fixture, ["shell", "install", "zsh", "--help"])
    assert.equal(shellHelp.status, 0, shellHelp.stderr)
    assert.match(shellHelp.stdout, /--dry-run/)
    assert.doesNotMatch(shellHelp.stdout, /gwt shell init zsh/)
  })
})

describe("configuration", () => {
  test("rejects unknown configuration fields", () => {
    const fixture = createRepository()
    writeConfig(fixture.repository, { unknown: true })
    const result = gwt(fixture, ["list"])
    assert.equal(result.status, 0)

    const create = gwt(fixture, ["new", "feature/test"])
    assert.equal(create.status, 1)
    assert.match(create.stderr, /unknown field: unknown/)
  })

  test("rejects copy paths that escape the repository", () => {
    const fixture = createRepository()
    writeConfig(fixture.repository, { copyFiles: ["../secret"] })
    const result = gwt(fixture, ["new"])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cannot contain '\.\.'/)
  })

  test("creates and shows user configuration using the remote identifier", () => {
    const fixture = createRepository()
    git(fixture.repository, "remote", "add", "origin", "git@github.com:example/project.git")

    const empty = gwt(fixture, ["config", "show"])
    assert.equal(empty.status, 0, empty.stderr)
    assert.match(empty.stdout, /User config: not created/)
    assert.match(empty.stdout, /Repository config: not created/)
    assert.doesNotMatch(empty.stdout, /\n  File:/)

    const created = gwt(fixture, ["config", "create"])
    assert.equal(created.status, 0, created.stderr)
    const path = join(fixture.configHome, "gwt", "config.json")
    const config = JSON.parse(readFileSync(path, "utf8"))
    assert.deepEqual(config.projects["github.com/example/project"], {
      worktreeDirectory: ".worktrees",
      copyFiles: [],
      ports: [],
    })

    const shown = gwt(fixture, ["config", "show"])
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(shown.stdout, /Project: github\.com\/example\/project/)
    assert.match(shown.stdout, /User config: configured/)
    assert.match(shown.stdout, /File: .*config\.json/)
    assert.match(shown.stdout, /Repository config: not created/)
    assert.match(shown.stdout, /Active config: user/)

    const repeated = gwt(fixture, ["config", "create"])
    assert.equal(repeated.status, 1)
    assert.match(repeated.stderr, /already contains project/)
  })

  test("distinguishes a missing user project from a missing config file", () => {
    const fixture = createRepository()
    writeUserConfig(fixture, {}, "/another/repository")

    const shown = gwt(fixture, ["config", "show"])
    assert.equal(shown.status, 0, shown.stderr)
    assert.match(shown.stdout, /User config: project not configured/)
    assert.match(shown.stdout, /File: .*config\.json/)
    assert.match(shown.stdout, /Active config: built-in defaults/)
  })

  test("uses user config by default and project config when present", () => {
    const fixture = createRepository()
    writeUserConfig(fixture, { ports: ["USER_PORT"] })

    const userWorktree = gwt(fixture, ["new", "feature/user-config"])
    assert.equal(userWorktree.status, 0, userWorktree.stderr)
    const userMetadata = JSON.parse(readFileSync(metadataFiles(fixture.repository)[0], "utf8"))
    assert.ok(Number.isInteger(userMetadata.ports.USER_PORT))
    assert.equal(gwt(fixture, ["remove", userMetadata.id]).status, 0)

    writeConfig(fixture.repository, { ports: ["PROJECT_PORT"] })
    const projectWorktree = gwt(fixture, ["new", "feature/project-config"])
    assert.equal(projectWorktree.status, 0, projectWorktree.stderr)
    const projectMetadata = JSON.parse(readFileSync(metadataFiles(fixture.repository)[0], "utf8"))
    assert.ok(Number.isInteger(projectMetadata.ports.PROJECT_PORT))
    assert.equal(projectMetadata.ports.USER_PORT, undefined)

    const shown = gwt(fixture, ["config", "show"])
    assert.match(shown.stdout, /User config: configured/)
    assert.match(shown.stdout, /Repository config: configured/)
    assert.match(shown.stdout, /Active config: repository/)
  })

  test("creates a commit-ready project config", () => {
    const fixture = createRepository()
    writeUserConfig(fixture, { ports: ["APP_PORT"], copyFiles: [".env"], postCreate: "hooks/setup" })
    const created = gwt(fixture, ["config", "create", "--project"])
    assert.equal(created.status, 0, created.stderr)
    assert.match(created.stdout, /Skipped user hooks: postCreate/)
    const path = join(fixture.repository, ".gwt.json")
    assert.equal(existsSync(path), true)
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      worktreeDirectory: ".worktrees",
      copyFiles: [".env"],
      ports: ["APP_PORT"],
    })
    assert.match(git(fixture.repository, "status", "--short"), /\?\? \.gwt\.json/)
  })

  test("trusts hooks from user config without project approval", () => {
    const fixture = createRepository()
    const hook = join(fixture.configHome, "gwt", "hooks", "setup")
    mkdirSync(dirname(hook), { recursive: true })
    writeFileSync(hook, "#!/bin/sh\nprintf 'hook output\\n'\nprintf 'ran\\n' > user-hook-result\n")
    chmodSync(hook, 0o755)
    writeUserConfig(fixture, { postCreate: "hooks/setup" })

    const created = gwt(fixture, ["new", "feature/user-hook"])
    assert.equal(created.status, 0, created.stderr)
    assert.match(created.stdout, /Running postCreate\.\.\.\nhook output/)
    const metadata = JSON.parse(readFileSync(metadataFiles(fixture.repository)[0], "utf8"))
    assert.equal(readFileSync(join(metadata.path, "user-hook-result"), "utf8"), "ran\n")
    assert.equal(existsSync(join(metadata.path, "hooks", "setup")), false)
    assert.equal(existsSync(join(fixture.configHome, "gwt", "approvals.json")), false)
  })
})

describe("worktree lifecycle", () => {
  test("creates, sets up, renames, switches to, and removes a worktree", () => {
    const fixture = createRepository()
    mkdirSync(join(fixture.repository, "apps", "web"), { recursive: true })
    writeFileSync(join(fixture.repository, "apps", "web", ".env"), "SECRET=local\n")
    writeConfig(fixture.repository, {
      copyFiles: ["apps/web/.env"],
      ports: ["WEB_PORT", "SERVER_PORT"],
    })

    const created = gwt(fixture, ["new", "feature/native-flow"])
    assert.equal(created.status, 0, created.stderr)
    const [metadataFile] = metadataFiles(fixture.repository)
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"))
    assert.equal(metadata.setup, "complete")
    assert.equal(metadata.id.length, 8)
    assert.equal(metadata.id, basename(metadata.path))
    assert.equal(metadata.ports.SERVER_PORT, metadata.ports.WEB_PORT + 1)
    assert.equal(readFileSync(join(metadata.path, "apps", "web", ".env"), "utf8"), "SECRET=local\n")

    delete fixture.env.NO_COLOR
    const list = gwt(fixture, ["list"])
    assert.equal(list.status, 0, list.stderr)
    assert.doesNotMatch(list.stdout, /\x1b\[/)
    assert.match(list.stdout, /^  BRANCH\s+ID\s+SETUP\s+PATH/m)
    assert.match(list.stdout, new RegExp(metadata.id))
    assert.match(list.stdout, /feature\/native-flow/)
    assert.ok(list.stdout.includes(metadata.path))

    git(metadata.path, "branch", "-m", "feature/한글")
    const localizedList = gwt(fixture, ["list"])
    assert.equal(localizedList.status, 0, localizedList.stderr)
    assert.match(localizedList.stdout, /main {10}primary {3}-/)
    assert.match(localizedList.stdout, new RegExp(`feature/한글 {2}${metadata.id} {2}complete`))

    git(metadata.path, "branch", "-m", "feature/renamed")
    const info = gwt(fixture, ["info", metadata.id])
    assert.equal(info.status, 0, info.stderr)
    assert.match(info.stdout, /Branch: feature\/renamed/)
    assert.match(info.stdout, new RegExp(`WEB_PORT: ${metadata.ports.WEB_PORT}`))

    const cdFile = join(fixture.root, "cd-path")
    const switched = run(process.execPath, [cli, "switch", metadata.id], {
      cwd: fixture.repository,
      env: { ...fixture.env, GWT_CD_FILE: cdFile },
    })
    assert.equal(switched.status, 0, switched.stderr)
    assert.equal(readFileSync(cdFile, "utf8"), metadata.path)

    const removed = gwt(fixture, ["remove", metadata.id])
    assert.equal(removed.status, 0, removed.stderr)
    assert.match(removed.stdout, new RegExp(`Removing worktree ${metadata.id}\\.\\.\\.`))
    assert.equal(existsSync(metadata.path), false)
    assert.equal(metadataFiles(fixture.repository).length, 0)
    assert.match(removed.stdout, /Deleted branch: feature\/renamed/)
  })

  test("creates a scratch branch and preserves a worktree after setup failure", () => {
    const fixture = createRepository()
    mkdirSync(join(fixture.repository, "scripts"), { recursive: true })
    const hook = join(fixture.repository, "scripts", "fail-setup")
    writeFileSync(hook, "#!/bin/sh\nexit 7\n")
    chmodSync(hook, 0o755)
    writeConfig(fixture.repository, { postCreate: "scripts/fail-setup" })
    git(fixture.repository, "add", "scripts/fail-setup")
    git(fixture.repository, "commit", "-m", "Add failing hook")

    const trusted = gwt(fixture, ["trust"])
    assert.equal(trusted.status, 0, trusted.stderr)
    const created = gwt(fixture, ["new"])
    assert.equal(created.status, 1)
    assert.match(created.stderr, /Setup failed; worktree retained/)
    const [metadataFile] = metadataFiles(fixture.repository)
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8"))
    assert.equal(metadata.setup, "failed")
    assert.equal(existsSync(metadata.path), true)
    assert.match(git(metadata.path, "branch", "--show-current"), /^scratch\/[a-f0-9]{8}$/)
  })

  test("runs trusted hooks with context and allocated ports", () => {
    const fixture = createRepository()
    mkdirSync(join(fixture.repository, "scripts"), { recursive: true })
    const hook = join(fixture.repository, "scripts", "setup")
    writeFileSync(hook, [
      "#!/bin/sh",
      "set -eu",
      "printf '%s\\n' \"$GWT_ID|$GWT_BRANCH|$APP_PORT\" > hook-result",
      "cat > hook-context.json",
      "",
    ].join("\n"))
    chmodSync(hook, 0o755)
    writeConfig(fixture.repository, { ports: ["APP_PORT"], postCreate: "scripts/setup" })
    git(fixture.repository, "add", "scripts/setup")
    git(fixture.repository, "commit", "-m", "Add setup hook")

    assert.equal(gwt(fixture, ["trust"]).status, 0)
    const created = gwt(fixture, ["new", "feature/hooks"])
    assert.equal(created.status, 0, created.stderr)
    const metadata = JSON.parse(readFileSync(metadataFiles(fixture.repository)[0], "utf8"))
    assert.equal(
      readFileSync(join(metadata.path, "hook-result"), "utf8").trim(),
      `${metadata.id}|feature/hooks|${metadata.ports.APP_PORT}`,
    )
    const context = JSON.parse(readFileSync(join(metadata.path, "hook-context.json"), "utf8"))
    assert.equal(context.id, metadata.id)
    assert.deepEqual(context.ports, metadata.ports)
  })

  test("invalidates trust when hook content changes", () => {
    const fixture = createRepository()
    mkdirSync(join(fixture.repository, "scripts"), { recursive: true })
    const hook = join(fixture.repository, "scripts", "setup")
    writeFileSync(hook, "#!/bin/sh\nexit 0\n")
    chmodSync(hook, 0o755)
    writeConfig(fixture.repository, { postCreate: "scripts/setup" })
    git(fixture.repository, "add", "scripts/setup")
    git(fixture.repository, "commit", "-m", "Add setup hook")
    assert.equal(gwt(fixture, ["trust"]).status, 0)

    writeFileSync(hook, "#!/bin/sh\nprintf 'changed\\n'\n")
    git(fixture.repository, "add", "scripts/setup")
    git(fixture.repository, "commit", "-m", "Change setup hook")
    const created = gwt(fixture, ["new", "feature/trust-change"])
    assert.equal(created.status, 1)
    assert.match(created.stderr, /Project hooks are not trusted/)
    const metadata = JSON.parse(readFileSync(metadataFiles(fixture.repository)[0], "utf8"))
    assert.equal(metadata.setup, "failed")
    assert.equal(existsSync(metadata.path), true)
  })

  test("refuses dirty removal unless discard is explicit", () => {
    const fixture = createRepository()
    const created = gwt(fixture, ["new", "feature/discard"])
    assert.equal(created.status, 0, created.stderr)
    const metadata = JSON.parse(readFileSync(metadataFiles(fixture.repository)[0], "utf8"))
    writeFileSync(join(metadata.path, "dirty.txt"), "uncommitted\n")

    const safeRemoval = gwt(fixture, ["remove", metadata.id])
    assert.equal(safeRemoval.status, 1)
    assert.match(safeRemoval.stderr, /uncommitted changes/)
    assert.equal(existsSync(metadata.path), true)

    const discard = gwt(fixture, ["remove", metadata.id, "--discard", "--yes"])
    assert.equal(discard.status, 0, discard.stderr)
    assert.equal(existsSync(metadata.path), false)
    assert.match(discard.stdout, /Deleted branch: feature\/discard/)
  })

  test("explains how to delete an unmerged branch in non-interactive mode", () => {
    const fixture = createRepository()
    const created = gwt(fixture, ["new", "feature/unmerged"])
    assert.equal(created.status, 0, created.stderr)
    const metadata = JSON.parse(readFileSync(metadataFiles(fixture.repository)[0], "utf8"))
    writeFileSync(join(metadata.path, "committed.txt"), "keep branch\n")
    git(metadata.path, "add", "committed.txt")
    git(metadata.path, "commit", "-m", "Add unmerged work")

    const removed = gwt(fixture, ["remove", metadata.id])
    assert.equal(removed.status, 0, removed.stderr)
    assert.match(removed.stdout, /could not be deleted safely/)
    assert.match(removed.stdout, /Kept branch: feature\/unmerged/)
    assert.match(removed.stdout, /Delete later: git branch -D -- feature\/unmerged/)
    assert.match(git(fixture.repository, "branch", "--list", "feature/unmerged"), /feature\/unmerged/)
  })

  test("adopts a native linked worktree during setup", () => {
    const fixture = createRepository()
    writeConfig(fixture.repository, { ports: ["APP_PORT"] })
    const nativePath = join(fixture.root, "native worktree")
    git(fixture.repository, "worktree", "add", "-b", "feature/adopt", nativePath, "HEAD")

    const setup = gwt(fixture, ["setup"], { cwd: nativePath })
    assert.equal(setup.status, 0, setup.stderr)
    const metadata = JSON.parse(readFileSync(metadataFiles(fixture.repository)[0], "utf8"))
    assert.equal(metadata.path, realpathSync(nativePath))
    assert.equal(metadata.setup, "complete")
    assert.ok(Number.isInteger(metadata.ports.APP_PORT))
  })
})

describe("shell integration", () => {
  test("emits a zsh wrapper and completion without exporting ports", () => {
    const fixture = createRepository()
    const result = gwt(fixture, ["shell", "init", "zsh"])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /GWT_CD_FILE/)
    assert.match(result.stdout, /builtin cd/)
    assert.match(result.stdout, /compdef _gwt gwt/)
    assert.match(result.stdout, /__complete worktrees/)
    assert.doesNotMatch(result.stdout, /export WEB_PORT/)
  })

  test("installs zsh integration once and keeps init out of default help", () => {
    const fixture = createRepository()
    const zshDirectory = join(fixture.root, "zsh")
    mkdirSync(zshDirectory)
    const env = { ...fixture.env, ZDOTDIR: zshDirectory }

    const dryRun = run(process.execPath, [cli, "shell", "install", "zsh", "--dry-run"], {
      cwd: fixture.repository,
      env,
    })
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.equal(existsSync(join(zshDirectory, ".zshrc")), false)
    assert.match(dryRun.stdout, /eval.*gwt shell init zsh/)

    const installed = run(process.execPath, [cli, "shell", "install", "zsh", "--yes"], {
      cwd: fixture.repository,
      env,
    })
    assert.equal(installed.status, 0, installed.stderr)
    const firstContents = readFileSync(join(zshDirectory, ".zshrc"), "utf8")
    assert.match(firstContents, /gwt shell init zsh/)

    const repeated = run(process.execPath, [cli, "shell", "install", "zsh", "--yes"], {
      cwd: fixture.repository,
      env,
    })
    assert.equal(repeated.status, 0, repeated.stderr)
    assert.match(repeated.stdout, /already installed/)
    assert.equal(readFileSync(join(zshDirectory, ".zshrc"), "utf8"), firstContents)

    const help = gwt(fixture, [])
    assert.match(help.stdout, /gwt shell install zsh/)
    assert.doesNotMatch(help.stdout, /gwt shell init zsh/)
  })

  test("installs the agent skill for the user and the repository", () => {
    const fixture = createRepository()
    const home = join(fixture.root, "home")
    mkdirSync(home)
    const env = { ...fixture.env, HOME: home }
    const userSkill = join(home, ".claude", "skills", "gwt", "SKILL.md")
    const install = (...args) => run(process.execPath, [cli, "skill", "install", "claude", ...args], {
      cwd: fixture.repository,
      env,
    })

    const dryRun = install("--dry-run")
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.equal(existsSync(userSkill), false)
    assert.match(dryRun.stdout, /^name: gwt$/m)

    const installed = install("--yes")
    assert.equal(installed.status, 0, installed.stderr)
    const contents = readFileSync(userSkill, "utf8")
    assert.match(contents, /^name: gwt$/m)
    assert.match(contents, /gwt new/)

    const repeated = install("--yes")
    assert.equal(repeated.status, 0, repeated.stderr)
    assert.match(repeated.stdout, /already installed/)

    writeFileSync(userSkill, `${contents}edited\n`)
    const replaced = install("--yes")
    assert.equal(replaced.status, 0, replaced.stderr)
    assert.match(replaced.stdout, /^Replace /m)
    assert.equal(readFileSync(userSkill, "utf8"), contents)

    const project = install("--project", "--yes")
    assert.equal(project.status, 0, project.stderr)
    assert.equal(readFileSync(join(fixture.repository, ".claude", "skills", "gwt", "SKILL.md"), "utf8"), contents)

    const codex = run(process.execPath, [cli, "skill", "install", "codex", "--yes"], {
      cwd: fixture.repository,
      env,
    })
    assert.equal(codex.status, 0, codex.stderr)
    assert.equal(readFileSync(join(home, ".agents", "skills", "gwt", "SKILL.md"), "utf8"), contents)

    const codexProject = run(process.execPath, [cli, "skill", "install", "codex", "--project", "--yes"], {
      cwd: fixture.repository,
      env,
    })
    assert.equal(codexProject.status, 0, codexProject.stderr)
    assert.equal(readFileSync(join(fixture.repository, ".agents", "skills", "gwt", "SKILL.md"), "utf8"), contents)

    const unknown = run(process.execPath, [cli, "skill", "install", "cursor"], { cwd: fixture.repository, env })
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /gwt skill install <claude\|codex>/)
  })

  test("registers zsh completion and returns repository-aware candidates", () => {
    const fixture = createRepository()
    assert.equal(gwt(fixture, ["new", "feature/completion"]).status, 0)
    const metadata = JSON.parse(readFileSync(metadataFiles(fixture.repository)[0], "utf8"))

    const candidates = gwt(fixture, ["__complete", "worktrees"])
    assert.equal(candidates.status, 0, candidates.stderr)
    assert.match(candidates.stdout, new RegExp(metadata.id))
    assert.match(candidates.stdout, /feature\/completion/)
    assert.match(candidates.stdout, /main/)

    const refs = gwt(fixture, ["__complete", "refs"])
    assert.equal(refs.status, 0, refs.stderr)
    assert.match(refs.stdout, /^HEAD$/m)
    assert.match(refs.stdout, /^feature\/completion$/m)

    const binDirectory = join(fixture.root, "bin")
    const zshDirectory = join(fixture.root, "zsh")
    mkdirSync(binDirectory)
    mkdirSync(zshDirectory)
    symlinkSync(cli, join(binDirectory, "gwt"))
    const env = { ...fixture.env, PATH: `${binDirectory}:${process.env.PATH}`, ZDOTDIR: zshDirectory }
    assert.equal(run(process.execPath, [cli, "shell", "install", "zsh", "--yes"], {
      cwd: fixture.repository,
      env,
    }).status, 0)
    const initialized = run("zsh", ["-c", [
      "autoload -Uz compinit",
      `compinit -d ${join(zshDirectory, ".zcompdump")}`,
      `source ${join(zshDirectory, ".zshrc")}`,
      "whence -w gwt",
      "print -r -- $_comps[gwt]",
    ].join("; ")], { cwd: fixture.repository, env })
    assert.equal(initialized.status, 0, initialized.stderr)
    assert.match(initialized.stdout, /gwt: function/)
    assert.match(initialized.stdout, /_gwt/)
  })

  test("changes directory after creation and current-worktree removal", () => {
    const fixture = createRepository()
    const binDirectory = join(fixture.root, "bin")
    mkdirSync(binDirectory)
    symlinkSync(cli, join(binDirectory, "gwt"))
    const script = [
      'eval "$(gwt shell init zsh)"',
      "gwt new feature/shell-flow >/dev/null",
      "pwd",
      "gwt remove --keep-branch >/dev/null",
      "pwd",
    ].join("; ")
    const result = run("zsh", ["-c", script], {
      cwd: fixture.repository,
      env: { ...fixture.env, PATH: `${binDirectory}:${process.env.PATH}` },
    })
    assert.equal(result.status, 0, result.stderr)
    const paths = result.stdout.trim().split("\n")
    assert.match(paths[0], /\.worktrees\/[a-f0-9]{8}$/)
    assert.equal(paths[1], realpathSync(fixture.repository))
  })
})
