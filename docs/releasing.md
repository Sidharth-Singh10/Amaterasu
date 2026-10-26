# Releasing Tenon

The SDK and the reference app are released from this repository. A release has four parts: npm
packages, MCP registry metadata, a GitHub tag/release, and the GitHub Pages site. They are ordered
because the registry checks the published npm package and the landing page links to the release.

## One-time setup

1. The npm organization `tenon-protocol` exists and the publisher is an owner. The plain
   `@tenon` scope is already in use on npm, so the packages publish under `@tenon-protocol`.
2. `npm login` has been run on the release machine.
3. GitHub Pages uses **GitHub Actions** as its source (`.github/workflows/pages.yml` deploys it).
4. Optional: configure [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) for each
   package with workflow `release.yml` and environment `release`. This is preferred over a token.
5. Optional: add an `NPM_TOKEN` repository secret if trusted publishing is not configured. The
   workflow skips npm publishing when the secret is absent.

## Versioning

All five packages share one version. Update these together:

- `packages/canvas-core/package.json`
- `packages/canvas-chart/package.json`
- `packages/canvas-graph/package.json`
- `packages/canvas-conformance/package.json`
- `packages/canvas-mcp/package.json`
- `server.json`
- `CHANGELOG.md`

The workspace dependency in `@tenon-protocol/mcp` and `@tenon-protocol/conformance` must accept
the new version:

```json
"@tenon-protocol/core": "^0.1.0"
```

Use `npm version <version> --no-git-tag-version --workspace <name>` for each package, or edit the
files and run the checks below.

## First release (manual npm publish)

From a clean tree:

```sh
npm ci
npm run verify
npm run build:packages
npm run verify:dist
mcp-publisher validate
```

Publish in dependency order:

```sh
npm publish --workspace @tenon-protocol/core --access public
npm publish --workspace @tenon-protocol/chart --access public
npm publish --workspace @tenon-protocol/graph --access public
npm publish --workspace @tenon-protocol/conformance --access public
npm publish --workspace @tenon-protocol/mcp --access public
```

`prepack` builds each package, so the tarballs contain `dist/`, README, LICENSE, and package.json
only.

Verify:

```sh
npm view @tenon-protocol/core version
npm view @tenon-protocol/chart version
npm view @tenon-protocol/mcp version
```

## MCP registry

`packages/canvas-mcp/package.json` carries:

```json
"mcpName": "io.github.Sidharth-Singh10/tenon"
```

`server.json` must use the same name and the published version. Validate before publishing:

```sh
mcp-publisher validate
```

Publish with GitHub OIDC (no local token):

- push the `v*` tag; `.github/workflows/release.yml` runs
  `mcp-publisher login github-oidc` and `mcp-publisher publish`
- or, locally, `mcp-publisher login github` (device flow) then `mcp-publisher publish`

Verify:

```sh
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Sidharth-Singh10/tenon"
```

## GitHub release and tag

After npm and the registry are verified:

```sh
git tag -a v0.1.0 -m "Tenon v0.1.0"
git push origin v0.1.0
```

The tag workflow:

1. runs `npm run verify`, `npm run build:packages`, and `npm run verify:dist`
2. publishes any npm package whose version is not already on the registry, if `NPM_TOKEN` is set
3. publishes the MCP metadata via GitHub OIDC
4. creates the GitHub release from `docs/releases/v0.1.0.md`

If npm publishing is skipped because no token is configured, the remaining steps still run.

## Landing page and live demo

`.github/workflows/pages.yml` builds the SPA with a base path of `/<repo>/demo`, composes it with
the static site in `site/`, and deploys the result to GitHub Pages.

- Landing: `https://sidharth-singh10.github.io/Amaterasu/`
- Demo: `https://sidharth-singh10.github.io/Amaterasu/demo/?demo=1`

For a custom domain, set `SITE_BASE=""` in the workflow and add a `CNAME` file to `site/`; update
the absolute URLs in `site/index.html` and `site/sitemap.xml`.

## Rollback

- npm: do not unpublish a published version. Deprecate it and publish a patch:
  `npm deprecate @tenon-protocol/<package>@<version> "reason"`.
- MCP registry: publish a corrected `server.json` version. The registry is append-only per version.
- GitHub: delete the release and move the tag only if the tag was not used as a dependency.
- Pages: re-run the previous successful workflow from the Actions tab.

## Post-release checks

- [ ] all five npm URLs resolve
- [ ] `npm install @tenon-protocol/chart` works in a clean directory
- [ ] `npx -y @tenon-protocol/mcp` starts and answers `initialize`
- [ ] registry search returns the server
- [ ] landing page and demo load over HTTPS
- [ ] GitHub release links to the spec, npm, and landing page
- [ ] repo homepage and topics point at the landing page
