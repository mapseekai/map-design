# MapDesign quickstart

## Requirements

Use Node.js 24, Corepack, and the pnpm version selected by `package.json`.

```bash
corepack enable
pnpm install
pnpm tools-dev start
pnpm tools-dev status
```

`tools-dev` starts local daemon, web, and desktop processes. Stop them with `pnpm tools-dev stop`; inspect logs with `pnpm tools-dev logs`.
Install and authenticate at least one supported local coding-agent CLI before
creating a project. After the daemon starts, list the detected agent IDs:

```bash
MAP_DESIGN_DAEMON_URL=http://127.0.0.1:7456 md agents list --json
```

The example below uses `codex`; replace it with a detected agent ID when Codex
CLI is not installed and configured.

## Create a map project

Start the local runtime, then point `md` at the daemon. `--prompt-file -` reads
the initial brief from standard input:

```bash
printf '%s\n' 'Create an accessible base map with a restrained color palette.' \
  | MAP_DESIGN_DAEMON_URL=http://127.0.0.1:7456 md project create \
      --name "City base map" \
      --source-url "https://demotiles.maplibre.org/style.json" \
      --runtime codex \
      --prompt-file -
```

`MAP_DESIGN_DAEMON_URL` may instead be supplied as
`--daemon-url http://127.0.0.1:7456`. The required create options are
`--name`, `--source-url`, `--runtime`, and `--prompt-file`; `--model`,
`--reasoning`, and `--service-tier` are optional. Run `md --help` for the
top-level command list.

In the Web Home screen, enter **Project name**, **Public map URL**, and
**Design requirement**; select a **Local agent**; select **Check source**;
then select **Create project** once preflight succeeds. Desktop Home also
offers **Choose working directory**.

## Local data

Set `MAP_DESIGN_DATA_DIR` before starting the daemon to choose its data root. It contains daemon-owned SQLite data, configuration, logs, projects, and agent state. Do not share it between unrelated local runs.

## Check changes

```bash
pnpm guard
pnpm typecheck
```

Run the focused package test for changed behavior.