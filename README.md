# pi-web

Lightweight web UI for pi.

## Run

```bash
pnpm install
pnpm dev
# open http://localhost:8787
```

Production build:

```bash
pnpm build
pnpm start
```

Set `PORT` to override the default `8787`. The server binds to `127.0.0.1` by default.

Remote access is disabled by default. To bind a non-loopback `HOST`, set both `PI_WEB_ALLOW_REMOTE=1` and `PI_WEB_TOKEN`, then open the UI with `#token=<token>` once so the browser can authenticate API calls. Only expose pi-web on a trusted network or behind an authenticated proxy/tunnel.

## Notes

- Server is native ESM using Node's built-in HTTP server.
- Client is vanilla JS/CSS/HTML.
- Uses pi's SDK runtime for sessions, streaming prompts, rewind (`navigateTree`) and fork.
