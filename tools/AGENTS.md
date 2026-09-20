# Tools

`tools-dev` is the local lifecycle command for daemon, web, and desktop. `tools-pack` builds and controls local installers for `mac`, `win`, and `linux`.

Use `pnpm tools-dev start|status|logs|stop|check` for development processes. Use `pnpm tools-pack <mac|win|linux> <action>` for packaging commands. Keep orchestration code on shared local-process primitives and keep tool tests in each tool's `tests/` directory.