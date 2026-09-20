# tools-pack

`tools-pack` builds and controls local MapDesign installers.

```bash
pnpm tools-pack mac build
pnpm tools-pack win build
pnpm tools-pack linux build --to appimage
```

Each platform accepts `build`, `install`, `start`, `stop`, `logs`, `uninstall`, `cleanup`, and `inspect` actions as supported by `tools-pack --help`. Keep packaging resources in `tools/pack/resources` and keep daemon data under `MAP_DESIGN_DATA_DIR`.

## Automated releases

The repository version is the desktop release version. Push a matching `v<version>` tag to run `.github/workflows/release.yml`; for example, version `0.1.0` is released from tag `v0.1.0`. The workflow validates the tag, runs release-source checks, builds portable macOS DMG/ZIP, Windows NSIS/ZIP, and Linux AppImage artifacts, generates SHA-256 checksums, and creates the GitHub Release. It can also be rerun manually with an existing tag through `workflow_dispatch`.

For a signed macOS release, configure `MACOS_CERTIFICATE` (the certificate value accepted by electron-builder `CSC_LINK`) and `MACOS_CERTIFICATE_PASSWORD`. Notarization is enabled when signing is configured and either `APPLE_NOTARY_KEYCHAIN_PROFILE` (optionally `APPLE_NOTARY_KEYCHAIN`) or all of `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` are available. Without signing secrets, the workflow still produces unsigned macOS artifacts.

```bash
git tag v0.1.0
git push origin v0.1.0
```
