# Amaterasu — VPS Deployment Runbook (Phase 4)

Everything runs on the VPS, behind nginx with TLS and basic auth. You execute the steps; each
one ends with a verification command so failures surface immediately.

```
Internet ── 443 ──> nginx ──> amaterasu-server :8787 ──┬── INDmoney MCP (own OAuth, data path)
   (TLS, basic auth)  │                                ├── OpenCode :4096 (agent bridge)
                      │                                └── web/build (static SPA)
                      └── firecrawl :3002 (you host it; the OpenCode agent uses it)
```

Ports **4096 / 8787 / 3002 stay bound to 127.0.0.1** — only 80/443 are public.

---

## Values to fill in

| Placeholder | Meaning | Example |
|---|---|---|
| `DOMAIN` | the hostname you'll serve | `charts.example.com` |
| `EMAIL` | for Let's Encrypt expiry notices | `you@example.com` |
| `DEPLOY_USER` | the Linux user that runs everything | `levi` |
| `DEPLOY_DIR` | checkout directory | `/home/DEPLOY_USER/amaterasu` |
| `OC_BIN` | opencode binary (`which opencode` on the VPS) | `/home/DEPLOY_USER/.opencode/bin/opencode` |

Everywhere below, replace `/home/levi` with the actual home of `DEPLOY_USER`.

## Step 0 — pre-flight

```sh
# Point DOMAIN's A record at the VPS public IP first; wait for DNS to resolve:
dig +short DOMAIN

# Toolchains (install if missing):
node -v            # ≥ 20 (22+ recommended)
npm -v
cargo --version    # rustup toolchain
which opencode && opencode --version   # must be 2.0.6

# Ports free:
ss -tlnp | grep -E ':(80|443|4096|8787)\b' || echo "all free"
```

## Step 1 — get the code onto the VPS

From your local machine (excludes derived directories):

```sh
rsync -a --delete \
  --exclude node_modules --exclude target --exclude .svelte-kit \
  --exclude web/build --exclude .next --exclude .env \
  /home/levi/amaterasu/ DEPLOY_USER@VPS:/home/levi/amaterasu/
```

(or `git clone` if you push the repo to a remote — the same excludes apply to builds.)

## Step 2 — build

```sh
cd /home/levi/amaterasu
npm ci                                   # root workspace install
npm run build --workspace @amaterasu/web # -> web/build (SPA)
cargo build --release --manifest-path server/Cargo.toml   # -> server/target/release/amaterasu-server

# Plugin/agent project (type-check only; the plugin itself is provided by OpenCode):
cd opencode && npm install && npm run check && cd ..
```

If the VPS is RAM-tight, build the Rust binary locally instead and `rsync` just
`server/target/release/amaterasu-server`.

**Verify:** `ls web/build/index.html server/target/release/amaterasu-server`.

## Step 3 — environment file

```sh
cp deploy/amaterasu.env.example .env
chmod 600 .env
# Edit .env: DOMAIN, paths, and a generated password used by both services:
openssl rand -base64 32      # paste as OPENCODE_PASSWORD and OPENCODE_SERVER_PASSWORD
```

## Step 4 — OpenCode server (the agent's home)

**4a. VPS global config** (`~/.config/opencode/opencode.jsonc`): ensure the `indmoney` MCP is
configured (and authorized — see 4b), and add Firecrawl:

```jsonc
{
  "mcp": {
    "servers": {
      "firecrawl": {
        "type": "local",
        "command": ["npx", "-y", "firecrawl-mcp"],
        "environment": { "FIRECRAWL_API_URL": "http://127.0.0.1:3002" }
      }
    }
  }
}
```

**4b. Authorize indmoney for the agent (one-time):** run `opencode` in the TUI on the VPS,
open `/mcps`, select `indmoney`, and sign in. (Skip if the VPS already shows it connected.)

**4c. Install the unit** (templates in `deploy/systemd/`):

```sh
mkdir -p ~/.config/systemd/user
cp deploy/systemd/opencode-charts.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now opencode-charts
loginctl enable-linger "$USER"           # keep user services running without login
```

**Verify:**

```sh
PW=$(grep '^OPENCODE_SERVER_PASSWORD=' .env | cut -d= -f2-)
curl -s -u "opencode:$PW" http://127.0.0.1:4096/api/info
curl -s -u "opencode:$PW" http://127.0.0.1:4096/api/mcp    # indmoney + firecrawl should be connected
curl -s -X POST -u "opencode:$PW" -H 'content-type: application/json' \
  -d '{"input":{"chartId":"probe"}}' http://127.0.0.1:4096/api/rpc/chart/attach
# → {"output":{"ok":true,"activeChartId":"probe"}}
```

If `/api/plugin` shows no `amaterasu.chart-bridge`, hit
`curl -X POST -u "opencode:$PW" http://127.0.0.1:4096/api/location/reload` and re-check.

## Step 5 — the app service

```sh
cp deploy/systemd/amaterasu-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now amaterasu-web
```

**Verify (still local, before nginx):**

```sh
curl -s http://127.0.0.1:8787/api/health          # {"ok":true,...}
curl -s http://127.0.0.1:8787/api/indmoney/status # {"connected":false,...} until step 7
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/   # 200 (index.html)
```

## Step 6 — nginx, TLS, basic auth

