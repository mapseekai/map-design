# Saved API model configurations

Settings → Runtime → API Model manages independently named API profiles. Each
profile binds a protocol, response format, base URL, model ID and optional local
credential. Up to 32 provider configurations can be stored. The existing legacy
`byokProviders.default` entry appears automatically; no credential re-entry is
required to keep using that configuration.

## Save and verify

Use **Add model**, enter its name and connection settings, then **Save model**.
The saved card remains visible after reload, and the editor explicitly reports
saved or unsaved state; a new blank entry is never labelled saved. General **Save settings** does not silently save an API
profile; it is disabled while a profile contains unsaved changes.

**Test connection** is an explicit action on a saved profile. It sends one small
model request through the same SDK provider, with a 512-token output budget,
no automatic retries and a 30-second deadline. It may incur provider charges.
The saved result contains the time, latency and safe failure code; no response
body, secret or raw provider error is exposed. It verifies a basic text response,
not support for every map tool, image input or future availability.

Editing model, endpoint, protocol or credential invalidates a previous test;
renaming alone does not. A result from an obsolete configuration is never stored
against its replacement. Closing settings aborts a pending test. Concurrent tests
and repeated clicks are bounded.

## Select a model

**Set as default** changes the default API profile for new/default selections and
sets the default runtime to API Model. Project creation exposes the saved API
models after choosing API Model. The conversation runtime picker displays the
same named profiles and persists the selection for that conversation. Saving an
implicit default selection pins its profile ID, so changing the global default
does not redirect that conversation. Legacy model-only selections resolve only
to a matching saved configuration, never an unrelated default model.

Two profiles can use the same remote model ID with different endpoints or keys.
They use stable internal profile IDs, not model names, for selection. A map run
captures its selected provider at admission; later edits, default changes or
profile deletion do not redirect an in-flight task. Persisted run provenance
records the actual remote model ID, not the internal selection ID.

## Credentials and deletion

API keys remain daemon-owned configuration with restrictive file permissions.
The browser receives a saved-key indicator, never the stored value. Leave the
key input blank to retain it. Changing an endpoint or protocol with a stored key
requires explicit key re-entry. Keyless local compatible endpoints can disable
**API key required**.

Deletion requires confirmation and removes that configuration and its stored
key. Deleting the active profile clears the default rather than silently choosing
another account. Conversations pinned to a deleted profile must explicitly
select another model; they never fall back to a different saved credential.
A missing profile leaves the conversation readable and the model picker usable,
but blocks new sends until another configuration is explicitly selected.
Other configurations, conversation history and map drafts remain unchanged.

Keyless configurations are shown without a saved-key indicator. Switching an
existing entry to a keyless endpoint explicitly removes its stored credential.
Returning focus to Settings refreshes saved cards without issuing a model test;
unsaved edits are not overwritten by that passive refresh.

## Verification

Unit tests cover persistence, legacy entries, secret handling, separate provider
routing, test-result invalidation, default switching and deletion. The browser
workflow test uses the shared isolated daemon/web lifecycle and a local model
fixture, not paid model APIs:

```sh
pnpm --dir e2e exec playwright test -c playwright.config.ts ui/api-profile-settings.test.ts --workers=1
```


For browser-to-daemon routing acceptance, enable the public map import smoke
case. Both model endpoints remain local fixtures; it covers distinct credentials
for identical remote model IDs, conversation switching, persistence after reload,
and deletion followed by explicit recovery:

```sh
MAP_DESIGN_EXTERNAL_SMOKE=1 pnpm --dir e2e exec playwright test -c playwright.config.ts ui/api-profile-settings.test.ts --workers=1
```
