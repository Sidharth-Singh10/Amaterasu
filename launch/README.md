# Launch kit

Everything here is a draft. Nothing is scheduled or posted automatically.

## Canonical asset

- [`essay.md`](essay.md) — the long-form argument. Publish this first, then point the short posts at
  it. It is written to stand alone on a blog or as a GitHub discussion.

## Posting order

1. **Blog / essay** — publish `essay.md` at a stable URL. If you do not have a blog, publish it as a
   GitHub Discussion and link that.
2. **GitHub release** — confirm `v0.1.0` is live and the release notes match the final package
   versions.
3. **Show HN** — `show-hn.md`. Post on a weekday morning US Eastern time, then stay in the thread.
   Do not ask for upvotes or share the link in voting rings.
4. **r/mcp** — `reddit-mcp.md`. Read the subreddit rules first; some communities require a
   comment history or disallow direct promotion. Disclose that you are the author.
5. **MCP Discord** — `mcp-discord.md`, in the designated showcase channel.
6. **X / LinkedIn** — `x-thread.md` and `linkedin.md`, after the long-form post is live.

Do not post the same text in multiple communities on the same day. Adapt the opening and answer
questions in each thread.

## Pre-flight

- [ ] `npm view @common-ground/canvas-core version` returns `0.1.0`
- [ ] `npm view @common-ground/canvas-chart version` returns `0.1.0`
- [ ] `npm view @common-ground/canvas-mcp version` returns `0.1.0`
- [ ] `npx -y @common-ground/canvas-mcp` starts and answers `initialize`
- [ ] MCP registry search returns `io.github.Sidharth-Singh10/common-ground`
- [ ] GitHub release `v0.1.0` exists and links to the spec, SDK, and landing page
- [ ] Landing page loads at https://sidharth-singh10.github.io/Amaterasu/
- [ ] Demo loads at https://sidharth-singh10.github.io/Amaterasu/demo/?demo=1
- [ ] All links in the drafts return 200
- [ ] `site/og.png` is the image used for link previews
- [ ] A clean machine can install `@common-ground/canvas-chart` and run
      `examples/chart-quickstart`

## Accuracy rules

- Do not claim a hosted multi-tenant service, CRDT support, or offline conflict resolution.
- Do not call the static demo an agent demo. It runs the chart editor on sample data; the agent is
  disabled.
- Do not invent usage numbers, testimonials, logos, or customer names.
- Say "reference app" for Amaterasu, not "the only app".
- Say "two adapters" (chart and graph), not "any canvas".
- If someone asks about production scale, point at the p95 ack test and the SQLite/single-user
  reference service; do not imply a hosted SLA.

## Links

- Landing: https://sidharth-singh10.github.io/Amaterasu/
- Demo: https://sidharth-singh10.github.io/Amaterasu/demo/?demo=1
- GitHub: https://github.com/Sidharth-Singh10/Amaterasu
- Spec: https://github.com/Sidharth-Singh10/Amaterasu/blob/master/spec/protocol.md
- SDK: https://github.com/Sidharth-Singh10/Amaterasu/blob/master/docs/sdk.md
- npm: https://www.npmjs.com/org/common-ground
- MCP registry: https://registry.modelcontextprotocol.io/?search=io.github.Sidharth-Singh10%2Fcommon-ground

## After launch

- Reply to every substantive question for the first 48 hours.
- Collect adapter requests into a GitHub issue, not DMs.
- If the demo gets traffic, watch the Pages bandwidth and the GitHub Actions minutes.
- The 90-second video and the five external testers are intentionally not part of this kit.
