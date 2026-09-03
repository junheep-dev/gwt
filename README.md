# gwt

`gwt` is a lightweight wrapper around native Git worktrees. It creates an
isolated worktree, prepares project-defined local files and ports, and provides
safe commands for navigating and removing worktrees.

It uses Node.js built-ins and Git. There are no runtime package dependencies.

## Install

Requires Git and Node.js 22.12 or later.

```sh
npm install --global @junheep/gwt
```

To install directly from a source checkout instead:

```sh
chmod +x bin/gwt.mjs
ln -s "$PWD/bin/gwt.mjs" ~/.local/bin/gwt
```

Install the Zsh integration once so `gwt new`, `gwt switch`, and removal of the
current worktree can change the current shell's directory:

```zsh
gwt shell install zsh
```

The installer shows the line it will add to `~/.zshrc` and asks for
confirmation. The integration also provides Zsh completion, which lists one
row per worktree and completes worktree IDs as well as the branch names it
shows. It also automatically loads assigned ports and configured environment
variables when Zsh enters a managed worktree. Previous values are restored
when Zsh leaves it. Normal environment synchronization produces no output.

## Coding agents

Coding agents do not know about `gwt` and reach for `git worktree add`, which
skips the copied files, assigned ports, and setup hooks. Install a skill that
tells them otherwise:

```sh
gwt skill install claude
gwt skill install codex
```

The installer shows the target path and asks for confirmation before writing.
Both agents read the same `SKILL.md` format and differ only in location, so
the installed skill is identical:

| Agent  | Default                        | With `--project`             |
| ------ | ------------------------------ | ---------------------------- |
| Claude | `~/.claude/skills/gwt/SKILL.md` | `.claude/skills/gwt/SKILL.md` |
| Codex  | `~/.agents/skills/gwt/SKILL.md` | `.agents/skills/gwt/SKILL.md` |

`--project` writes into the primary worktree so the skill can be committed for
the team.

The skill covers what the help does not: when to prefer gwt over native
`git worktree`, which commands are destructive, and the traps worth knowing. It
points at `gwt <command> --help` for command details rather than repeating
them. Reinstall after upgrading gwt to pick up a revised skill.

## Configuration

Create user configuration for the current repository:

```sh
gwt config create
```

This adds a project entry to `~/.config/gwt/config.json`, or
`$XDG_CONFIG_HOME/gwt/config.json` when `XDG_CONFIG_HOME` is set. Projects use
the primary remote as their identifier, such as `github.com/owner/repository`.
Repositories without a remote use their canonical path.

```json
{
  "projects": {
    "github.com/owner/repository": {
      "copyFiles": [
        "apps/server/.env",
        "apps/web/.env"
      ],
      "ports": [
        "WEB_PORT",
        "SERVER_PORT"
      ],
      "env": {
        "NEXT_PUBLIC_API_ENDPOINT": "http://127.0.0.1:${SERVER_PORT}"
      },
      "postCreate": "hooks/worktree-setup",
      "preRemove": "hooks/worktree-cleanup"
    }
  }
}
```

User configuration is the default and does not change the repository. If
the setup should be committed and shared, create `<repository>/.gwt.json`
instead:

```sh
gwt config create --project
```

If user configuration exists for the repository, its non-hook fields are copied
into the new project file. User hooks are omitted because their paths use a
different base directory. Otherwise, the command creates a default scaffold.
The project file contains the configuration fields directly:

```json
{
  "base": "origin/main",
  "copyFiles": [
    "apps/server/.env",
    "apps/web/.env"
  ],
  "ports": [
    "WEB_PORT",
    "SERVER_PORT"
  ],
  "env": {
    "NEXT_PUBLIC_API_ENDPOINT": "http://127.0.0.1:${SERVER_PORT}"
  },
  "postCreate": "./scripts/worktree-setup",
  "preRemove": "./scripts/worktree-cleanup"
}
```

When `.gwt.json` exists, it takes precedence over the user project entry.
The two files are not merged. Run `gwt config show` to see whether user and
repository configuration is available, the location of each existing config
file, the active source, and its resolved value.

