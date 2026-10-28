# Opt-in local tools

These tools require a repository checkout; they are not included in the installed
plugin archive. Loading that checkout starts the gateway on `127.0.0.1` port
`4175` (`QUARTERMASTER_LOCAL_UI_PORT`). Set `QUARTERMASTER_LOCAL_UI=0` to keep
it from starting. A port that is already accepting connections is left as it is.
The process a checkout load starts stops when that host exits.
Startup does not open a browser and does not start an OpenCode server. It uses
the loaded project's directory and the existing loopback service credentials.
An installed archive has no page to serve, so it does not start the gateway.

## Reports and local gateway

Open `index.html` to import a saved report without a server. The dashboard has four
bookmarkable views: **Overview**, **Plans**, **Providers & models**, and **Quota**.
For live information and explicit configuration editing, use the local gateway. A checkout load starts it. It stays bound
to one configured project; it does not follow active-project switches.

From the repository root, configure these environment variables:

| Variable | Value |
| --- | --- |
| `OPENCODE_URL` | Existing server URL using `127.0.0.1`, such as `http://127.0.0.1:4096`. Optional when the local OpenCode service registration is present. |
| `OPENCODE_TOKEN` | That server's local-service password; keep it out of shared history. Optional when the registration includes it. |
| `QUARTERMASTER_PROJECT_DIR` | Absolute directory of the intended project |
| `QUARTERMASTER_LOCAL_UI_PORT` | Optional gateway port; defaults to `4175` |

A checkout load stops its gateway when that host exits. `npm run local-ui` can start it manually and leaves that process running until you stop it. Unless `QUARTERMASTER_LOCAL_UI_OPEN_BROWSER=0`, the manual start opens the plans view. Open the printed loopback URL. Opening Quota reads the provider-quota snapshot once; **Refresh quota** reads it again. Opening Providers & models reads the catalog once; **Refresh catalog** reads it again. Catalog entries are metadata, not proof that a provider is connected or
authenticated. A page opened as a file does not fetch. These reads do not run inference or recovery
probes. Status reads may read quota sources; quota timestamps identify freshness,
and rereading does not guarantee new observations. Stop a manual gateway when finished.
It does not start an OpenCode server.

**Working offline? Import a report** is a secondary control on Overview. It reads
the report in the browser and displays partial telemetry and routing information;
it does not invent catalog entries or account quota from that report.

Overview also has a **Sessions ledger**: one row per root session, with its
subagents rolled in and identified by a hashed session key rather than a session
id, sorted by host-reported USD and limited to 25 rows. A root with any missing
step cost stays **unknown** and sorts after the priced rows. When more exist,
the page says how many are not listed. Each row shows messages, that host cost,
observed tokens, cache hit rate (cache read divided by cache read plus cache
write), the child sessions' share of tokens and host cost, cached share,
context occupancy as a bar with a percentage (or **unknown**), a character
split of the session's current context (user, assistant, tool, other), model,
and last seen in local time. The cache-hit title splits cache writes into the
first write after a compaction in that session and every other write. It does
not guess any other cause. The **24h**,
**7 days**, **30 days**, and **All** buttons reload the dashboard for that range
and keep the choice in the URL hash. If the reload fails, the previous snapshot
stays and the status line says so. **Export usage CSV** saves the rows shown,
plus the raw token fields, the host-reported step cost, the cache hit rate and
write split, the child share, and the character split, as a file from the
browser; it makes no request. The **Estimated cost** stat
prefers the host's own per-step USD total and says when steps have no figure;
the catalog estimate is the fallback. **Plugin-reported calls**
lists counts a plugin submitted for a request that never became a host step.
Those rows stay separate from the session total. **Compaction by model** lists
the summarizer's own tokens beside the model that ran the compaction and that
model's context window. Those counts stay out of the session total, cost, and
budgets. In Settings, a budget
with a USD limit shows used, limit and remaining. If the cost cannot be fully
priced, it says unknown instead of a number. Budgets always count all history,
whatever range is selected. Token-only budgets read as before.

The gateway listens on IPv4 loopback and accepts only a `127.0.0.1` upstream. It
keeps credentials server-side, using Basic `opencode:<token>` authentication.
It validates the fixed directory's project ID and rejects mismatched reports.
Its routes are limited to dashboard/catalog reads, reports and project-options load/apply, not arbitrary
proxy requests.

**Use only on a trusted machine.** Other local processes or users can access
these reads and writes. Do not forward the port or put credentials in the
browser. Reports and options are sensitive. Reports are read-only, but explicit
**Apply plans** can write the winning settings file through the server-side
writer; it does not switch active session models.

## Live options editing

