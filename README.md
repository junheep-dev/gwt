# gwt

`gwt` is a lightweight wrapper around native Git worktrees. It creates an
isolated worktree, prepares project-defined local files and ports, and provides
safe commands for navigating and removing worktrees.

It uses Node.js built-ins and Git. There are no runtime package dependencies.

## Install

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
confirmation. The integration also provides Zsh completion for commands,
options, worktrees, and Git refs. It only changes directories; it does not load
environment variables or run project hooks.

## Project configuration

Commit an optional `.worktree.json` at the repository root:

```json
{
  "base": "origin/main",
  "worktreeDirectory": ".worktrees",
  "copyFiles": [
    "apps/server/.env",
    "apps/web/.env"
  ],
  "ports": [
    "WEB_PORT",
    "SERVER_PORT"
  ],
  "postCreate": "./scripts/worktree-setup",
  "preRemove": "./scripts/worktree-cleanup"
}
```

All fields are optional. Without a config, worktrees are created beneath
`.worktrees`, use the primary worktree's current commit as their base, and run
no setup actions.

- `base`: Git revision used when `--base` is omitted.
- `worktreeDirectory`: Repository-relative directory for managed worktrees.
- `copyFiles`: Ignored local files copied from the primary worktree without
  overwriting an existing destination.
- `ports`: Environment variable names assigned stable ports in the range
  20000–39999.
- `postCreate`: Repository-relative executable run after files and ports are
  prepared.
- `preRemove`: Repository-relative executable run before removal.

The worktree directory is added to `.git/info/exclude`; tracked project files
are not modified.

## Hooks

Hooks receive JSON context on stdin and these environment variables:

```text
GWT_ID
GWT_PATH
GWT_PRIMARY_PATH
GWT_BRANCH
<each name declared in ports>
```

Example `postCreate` hook:

```sh
#!/bin/sh
set -eu

printf 'PORT=%s\n' "$SERVER_PORT" >> apps/server/.env
pnpm install --frozen-lockfile
```

Project hooks require explicit trust because they execute repository code:

```sh
gwt trust
```

Approval is invalidated when `.worktree.json` or either hook changes.

## Commands

```sh
gwt new [branch] [--base <ref>] [--no-hooks]
gwt setup [id|branch|path] [--no-hooks]
gwt list
gwt switch [id|branch|path]
gwt info [id|branch|path]
gwt remove [id|branch|path] [--keep-branch|--discard] [--yes] [--no-hooks]
gwt trust [--revoke]
gwt shell install zsh [--dry-run] [--yes]
```

`gwt new` creates `scratch/<id>` when no branch is provided. The immutable ID,
assigned ports, and setup status are stored under the repository's common Git
directory at `.git/gwt/worktrees/`.

Setup failures retain the worktree and record the failure. Retry with
`gwt setup <id>` or remove it explicitly.

Run `gwt switch` without a target to open the interactive picker. Use the
arrow keys, `j`/`k`, or Ctrl-n/Ctrl-p to move; press 1–9 to select a numbered
row immediately; or press `/` to filter by branch, ID, or path. Enter switches
to the selected worktree. Escape leaves filter mode or cancels the picker.

`gwt remove` refuses dirty worktrees. It removes the branch only when
`git branch -d` considers the deletion safe. `--discard --yes` explicitly
allows dirty worktree removal and forced branch deletion.
