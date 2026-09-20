# OpenFreeMap bright Skill fixture

English | [中文](README.zh-CN.md)

This directory contains non-normative test data for the `data-profile` Skill. It
is not a core cartography.md example, a `CARTOGRAPHY.md` contract, or a profile
that has passed core validation.

The fixture uses the public [OpenFreeMap "bright"](https://tiles.openfreemap.org/styles/bright)
style, a production OpenMapTiles basemap. The integration test reads the local
style only: it does not fetch TileJSON, vector tiles, fonts, or sprites, and it
does not require live network access.

## Deterministic profile

`DATA_PROFILE.json` is the fixed-timestamp output of style discovery:

```bash
pnpm --filter @cartographymd/data-profile-skill profile -- \
  --style skills/data-profile/fixtures/openfreemap-bright/style.json \
  --observed-at 2026-08-29T00:00:00Z \
  --output skills/data-profile/fixtures/openfreemap-bright/DATA_PROFILE.json
```

Run the command from the repository root. All relative CLI paths resolve from
that original invocation directory, not the private package directory. Because the run observes
only the style, its evidence is `style-inferred`; field domains and actual tile
contents remain explicit unresolved items. The committed output is an expected
test fixture, not an assertion that it completely describes OpenMapTiles data.

## Files

- `style.json` — the locally retained OpenFreeMap bright style used as discovery input;
- `DATA_PROFILE.json` — deterministic expected output used by `tests/openfreemap.test.ts`;
- `THIRD_PARTY_LICENSES.md` and `THIRD_PARTY_LICENSES.zh-CN.md` — colocated license and attribution notices for the retained style.

Rendering the style itself still requires network access to
`tiles.openfreemap.org` for tiles, fonts, and sprites; the fixture test never
renders it.

## Licenses

`style.json` is upstream OpenFreeMap / OSM Bright work, redistributed here with
modifications under MIT (OpenFreeMap), BSD-3-Clause (style code), and CC BY 4.0
(style design). See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)
(中文：[THIRD_PARTY_LICENSES.zh-CN.md](THIRD_PARTY_LICENSES.zh-CN.md)).