```sh
sudo pacman -S nginx certbot certbot-nginx apache-tools   # Arch/CachyOS; adjust for other distros

sudo cp deploy/nginx/amaterasu.conf /etc/nginx/conf.d/amaterasu.conf
sudo sed -i 's/charts.example.com/DOMAIN/' /etc/nginx/conf.d/amaterasu.conf

sudo htpasswd -c /etc/nginx/.htpasswd amaterasu    # set the login password

sudo nginx -t && sudo systemctl enable --now nginx

# TLS (adds the 443 server block and the HTTP→HTTPS redirect):
sudo certbot --nginx -d DOMAIN --agree-tos -m EMAIL --redirect

# Firewall: expose only 80/443 (adjust to your firewall tool):
sudo ufw allow 80,443/tcp
```

Optional hardening after certbot (inside the 443 server block): add
`add_header Strict-Transport-Security "max-age=31536000" always;`

**Verify:** `curl -su amaterasu:YOURPASS https://DOMAIN/api/health` → `{"ok":true,...}`

## Step 7 — the data-path consent (once)

The webapp holds its **own** INDmoney connection (separate from the agent's). Its redirect URI
is derived from `AMATERASU_BASE_URL`, so the service registers a second client against the
domain callback automatically.

1. Open `https://DOMAIN/api/indmoney/connect` (log in with basic auth) — or click
   **Connect INDmoney** in the app banner.
2. Log in to INDmoney, approve `market:read portfolio:read`.
3. You are redirected back; the banner disappears.

**Verify:**

```sh
curl -su amaterasu:YOURPASS https://DOMAIN/api/indmoney/status   # connected: true
curl -su amaterasu:YOURPASS "https://DOMAIN/api/candles?ind_key=INDS01052&interval=1day&lookback=1y" | head -c 200
```

Tokens live at `~/.local/share/amaterasu/indmoney-auth.json` (0600) and refresh automatically.

## Step 8 — Firecrawl check (agent side)

```sh
PW=$(grep '^OPENCODE_SERVER_PASSWORD=' .env | cut -d= -f2-)
curl -s -u "opencode:$PW" http://127.0.0.1:4096/api/mcp | grep -o '"firecrawl[^}]*}'
```

Then open the app and ask the agent: *“What's the latest news on RELIANCE?”* — it should call
`tools.firecrawl.*` and cite sources. If it can't see the tools, confirm the `firecrawl_*`
allow-rule is in the deployed `opencode/.opencode/agents/chart-analyst.md` and reload the
location.

## Step 9 — acceptance checklist

| # | Check | Expected |
|---|---|---|
| 1 | `https://DOMAIN` in a browser | chart loads with real candles; live quote in the header |
| 2 | Symbol search (e.g. `TCS`) + interval switch | data reloads; viewport resets; auto-refresh stays on |
| 3 | Wait one refresh cycle on `1m` | last candle updates without a full redraw flash |
| 4 | Reload the page | symbol/interval/view restored |
| 5 | Ask the agent “Mark the recent swing low and the range, then summarise” | tool cards appear; shapes land on the chart; streamed reply |
| 6 | “Undo this turn” | shapes (and any series) from that turn disappear |
| 7 | “Plot SMA(20)” | a smooth line appears; the reported value matches the line |
| 8 | “Latest RELIANCE news?” | firecrawl tool call; cited sources |
| 9 | `ss -tlnp \| grep -E ':(4096\|8787\|3002)'` | all on 127.0.0.1 only |
| 10 | `journalctl --user -u amaterasu-web -u opencode-charts -n 20` | no recurring errors |

## Upgrades

```sh
# from your machine: rsync the new code (step 1), then on the VPS:
npm ci && npm run build --workspace @amaterasu/web
cargo build --release --manifest-path server/Cargo.toml
systemctl --user restart amaterasu-web opencode-charts
curl -su amaterasu:YOURPASS https://DOMAIN/api/health
```

Plugin/agent-only changes don't need a rebuild: restart `opencode-charts` (or
`POST /api/location/reload`).

**Backups worth taking:** `~/.local/share/amaterasu/indmoney-auth.json`,
`~/.local/share/opencode/opencode.db` (OpenCode sessions + MCP credentials), and `.env`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Agent tools time out (“the chart did not answer … within 15000ms”) | SSE is buffered: confirm the `/api/stream` location in the nginx config (`proxy_buffering off`, `proxy_read_timeout 3600s`), then `sudo nginx -s reload` |
| `{"error":"chat_not_configured"}` | `OPENCODE_PASSWORD` missing in `.env` or doesn't match `OPENCODE_SERVER_PASSWORD` |
| `Agent not found: "chart-analyst"` | `OPENCODE_DIRECTORY` doesn't point at the deployed `opencode/` project |
| Agent replies empty / `provider.invalid-output` | `OPENCODE_MODEL` unset or not available to the VPS's providers — pick a capable model (e.g. `opencode-go/deepseek-v4.1-flash`) |
| Firecrawl tools invisible | MCP not connected (step 8) or the `firecrawl_*` allow-rule missing from the agent file |
| Chart data 503 `not_connected` | Step 7 consent not completed (or INDmoney revoked it — visit the connect URL again) |
| nginx 502 | App unit down: `systemctl --user status amaterasu-web`; check `journalctl --user -u amaterasu-web` |
| Chart loads but no quotes/stream | `/api/stream` returning non-200: check basic auth is being sent for the EventSource (same origin, so the browser's cached credentials should apply) |
