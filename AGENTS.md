# AGENTS.md — daily-habit

Obsidian plugin for habit tracking with diary-based check-ins and 7-day dot visualization.

## Layout

Single-file plugin — `main.ts` is the only TypeScript source. Companion files:
- `manifest.json` / `versions.json` / `config.json` / `styles.css` / `esbuild.config.mjs` / `eslint.config.mjs` / `tsconfig.json`
- `deploy.mjs` / `release.mjs` — maintainer scripts

## Commands

```bash
npm run dev      # esbuild watch -> dist/main.js
npm run build    # lint + esbuild production + cp manifest.json styles.css config.json dist/
npm run lint     # eslint "**/*.{ts,tsx}"
npm run deploy   # build + copy to author's local vaults, then delete dist/
npm run release  # gh release create from manifest.json version
```

`build` enforces lint before bundling. No `tsc` typecheck in the build pipeline. Asset copying is done via shell command in the npm script, not in esbuild config.

## Build

- esbuild, entry `main.js` (note: `.js` extension, not `.ts` — esbuild resolves it to `main.ts` via tsconfig)
- format `cjs`, target `es2018`
- externals: `obsidian`, `electron`, `@codemirror/*`, `@lezer/*`, Node builtins
- Copies `manifest.json`, `styles.css`, `config.json` to `dist/` via shell cp

## Versioning

Keep `package.json`, `manifest.json`, and `versions.json` versions in sync. `release.mjs` reads version from `manifest.json`.

## Marketplace / Scorecard

Marketplace, manifest, and release conventions live in the parent `obsidian-plugins-parent/AGENTS.md`. Read it before touching `manifest.json`, release flow, or marketplace-facing code.