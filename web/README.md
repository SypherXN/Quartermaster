# Opt-in local tools

These tools require a repository checkout; they are not included in the installed
plugin archive and do not start with the plugin.

## Reports and local gateway

Open `index.html` to import a saved report without a server. For live reports and
explicit configuration editing, start the local gateway instead. It stays bound
to one configured project; it does not follow active-project switches.

From the repository root, configure these environment variables:

| Variable | Value |
| --- | --- |
| `OPENCODE_URL` | Existing server URL using `127.0.0.1`, such as `http://127.0.0.1:4096` |
| `OPENCODE_TOKEN` | That server's local-service password; keep it out of shared history |
| `QUARTERMASTER_PROJECT_DIR` | Absolute directory of the intended project |
| `QUARTERMASTER_LOCAL_UI_PORT` | Optional gateway port; defaults to `4175` |

Run `npm run local-ui`, open the printed loopback URL, and choose **Load live
report**. Stop the gateway when finished. It does not start an OpenCode server.

The gateway listens on IPv4 loopback and accepts only a `127.0.0.1` upstream. It
keeps credentials server-side, using Basic `opencode:<token>` authentication.
It validates the fixed directory's project ID and rejects mismatched reports.
Its routes are limited to reports and project-options load/apply, not arbitrary
proxy requests.

**Use only on a trusted machine.** Other local processes or users can access
these reads and writes. Do not forward the port or put credentials in the
browser. Reports and options are sensitive. Reports are read-only, but explicit
**Apply** can write project configuration through the server-side writer; it
does not switch active session models.

## Live options editing

Choose **Load project options**, edit the returned options, then choose
**Apply project options** to save.
Fields and Load, Apply and Cancel buttons are disabled during loading or saving.
Cancel discards idle, unsaved edits; it cannot cancel a submitted Apply request.
Controls return after success or failure, and a failed Apply keeps the draft for
review or discard.

### Options safety

OpenCode's ordered configuration documents determine the winning options object.
Global, ancestor and pathless inline winners are readable but not writable here.
Apply requires an existing project-contained winning entry. Missing provenance
or ambiguous declarations stop the save; the writer does not guess a file.

The shared writer validates Quartermaster options, checks the returned revision,
backs up to `.quartermaster.bak`, and replaces only `plugins[].options`. Unrelated
settings and comments outside that object are preserved. Stale content, changed
effective sources, duplicate keys, escaping links and invalid options fail closed.
Saved options are reread for later routing/selection. Changes to startup services
or hooks may require an authorized restart; Apply itself does not restart a host.

## Offline config draft

`config.html` only checks JSON syntax and exports a draft. It does not validate
Quartermaster options, preserve JSONC comments, resolve configuration precedence
or apply changes. Review and manually merge the draft into the intended plugin
options, validate it through OpenCode, and keep a backup. Do not paste secrets
into either page.

## Optional OpenChamber integration

The separately implemented OpenChamber editor requires a host build supporting
the `quartermaster-options` capability and an explicit grant. Its `quartermaster`
report grant remains read-only. This local gateway does not provide that
active-project bridge. See the [options RPC contract](../docs/PLUGIN_INTEGRATION.md#configuration-editing-capability)
and [historical bridge evidence](../docs/OPENCHAMBER_BRIDGE.md).

## Verification limits

Automated tests cover the gateway's loopback API, security checks and browser
DOM behavior. They do not establish a fresh live OpenCode-to-browser smoke test
or painted layout/accessibility verification.
