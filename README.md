# Flap Vault Gen

**AI-powered vault codegen for Flap Tax Vault V2** — describe a mechanic in plain English, get compiled Solidity, safety checks, and a Flap pre-audit in one studio.

No fixed template menu. Each vault is generated for your prompt, then validated with `forge` compile + automated scanners before you deploy.

---

## What's in this repo

| Path | Purpose |
|------|---------|
| `web/` | Codegen Studio UI (React + Vite) |
| `server/` | AI codegen API, safety pipeline, spec audit |
| `src/flap/` | Flap V2 protocol interfaces (required for compile) |
| `src/CodegenVaultFactory.sol` | On-chain factory for generated vault bytecode |
| `docs/CODEGEN_STUDIO.md` | User guide — prompts, lottery/oracle notes, deploy-ready |

---

## Local development

```bash
# Install deps
cd web && npm install
cd ../server && npm install

# API keys (server)
cp server/.env.example server/.env.local
# Edit server/.env.local — set OPENAI_API_KEY

# Run UI + API together
cd ../web && npm run dev:all
```

- UI: http://localhost:5173  
- API: http://localhost:3002 (`/api/health`)

---

## Production deploy (split)

| Service | Host | Root |
|---------|------|------|
| Frontend | **Vercel** | `web/` |
| Backend | **Railway** | repo root (needs Foundry + full `src/`) |

**Vercel env:** `VITE_API_URL=https://your-railway-service.up.railway.app`

**Railway env:** `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-4.1`, `CORS_ORIGIN=https://your-vercel-app.vercel.app`

See `railway.toml` and `web/vercel.json`.

---

## Verify / test

```bash
cd server && npm run test:scanners          # static safety scanner self-check
cd server && npx tsx verify-codegen.mts     # generate 3 vaults + logic review
```

Solidity tests (requires Foundry):

```bash
forge test
```

---

## License

MIT — see Flap protocol terms for on-chain deployment on Flap.sh.
