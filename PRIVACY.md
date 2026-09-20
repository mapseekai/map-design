# Privacy

MapDesign is local-first. The daemon stores projects, drafts, revisions, configuration, logs, and agent runtime state in `MAP_DESIGN_DATA_DIR` (or `.map-design` in the working directory when it is unset). Keep that directory under your control.

## Data egress

The daemon retains project, file, map, prompt, brief, conversation, revision,
validation, preview, run, configuration, log, and local-agent state under its
local data root. When you start an agent run, the selected local agent or BYOK
provider receives the prompt and the MapDesign project context needed for that
run, including the relevant map and file data. Its provider receives that data
under its own service terms; provider credentials are configured locally and
are not sent to MapDesign.

When you import or preview a public map source, MapDesign fetches that source
from its provider. That provider receives the normal request needed to serve
it. The local agent CLI is an independent process and can make whatever
network requests its own configuration and user-level permissions allow.
Review the applicable provider policies before using sources or agents you do
not operate.

## Telemetry

MapDesign does not send product telemetry. It does not collect project, file,
map, prompt, brief, credential, map-source, or usage-analytics data for a
MapDesign-operated telemetry service. Credentials and local state stay local
unless you explicitly configure a provider or another local agent to use them.

Delete local state by removing the data directory after stopping local processes.