Opening Plans or Providers & models through the local gateway loads the winning settings file.
Opening Providers & models also reads the provider catalog, and the provider list stays visible when the window is narrow.
Choose **Load plans** to read it again. Each plan is an ordered chain. The model id and
the variant are separate fields, and earlier models are tried first. Filter plans by
name or model, and group them with categories kept in this browser. Category
headings start collapsed. Expand a heading to show the plans under it during
the session, and both plans and category headings can be dragged by their `⋮⋮` handle to reorder;
the heading arrows move a category without a mouse. Dropping a plan on another
plan moves it before that plan, and dropping one on a category heading puts it
at the end of that category and assigns it there. Choosing a category in the
filter shows that group. Categories do
not change routing or the saved file. The page uses four tabs — Plans holds the chains, Agent bindings holds the agent bindings, Modules holds each module's own ordered chain with its module and per-model cooldowns. Modules use the same browser-only category panel as Plans: filter, collapsed headings, and a create row under New category. Those categories do not change the saved file, and Settings holds the cooldown floor and the configuration summary — and all panels stay in the page while you edit. Each agent binding is a text field that opens a dropdown of existing plan names. Typing filters that dropdown. A name that is not listed yet stays marked until that plan exists. Agents can be grouped with categories kept in this browser, separate from plan categories. Those headings start collapsed. Expand a heading to show the agents under it during the session, and both agents and category headings can be dragged by their `⋮⋮` handle to reorder; the heading arrows move a category without a mouse. Dropping an agent on another agent moves it before that agent, and dropping one on a category heading puts it at the end of that category and assigns it there. Choosing a category in the filter shows that group. Agent categories do not change routing or the saved file. Work-type bindings are not edited on this page; a loaded file still keeps them.

Shared pools and recovery probes stay on Providers & models, below the catalog. They edit the same draft and are saved by Apply on Plans.

The provider list and the Browse provider menu are at the top of that page on every window width. After a catalog loads, the browser opens the first provider and remembers your selection across
catalog refreshes. Choose a provider in the list or the menu, or choose
**All providers** for catalog-wide search. Names, full model IDs, and exact variant
IDs are searchable; counts distinguish matching models from the provider total.
All model rows start collapsed, retaining name/ID, context/output limits, and a
brief pricing glance. Possible variant IDs are always visible on each model card
once its provider is expanded, with no extra model expansion required.
Inside each record, token limits, advertised capabilities, and catalog pricing expand independently; these sections also
start collapsed. Explicit expansion choices survive filtering and catalog rerenders.
Each provider's model list is its own disclosure and starts closed. It keeps the provider
name and match count visible when closed; open/closed state is kept per provider across
search, filters, preference toggles, and refresh. **Show more** focuses the provider
summary when that group is closed.
Pricing retains all entries in their original order, including cache rates and tiers.
Catalog rates are **USD per one million tokens**, with separate input, output,
cache-read, and cache-write prices. Context tiers are labeled by their supplied
token size only; no threshold interval is inferred. Explicit zero is shown as
`$0`; missing rates say **Not provided**, and tiny rates are not rounded to zero.
These are model catalog metadata, not subscription charges or an account bill;
exact variants may have different pricing. Missing capabilities are distinct
from an explicitly reported **No**.
Large results show 30 models at a time; **Show more** reads only the loaded catalog.
**Preferred** saves a multiple-model shortlist in this browser's `localStorage`.
It is not routing priority: it never changes configuration, plan values,
fallback order, or variants. Identity is the exact `provider/model` ID, not a
variant. Preferred models stay inside their provider's own list and sort above
the rest; **Preferred models only** hides every other model. Saved IDs absent
from the current catalog stay stored but are not listed.

Preferred IDs are listed first in Plans' native suggestions; all other catalog
models and custom text entry remain available. Saving preferences does not rebuild
plan inputs or discard unsaved edits. Shortlists are local to this browser and
origin (including the gateway port), not shared with OpenCode or other browsers.
Storage errors or malformed data are reported visibly and disable editing rather
than overwrite unknown data or claim a successful save. **Reload browser shortlist**
rereads storage; it does not call the gateway. A conflicting change in another tab
requires a reload before saving. Clearing browser storage removes the shortlist.

