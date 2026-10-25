# Launch status

Last updated: 2026-10-25

| Criterion | Status | Evidence |
|---|---|---|
| Public repo + license | Done | [GitHub](https://github.com/Sidharth-Singh10/Amaterasu), [MIT](../LICENSE) |
| Spec, conformance, docs | Done | `spec/protocol.md`, six fixtures, `docs/sdk.md`, `docs/releasing.md` |
| Published SDK | Ready to publish | `packages/*` build to ESM + `.d.ts`; `npm run verify:dist` installs the tarballs into a clean project |
| MCP registry listing | Ready to publish | `server.json` validates with `mcp-publisher validate`; `mcpName` matches |
| Release / tag | Pending publish | `CHANGELOG.md`, `docs/releases/v0.1.0.md`, `.github/workflows/release.yml` |
| Landing page + live demo | Built, pending Pages deploy | `site/`, `scripts/build-site.mjs`, `.github/workflows/pages.yml` |
| Launch posts / essay | Drafted | `launch/` |
| 90-second demo | Out of scope | — |
| 5 external testers / 1 external adapter | Out of scope | — |

## Verification commands

```sh
npm run verify
npm run build:packages
npm run verify:dist
mcp-publisher validate
```

## Published URLs

Fill these in after the release:

- npm core: https://www.npmjs.com/package/@common-ground/canvas-core
- npm chart: https://www.npmjs.com/package/@common-ground/canvas-chart
- npm graph: https://www.npmjs.com/package/@common-ground/canvas-graph
- npm conformance: https://www.npmjs.com/package/@common-ground/canvas-conformance
- npm MCP: https://www.npmjs.com/package/@common-ground/canvas-mcp
- MCP registry: https://registry.modelcontextprotocol.io/?search=io.github.Sidharth-Singh10%2Fcommon-ground
- Release: https://github.com/Sidharth-Singh10/Amaterasu/releases/tag/v0.1.0
- Landing: https://sidharth-singh10.github.io/Amaterasu/
- Demo: https://sidharth-singh10.github.io/Amaterasu/demo/?demo=1

## Notes

- The hosted demo is the real chart editor on deterministic sample data. The agent is disabled
  because Pages is static; that is stated on the page and in the launch copy.
- The npm scope is `@common-ground`; all five packages are versioned together at `0.1.0`.
- The MCP server is a thin client over a running journal, not a standalone store.
