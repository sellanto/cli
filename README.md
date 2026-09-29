# `sellanto` — your store's theme, on your own computer

Edit a [Sellanto](https://sellanto.com) store's theme in your own editor, with
your own git. Uploads on save, publishes on command. One file, no dependencies,
**Node 20+**.

It touches neither a server nor the Sellanto repository — it talks to one
store's public API.

---

## Install

```bash
npm i -g github:sellanto/cli
```

Gives you a `sellanto` command.

⚠ **From the repository, not from the npm registry.** The registry is one more
place a different file could come from. `selfupdate` pulls from **the store
itself**, so the command heals itself against the API it talks to.

Without a package manager it works just as well:

```bash
export SELLANTO_TOKEN="your key"

curl -H "Authorization: Bearer $SELLANTO_TOKEN" \
  https://<your-store>/api/2026-07/tools/theme-cli/download \
  -o sellanto && chmod +x sellanto
```

Then call `./sellanto`. The tool prints its advice using whatever name you
invoked it by.

## Connect

```bash
sellanto login
```

Opens the browser, you pick the store and approve. The key is written to
`.sellanto.token` by itself and never passes through your clipboard.

⚠ **The tool prints a verification code BEFORE it opens the browser.** The
approval screen shows the same characters. If they do not match you are
approving somebody else's request — close the tab.

What the approval grants, exactly: read and write the **theme code** of the
store you picked, into a draft. It cannot see orders, customers, payments or
settings. Revoke it under **Settings → API keys**; revoking takes effect
immediately.

You do not need to know your store's technical address — the dashboard does.

<details>
<summary>How it works, if you care</summary>

A secret is generated on your machine and **never leaves the process**; only its
`sha256` travels through the browser (PKCE, RFC 7636). The store sends the
browser back to `127.0.0.1` carrying only "done", and the key travels over a
second connection, against that secret. So the URL sitting in your browser
history is not enough to obtain access.

The key is created only when the tool collects it. An approval nobody collects
leaves no live key behind.

</details>

### By hand, without a browser

A machine with no desktop (a server, a container, `ssh`) takes the older path:
**Settings → API keys → new key**, scope **"Write · Theme code"**
(`write_theme_code`), then:

```bash
export SELLANTO_TOKEN="your key"
sellanto init --api https://<your-store>
```

⚠ `write_theme_code` is a **separate scope**. The older "Write · Content"
(`write_content`) does NOT grant theme code — a key issued to sync a blog must
not be able to inject JavaScript into the storefront. This applies to existing
keys too: permissions are recomputed on every request.

Two more things are required: whoever issues the key must hold the
`themes.edit_code` permission, and the store's plan must include the code editor
(the trial does not).

## The working cycle

```bash
sellanto login       # browser: pick a store and approve
sellanto pull        # the theme + .sellanto/THEME-REFERENCE.md + AGENTS.md

sellanto watch       # uploads on every save
sellanto preview     # the URL where it shows
sellanto publish     # only now do customers see it
```

## Start from a shipped theme

Every theme the platform offers generally is downloadable and editable — that
is what "ready" means in the list. So the way to start from a finished design is
not to copy files out of a screenshot:

```bash
sellanto themes      # what this account may edit
sellanto use kometa  # switch to one of them
sellanto pull        # its delivered files land in this folder
```

Overrides are stored per (store, theme) pair, so a theme can be **prepared
before it is switched on** from the admin.

⚠ **Preview only works for the active theme** — the preview key is bound to the
pair, while the storefront renders the store's own theme. The tool says so when
it applies.

---

## The three things that surprise people

### Uploading is not publishing

`watch` writes to a **draft**. The storefront shows it only at the URL from
`preview`; customers keep seeing the old version until you say `publish`.

That is deliberate: a file watcher sends one state per `Ctrl+S`, including the
half-written template. Saving from the admin screen IS publishing, because there
it is one considered press on one file.

⚠ `publish` releases **all** the draft's files at once. A theme changes in
related files — a new section wants the template that calls it and the style
that draws it; released one by one, there is a moment between the first and the
third with half a change in front of customers.

### The theme is Twig in a sandbox

Only what `.sellanto/THEME-REFERENCE.md` lists works. Things that work in
ordinary Twig are absent: `|upper`, `|raw`, `source()`, `constant()`, `range`,
the `..` operator. So is calling a method on any object.

⚠ **What is forbidden does not fail on upload — it fails on render.** A file
with `|upper` passes validation and then the section simply does not draw. If
something vanishes from the page with no error, look first for a name that is
not in the reference.

The reference is generated from the platform's own code and refreshed on every
`pull`. Do not edit it.

### Checkout is not editable

The checkout layout, its pieces and `templates/checkout.json` are read-only,
whatever the key is allowed to do. A broken home page is an inconvenience; a
broken checkout is orders that do not happen, and it shows up only when somebody
looks at revenue.

## When something goes wrong

```bash
sellanto diff                     # which files have I touched
sellanto diff sections/hero.twig  # what exactly, line by line
sellanto versions sections/hero.twig
sellanto restore sections/hero.twig --version 3 --publish
```

Every publish leaves a trace — the same history the admin's editor keeps.
`restore` without `--version` goes back to the theme's **delivered** file.

`conflicts` tells you which of your files are copies of a file the platform has
changed since — a fix in the theme does not reach your copy, and there is no
other way to find out.

## For Claude Code, Cursor and other assistants

`pull` writes an **`AGENTS.md`** into the folder: the rules that are not
obvious, the commands, the limits, and the mistakes that fail silently. Coding
assistants read that file on their own, so an agent working in this folder
starts out knowing that `|upper` uploads cleanly and then renders nothing.

Three commands speak JSON, so nothing has to parse prose:

```bash
sellanto status --json
sellanto themes --json
sellanto conflicts --json
```

⚠ Under `--json` the payload goes to **stdout** and every human sentence to
**stderr**, so `sellanto status --json | jq` is safe.

⚠ `sellanto push` exits non-zero when a file is refused, so `push && publish`
is safe to write in a script. Refusals carry the line number.

## Limits

| | |
|---|---|
| one file | 512 KB |
| own files per theme | 200 |
| path length | 191 characters |
| one batched request | 60 files / 4 MB |
| API requests | 40 per minute per account |

That last row is why `pull`, `push` and `watch` work in batches: one theme is
~105 files, so one file per request means the first step cannot finish. On
hitting the ceiling the tool waits out `Retry-After` and carries on.

**Binary files** (`.woff2`, `.png`) do not travel through this channel — they
are uploaded as media from the admin. This folder is not a complete copy of the
theme.

## Updating

The tool checks for a new version once a day and **says so**; it updates with
`sellanto selfupdate`. It does not update itself by default, because here code
from the network becomes code on your machine — for hands-off updates put
`"autoUpdate": true` in `.sellanto.json`.

⚠ A global install may not be writable by `selfupdate`. It says so, and the
update is then `npm i -g github:sellanto/cli`.

The version is a date (`2026-09-29`), with `.N` for a second fix on the same day.

## Revoking access

Delete the key from the same screen. It stops immediately: permissions are
computed on every request, not stored on the key's row. Files already published
stay — bring them back with `restore` or from the admin's editor.

## Verifying this file

Every store serves the client itself, at
`GET /api/{version}/tools/theme-cli/download`. This repository exists so you can
read the code before running it, and check that the file your store served you
is byte for byte the file published here:

```bash
sha256sum sellanto-theme.mjs

curl -sH "Authorization: Bearer $SELLANTO_TOKEN" \
  https://<your-store>/api/2026-07/tools/theme-cli | grep -o '"sha256":"[^"]*"'
```

The two must match. If they do not, stop and ask — something between you and the
store is changing responses.

## Licence and checks

MIT — see [LICENSE](LICENSE).

`npm test` (see [check.mjs](check.mjs)) checks what this folder promises: that the version in `package.json`
and the version in the script have not drifted apart, that there are no
dependencies, that the command is called `sellanto`, and that the tool starts.
Its behaviour against a real API is tested in the Sellanto monorepo.

Issues and questions are welcome.