The model catalog also supports
a **Thinking variants only** filter. The thinking badge uses OpenCode’s capability
flag when the catalog sends one. Otherwise it reads known effort IDs — `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `thinking` — and Cursor names
that end in those efforts. `Fast` and context sizes (`1M`, `500k`, `200k`) are
not thinking. A model whose variants include an effort above `none` matches the
filter and shows that span, for example **Thinking · low–max**. A model whose
only recognized variant is `none` or **No Thinking** shows **No thinking**. Any
other name stays **Thinking unknown**, and unknown does not mean unsupported.
Exact named variant IDs remain selectable; plans store that exact ID. **Enabled**,
**Disabled**, and **Enabled unknown** badges show only the optional enabled
metadata, not connectivity or present availability. Model and variant fields use native catalog
suggestions when a catalog has been loaded; custom values remain editable.
Loading a catalog updates already-open suggestions without replacing draft edits.
Boards with more than six plans start collapsed except for the first plan; each
card keeps the ordered chain visible and can be opened independently.

## Reading quota

Quota lists provider windows only: name, percent used, window state, and provider
reset. It does not show observed tokens, estimated cost, the unattributed telemetry
bucket, catalog providers that have no quota source, or Quartermaster cooldowns.
Observed token usage stays on Overview until a usage page is added.
Reset timestamps include both local absolute time and relative time;
they describe the loaded snapshot, not a countdown. Unknown, stale, unsupported,
and missing readings stay explicit. No missing quota percentage or reset is guessed.
If telemetry is unsupported or unavailable, the latest dashboard clears older
report values and displays the report error. Project identity, routing plans,
bindings and quota windows remain independently available. Quartermaster cooldowns stay in the snapshot and are not shown on Quota.

## Saving plans

**Apply plans** saves the winning `quartermaster.jsonc` when that file is known,
including a user or ancestor file outside the project. Load, Apply, Cancel, and
Download stay disabled while a load or save is in flight. Cancel discards idle,
unsaved edits; it cannot cancel a submitted Apply request. Controls return after
success or failure, and a failed Apply keeps the draft. Apply is disabled unless
the response explicitly reports `writable: true`; missing writable metadata does
not grant access.

A pathless winner has no settings file, so Apply stays off. **Download draft**
saves a JSON copy from the browser for review. That copy does not include
comments from the current file. Opening the page as a local file does not fetch.

Apply does not switch the current session model. The next assignment reads the
saved file. Apply does not restart the host.

### Options safety

OpenCode's ordered configuration documents determine the winning registration.
Settings live in the sibling `quartermaster.jsonc`, not in `plugins[].options`.
Global, ancestor, and project registrations are resolved in OpenCode's order.
A pathless winner has no settings file. The browser cannot choose a path.
Missing provenance or ambiguous declarations stop the save; the writer does not
guess a file.

The plugin's own options writer still refuses a winning file outside the project.
This loopback gateway uses a separate writer for that discovered sibling. A file
inside the project still uses the project writer. Both validate Quartermaster
settings, check the returned revision,
and rewrite the whole `quartermaster.jsonc` as pretty JSON. When that file
already exists, it is copied to `quartermaster.jsonc.quartermaster.bak` first.
The OpenCode config is left unchanged, including unrelated settings and comments.
Comments inside the settings file are not preserved. Stale content, changed
effective sources, duplicate keys, escaping links and invalid settings fail closed.
Saved settings are reread for later routing and selection. Changes to startup services
or hooks may require an authorized restart; Apply itself does not restart a host.

## Offline config draft

`config.html` only checks JSON syntax and exports a draft. It does not validate
Quartermaster options, preserve JSONC comments, resolve configuration precedence
or apply changes. Review and manually merge the draft into the intended `quartermaster.jsonc`, validate it through OpenCode, and keep a backup. Do not paste secrets
into either page.

## Optional OpenChamber integration

The separately implemented OpenChamber editor requires a host build supporting
the `quartermaster-options` capability and an explicit grant. Its `quartermaster`
report grant remains read-only. This local gateway does not provide that
active-project bridge. See the [options RPC contract](../docs/PLUGIN_INTEGRATION.md#configuration-editing-capability)
and [historical bridge evidence](../docs/OPENCHAMBER_BRIDGE.md).

## Checking the layout without a gateway

Open `index.html` directly. It does not fetch anything. In the browser console, `render`, `renderCatalog`, and `renderDashboard` accept local objects. Use fixture ids such as `fixture`. Then set `location.hash` to `#overview`, `#plans`, `#providers`, or `#quota`. `#usage` opens Quota.

`renderDashboard` accepts `{apiVersion:1, projectID, generatedAt, plans, agents, workTypes, availability, report, reportError?, cooldowns?}`. `report` can be a valid telemetry report or `null`; status plans and project identity do not depend on it. `availability.sources` is keyed by provider, with `usedPercent`, `resetsAt`, `stale`, and `checkedAt` on source windows/readings. `cooldowns` entries have `providerID`, `modelID`, and `until` in epoch milliseconds. `renderCatalog` accepts `{apiVersion:1, generatedAt, providers:[{id,name,models:[{id,name,enabled?,reasoning?,variants:[string],limit?,cost?}]}]}`. A boolean `reasoning` value wins. Otherwise the thinking badge reads known effort IDs and Cursor effort suffixes; unrecognized names stay unknown. Missing percents, resets, prices, and cooldowns stay unknown.

Opening Quota or Providers through the local gateway fetches that page once. Refresh calls `GET /api/dashboard` or `GET /api/providers` again. A file page does not fetch, and those routes are not required for the console fixtures.

## Verification limits

Automated tests cover the gateway's loopback API, security checks and browser
DOM behavior. They do not establish a fresh live OpenCode-to-browser smoke test
or painted layout/accessibility verification.
