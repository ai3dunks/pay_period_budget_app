# Pay Period Budget App

## Run Locally

### Install dependencies

```bash
npm install
```

### Start frontend + backend together

```bash
npm run dev:all
```

What this does:
- Selects the first available frontend port between `5173` and `5190`
- Starts Vite on that selected port
- Starts backend on `8787` with `FRONTEND_ORIGIN` automatically set to the selected frontend URL

Typical URLs after startup:
- Frontend: `http://localhost:<selected-port>/`
- Backend health: `http://localhost:8787/api/health`

## Development Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev:all` | Starts frontend and backend together with automatic frontend port selection and matching backend CORS origin |
| `npm run dev` | Starts Vite frontend on port 5173 with strict port mode |
| `npm run server` | Starts backend API server on port 8787 |
| `npm run build` | Builds production frontend assets |
| `npm run preview` | Serves the built frontend locally on port 4173 |
| `npm run check:shared` | Runs shared-domain consistency checks |
| `npm run zip:clean` | Creates a sanitized zip archive excluding environment files, data, build output, and dependencies |

## Troubleshooting

### Plaid: "Missing Plaid environment variables."

The backend needs Plaid credentials before Connect Bank can create a Link token.

1. Open `.env` and set values for:
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV` (`sandbox`, `development`, or `production`)
- `LOCAL_API_TOKEN`

2. Restart the backend (or `npm run dev:all`).

3. In Plaid settings page, click Connect Bank again.

Notes:
- `.env` is ignored by git and will not be committed.
- For local testing, use Plaid Sandbox credentials.

### "Port 5173 is already in use"
No action needed when using `npm run dev:all`. It automatically chooses the next available frontend port.

### Backend runs but frontend cannot call API (CORS)
Use `npm run dev:all` instead of starting frontend/backend separately so backend CORS and frontend port always stay aligned.
