# Launch status

Last updated: 2026-10-25

| Criterion | Status | Evidence |
|---|---|---|
| Public repo + license | Done | [GitHub](https://github.com/Sidharth-Singh10/Amaterasu), [MIT](../LICENSE) |
| Spec, conformance, docs | Done | `spec/protocol.md`, six fixtures, `docs/sdk.md`, `docs/releasing.md` |
| Published SDK | Paused | Packages build, pack, and install from tarballs; npm publication intentionally paused |
| MCP registry listing | Blocked on npm | `server.json` validates; registry checks the published npm package first |
| Release / tag | Paused | `CHANGELOG.md`, `docs/releases/v0.1.0.md`, and the tag workflow are ready |
| Landing page + live demo | Live as noindex preview | `https://sidharth-singh10.github.io/Amaterasu/` |
| Launch posts / essay | Drafted | `launch/` |
| 90-second demo | Out of scope | — |
| 5 external testers / 1 external adapter | Out of scope | — |

The Pages site is deliberately marked `noindex,nofollow` and carries a preview banner until the npm
packages are published. Remove both at launch.

## Verification commands

```sh
npm run verify
npm run build:packages
npm run verify:dist
mcp-publisher validate
```

## URLs

- Landing preview: https://sidharth-singh10.github.io/Amaterasu/
- Demo preview: https://sidharth-singh10.github.io/Amaterasu/demo/?demo=1
- Source: https://github.com/Sidharth-Singh10/Amaterasu

Fill these in after publication:

- npm core: https://www.npmjs.com/package/@common-ground/canvas-core
- npm chart: https://www.npmjs.com/package/@common-ground/canvas-chart
- npm graph: https://www.npmjs.com/package/@common-ground/canvas-graph
- npm conformance: https://www.npmjs.com/package/@common-ground/canvas-conformance
- npm MCP: https://www.npmjs.com/package/@common-ground/canvas-mcp
- MCP registry: https://registry.modelcontextprotocol.io/?search=io.github.Sidharth-Singh10%2Fcommon-ground
- Release: https://github.com/Sidharth-Singh10/Amaterasu/releases/tag/v0.1.0

## Notes

- The hosted demo is the real chart editor on deterministic sample data. The agent is disabled
  because Pages is static; that is stated on the page and in the launch copy.
- The npm scope is `@common-ground`; all five packages are versioned together at `0.1.0`.
- The MCP server is a thin client over a running journal, not a standalone store.
- Publication order when unpaused: npm packages, then `v0.1.0` tag, then the registry workflow.
