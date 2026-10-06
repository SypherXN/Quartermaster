# Opt-in local tools

## Live report gateway

#16 is completed. Offline report import still works. The separately started gateway reads the configured project's plans, availability, and read-only `quartermaster/report` result. It does not follow active-project switches.

From the project root, set `OPENCODE_URL` to the local OpenCode server URL (for example `http://127.0.0.1:4096`), `OPENCODE_TOKEN` to its local-service password, and `QUARTERMASTER_PROJECT_DIR` to the intended project directory. Then run `npm run local-ui` and open the printed `http://127.0.0.1:4175/` URL. Override the port with `QUARTERMASTER_LOCAL_UI_PORT` if needed. Stop the process when finished.

The gateway binds only to IPv4 loopback, rejects non-loopback upstream URLs, keeps credentials in the server process, and sends them as Basic `opencode:<token>` auth. It resolves the configured directory to a project id and rejects a report for a different project. It exposes fixed report and project-options load/apply routes, not a general proxy. Other local processes or users can access these loopback reads and writes; use only on a trusted machine, do not forward the port, and do not put credentials in the browser or shared shell history. Reports and options are sensitive. The browser does not write files directly; explicit Apply uses the server-side writer and does not mutate active sessions or models.

## Offline config draft

`config.html` remains an offline syntax-only JSON draft exporter. It does not run Quartermaster semantic validation, preserve JSONC comments, resolve OpenCode config precedence, or apply changes. Review and manually merge drafts into the intended project-owned plugin options, validate through OpenCode, and keep a backup. Do not paste secrets into the page.

The opted-in local gateway page (#17) can load and apply Quartermaster options for its configured project directory through the shared project writer (#33). Apply validates with `parseConfig`, replaces only that directory's single matching Quartermaster `plugins[].options` object, preserves unrelated settings and JSONC comments outside that object, and writes a `.quartermaster.bak` copy first. It refuses ambiguous entries, duplicate `plugins`/`options` keys, stale revisions and invalid options. It does not edit global configuration, resolve ancestor config precedence, or accept trailing-comma JSONC. The plugin rereads some saved options before later routing/selection operations, but does not rebuild startup services/hooks; restart after changing budgets, rates, health/cooldown settings, exclusive models, or bindings. The active session model is unchanged. The offline exporter still requires manual review and merge.

Quartermaster also exposes project-bound `readOptions` and `applyOptions` RPC methods backed by the same writer. The calling host must authorize options access. The completed OpenChamber editor (#29) uses the separately implemented host-mediated bridge (#36) and requires `quartermaster-options`; its `quartermaster` report grant remains read-only. The fixed-directory local gateway does not provide that active-project bridge. See the [options RPC contract](../docs/PLUGIN_INTEGRATION.md#configuration-editing-capability) and [OpenChamber bridge evidence](../docs/OPENCHAMBER_BRIDGE.md).
