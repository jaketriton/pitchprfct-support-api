# PitchPrfct Support Diagnostics API

Lightweight microservice that emulates a customer's account and returns diagnostic data.
Called by Intercom Data Connectors when the AI support agent needs to investigate a customer.

## Endpoints

### `GET /health`
Health check. Returns `{ status: "ok" }`.

### `GET /diagnose?email=customer@example.com`
Runs a full diagnostic on the customer's account. Returns JSON with:
- `account` — name, status, pause reasons
- `credits` — balance, auto-recharge config, spend
- `system_status` — quick flags (low credits, stuck campaigns, paused workflows, etc.)
- `campaigns` — all campaigns with status
- `workflows` — all workflows with active/paused state
- `phone_numbers` — numbers with compliance status

### `POST /diagnose`
Same as GET but accepts `{ "email": "..." }` in the request body.

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set environment variables:
   ```
   PP_ADMIN_EMAIL=info@pitchprfct.com
   PP_ADMIN_PASSWORD=<your password>
   API_SECRET=<random string to protect the endpoint>
   ```
4. Railway auto-deploys on every push

## Connect to Intercom

1. In Intercom → Settings → AI & Automation → Fin AI Agent → Data Connectors
2. Add new connector: `GET https://your-railway-url.railway.app/diagnose`
3. Add header: `x-api-secret: <your API_SECRET>`
4. Map `email` parameter to the customer's email attribute
5. Tell Fin when to use it: "When a customer reports issues with their account, call the diagnostic tool to get their account status, credits, and campaign information"

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PP_ADMIN_EMAIL` | No | Admin email (default: info@pitchprfct.com) |
| `PP_ADMIN_PASSWORD` | Yes | Admin account password |
| `API_SECRET` | Recommended | Secret key for endpoint protection |
| `PORT` | No | Port to listen on (default: 3000) |
