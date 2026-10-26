# Chart quickstart

Apply a turn of chart ops, undo it, and redo it. This uses only the published SDK; no server,
browser, or API key is required.

```sh
npm install
npm start
```

Expected output: three applied ops, the document counts, then the counts after undo and redo.

The example shows the two pieces an adapter owns:

- `checkAnchor` resolves a `(time, price)` anchor against the data currently loaded in the chart.
  When an anchor is outside the window, the result carries a `suggestion` the agent can retry with.
- `beginTurn()` / `commitTurn()` groups ops into one undo step, so "undo this turn" removes the
  whole set rather than one shape at a time.

See [`@tenon-protocol/chart`](https://www.npmjs.com/package/@tenon-protocol/chart) for
the full op list.