All fields are optional. Without either config, worktrees are created outside
the repository beneath `~/.gwt/worktrees`. Set `GWT_HOME` to an absolute path
to use a different gwt home directory. A repository normally uses a directory
named after it. If another repository already uses that name, gwt adds a short
hash derived from the canonical path. Worktrees use the primary worktree's
current commit as their base and run no setup actions.

- `base`: Git revision used when `--base` is omitted.
- `worktreeDirectory`: Optional repository-relative directory for managed
  worktrees. Setting it opts out of the external default.
- `copyFiles`: Ignored local files copied from the primary worktree without
  overwriting an existing destination.
- `ports`: Environment variable names assigned stable ports in the range
  20000–39999.
- `env`: Environment variables loaded alongside assigned ports. Values are
  literal strings with optional `${PORT_NAME}` references to names declared in
  `ports`. Shell expressions and references to arbitrary process variables are
  not evaluated.
- `postCreate`: Executable run after files and ports are prepared.
- `preRemove`: Executable run before removal.

An explicitly configured repository-relative worktree directory is added to
`.git/info/exclude`; tracked project files are not modified.

For example, an existing configuration can retain the previous in-repository
layout explicitly:

```json
{
  "worktreeDirectory": ".worktrees"
}
```

## Hooks

Hooks receive JSON context on stdin and these environment variables:

```text
GWT_ID
GWT_PATH
GWT_PRIMARY_PATH
GWT_BRANCH
<each name declared in ports>
<each name declared in env>
```

Example `postCreate` hook:

```sh
#!/bin/sh
set -eu

printf 'PORT=%s\n' "$SERVER_PORT" >> apps/server/.env
pnpm install --frozen-lockfile
```

Hook paths in user config are resolved relative to the directory containing
`config.json`; hook paths in `.gwt.json` are resolved relative to the target
worktree. Both run with the target worktree as their working directory, and
their standard output and errors are streamed directly to the terminal.

User configuration is trusted because the user added it directly. Ports and
environment variables from a committed `.gwt.json` require explicit trust
because they automatically change the shell; repository hooks require the same
approval because they execute code:

```sh
gwt trust
```

Approval is invalidated when `.gwt.json` or either hook changes. `gwt remove`
asks for approval only when `preRemove` is configured, because removal applies
nothing else from the configuration.

## Commands

```sh
gwt new [branch] [--base <ref>] [--no-hooks] [--background]
gwt setup [id|branch|path] [--no-hooks] [--background]
gwt list
gwt ls
gwt switch [primary|id|branch|path] [--create]
gwt info [primary|id|branch|path]
gwt remove [id|branch|path] [--keep-branch|--discard] [--yes] [--no-hooks]
gwt prune [--dry-run] [--yes]
gwt trust [--revoke]
gwt config create [--project]
gwt config show
gwt shell install zsh [--dry-run] [--yes]
gwt skill install <claude|codex> [--project] [--dry-run] [--yes]
```

Run `gwt --help` for the overview, or `gwt <command> --help` for arguments,
options, behavior, and examples. Nested commands such as `gwt config create
--help` have their own help.

What the listing does not show:

- **Branches.** `gwt new` without an argument creates `scratch/<id>`. With one,
  it reuses an existing local branch, or creates a branch tracking the remote
  when the name exists on exactly one remote; `--base` always means "new
  branch". `gwt switch <branch>` offers to create a worktree for a branch that
  has none, and `--create` skips the question when running non-interactively.
- **Background setup.** `--background` detaches `postCreate` and returns once
  files are copied and ports assigned, logging to `.git/gwt/logs/<id>.log`.
  `gwt list` reports the worktree as `running`, or `interrupted` if the process
  disappears.
- **Cleanup.** `gwt remove` also deletes the `scratch/<id>` branch a worktree
  moved off, but only when the branch it moved to already contains those
  commits. `gwt prune` clears records left by worktrees removed outside gwt,
  including their scratch branches; it reports what it found and asks first.
- **State.** IDs, assigned ports, and setup status live in
  `.git/gwt/worktrees/`. `gwt info` prints a worktree's ports and environment
  exactly as the shell integration loads them.
