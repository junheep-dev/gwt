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

The skill covers what `gwt --help` does not: that gwt is preferred over native
`git worktree`, that project hooks need `gwt trust`, that a failed setup is
retried rather than recreated, that ports come from `gwt info`, and that
removal is destructive. It points at `gwt <command> --help` for command
details instead of repeating them, so it does not go stale as gwt changes.
Reinstall after upgrading to pick up a revised skill; an unchanged file is
reported as already installed, and a modified one is replaced only after
confirmation.

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

Run `gwt --help` for the command overview, or `gwt <command> --help` for
behavior, options, and practical examples. Nested commands such as
`gwt config create --help` have their own help as well.

`gwt new` creates `scratch/<id>` when no branch is provided. The immutable ID,
assigned ports, and setup status are stored under the repository's common Git
directory at `.git/gwt/worktrees/`.

`gwt new <branch>` reuses an existing local branch, creates a local branch
tracking the remote when the name exists on exactly one remote, and otherwise
creates a new branch from the configured base. `--base` always means "new
branch", so it is rejected for a branch that already exists locally. A branch
already checked out in another worktree is reported with its path.

Setup failures retain the worktree and record the failure. Retry with
`gwt setup <id>` or remove it explicitly.

`gwt new --background` and `gwt setup --background` copy files, assign ports,
and ask for configuration approval before returning, then run `postCreate` in a
detached process, so an integrated shell enters the worktree immediately.
Output goes to `.git/gwt/logs/<id>.log`. `gwt list` shows the worktree as
`running` until the hook finishes. A job whose process disappears is reported
as `interrupted` and can be retried with `gwt setup <id>`. `--background` cannot be combined with `--no-hooks`, and a
worktree cannot be set up or removed while its background setup is running.

`gwt ls` is an alias for `gwt list`.

When `gwt switch` is given a branch that has no worktree, it offers to create
one, reusing an existing branch or tracking a remote one just like `gwt new`.
`--create` skips the question, which is required when running non-interactively.

Run `gwt switch` without a target to open the interactive picker. Use the
arrow keys, `j`/`k`, or Ctrl-n/Ctrl-p to move; press `/` to filter by branch,
ID, or path. Enter switches to the selected worktree. Escape leaves filter
mode or cancels the picker. `primary` is a reserved ID for the repository's
primary worktree, so `gwt switch primary` returns to it from any linked
worktree.

`gwt remove` refuses dirty worktrees and first tries to delete the branch with
`git branch -d`. If Git rejects safe deletion, an interactive terminal asks
whether to force-delete the branch; non-interactive use keeps it and prints a
command for deleting it later. `--discard --yes` explicitly allows dirty
worktree removal and forced branch deletion.

A worktree created without a branch argument records its `scratch/<id>` branch.
If the worktree later moved to another branch, removal deletes that leftover
scratch branch when the branch it moved to already contains every scratch
commit, so nothing is lost. This is the usual `git checkout -b` case, which
`git branch -d` alone would refuse because the commits are not on the primary
branch. A scratch branch holding commits that were left behind is kept and
reported instead. `--keep-branch` keeps it either way.

`gwt prune` cleans up after worktrees that are already gone: registrations
whose directory was deleted by hand, metadata and setup logs with no worktree
left, and the `scratch/<id>` branch such a worktree recorded. It reports what
it would do and asks first, so running it bare is safe. A scratch branch is
deleted only when another local or remote branch already contains its commits;
one holding commits nothing else contains is reported and kept. Branches gwt
did not create are never touched.
