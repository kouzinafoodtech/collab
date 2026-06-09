# Internal Messaging

A tiny internal messaging system. Anyone can register, anyone can message
anyone, every message is stored in a database, and the **whole feed is public** —
everyone can see every message sent between everyone.

- **Backend:** Python · FastAPI · SQLAlchemy (`backend/`)
- **Frontend:** React · Vite (`frontend/`)
- **Database:** MySQL in production (Azure Database for MySQL), SQLite for local dev
- **Packaging:** single Docker image — FastAPI serves the built React app at `/`
  and the API under `/api`

## Run locally

### 1. Backend (port 8000)

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload
```

With no `DATABASE_URL` set it creates a local `messages.db` SQLite file.

### 2. Frontend (port 5173)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Vite proxies `/api/*` to the backend on port 8000.
Open it in two tabs, pick different names, and message back and forth.

## API

All endpoints are served under `/api`:

| Method | Path            | Description                           |
| ------ | --------------- | ------------------------------------- |
| GET    | `/api/health`   | Health check                          |
| GET    | `/api/users`    | List everyone who has registered      |
| POST   | `/api/users`    | Register a name (idempotent)          |
| GET    | `/api/messages` | The public feed — every message       |
| POST   | `/api/messages` | Send a message (auto-registers names) |

## Run the whole thing as one container

```bash
docker build -t internal-messaging .
docker run -p 8000:8000 \
  -e DATABASE_URL="mysql+pymysql://USER:PASSWORD@HOST:3306/DBNAME" \
  internal-messaging
```

Then open http://localhost:8000 — both the UI and the API are served from the
same origin.

## Deploy to Azure Container Apps (cheapest) on your own subdomain

We deploy to **Azure Container Apps** on the **Consumption plan** — it scales to
zero when idle (so you pay ~nothing for a low-traffic internal tool) and supports
a custom domain with a free managed TLS certificate. It's backed by your existing
**Azure Database for MySQL**.

There are two ways to deploy. **Pick the GitHub Actions path if you want nothing
on your own machine.**

### Option A — GitHub Actions (recommended: nothing runs on your machine)

A workflow (`.github/workflows/deploy.yml`) builds the image **on Azure** and
deploys on every push. You only ever touch two browser screens — Azure Cloud
Shell (to mint a credential) and GitHub Secrets (to store it).

➡️ Follow **[deploy/GITHUB_ACTIONS_SETUP.md](deploy/GITHUB_ACTIONS_SETUP.md)**.

Your credentials go into **GitHub → Settings → Secrets** and **Azure Cloud
Shell** — never into the repo, your laptop, or anywhere else.

### Option B — One command from your machine

If you'd rather deploy locally, the script below builds on Azure too
(`az acr build`, no local Docker) but is launched from your shell.

### Credentials — read this first (nothing secret goes in the repo)

You provide two sets of credentials, and **neither is committed or pasted into
chat**:

1. **Azure** — authenticate the `az` CLI on your own machine:

   ```bash
   az login                      # opens a browser; uses YOUR Azure identity
   az account set --subscription "<your-subscription-id-or-name>"
   az extension add --name containerapp --upgrade
   ```

   That's it for manual deploys — the script below acts as you. (For automated
   GitHub Actions deploys you'd instead create a service principal / OIDC
   federated credential and store it in GitHub Secrets — ask and we'll wire it.)

2. **MySQL** — pass the connection string as an environment variable in your own
   shell. The deploy script reads it and stores it as a **Container Apps secret**
   (encrypted, referenced by the app at runtime) — it never touches the repo:

   ```bash
   export DATABASE_URL="mysql+pymysql://USER:PASSWORD@HOST.mysql.database.azure.com:3306/DBNAME"
   ```

   To rotate it later without redeploying the image:

   ```bash
   az containerapp secret set -g rg-internal-messaging -n internal-messaging \
     --secrets db-url="mysql+pymysql://USER:NEWPASSWORD@HOST:3306/DBNAME"
   az containerapp revision restart -g rg-internal-messaging -n internal-messaging \
     --revision $(az containerapp revision list -g rg-internal-messaging -n internal-messaging --query '[0].name' -o tsv)
   ```

### One-command deploy

From the **repo root**, after the two exports above:

```bash
export DATABASE_URL="mysql+pymysql://USER:PASSWORD@HOST.mysql.database.azure.com:3306/DBNAME"
export CUSTOM_DOMAIN="chat.example.com"      # optional; omit to just get the azure URL
./deploy/azure-containerapps.sh
```

The script (see `deploy/azure-containerapps.sh`) will:

1. Create a resource group + Azure Container Registry.
2. **Build the image in the cloud** with `az acr build` — no local Docker needed.
3. Create a Container Apps environment and deploy the app (port 8000, min
   replicas 0 = scale to zero).
4. Print the live `*.azurecontainerapps.io` URL.
5. If `CUSTOM_DOMAIN` is set, print the exact **CNAME** + **asuid TXT** records to
   add at your DNS provider, then bind the domain with a free managed cert.

### Custom subdomain (what the script tells you to add)

At your DNS provider, for `chat.example.com`:

```
CNAME  chat         <your-app>.<region>.azurecontainerapps.io
TXT    asuid.chat   <customDomainVerificationId printed by the script>
```

Once DNS propagates, re-run the script (or the two `hostname add` / `hostname
bind` commands it prints) and Azure issues a **free managed TLS certificate**.

Your messaging app is then live at **https://chat.example.com**.

### MySQL networking note

The app auto-creates its tables on first boot. Make sure your Azure MySQL
server lets the Container App connect — enable **"Allow public access from Azure
services"** on the MySQL Flexible Server, or place both in the same VNet /
Private Endpoint. Azure MySQL requires TLS, which the app enables automatically
for `mysql` URLs.
