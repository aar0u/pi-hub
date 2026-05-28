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

Set `PORT` to override the default `8787`.

## Notes

- Server is TypeScript using Node's built-in HTTP server.
- Client is vanilla JS/CSS/HTML.
- Uses pi's SDK runtime for sessions, streaming prompts, rewind (`navigateTree`) and fork.
