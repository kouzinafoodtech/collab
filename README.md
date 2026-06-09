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

## Deploy to Azure (App Service + Azure Database for MySQL) on your own subdomain

> Replace the placeholder values (`RG`, `myapp`, host/user/password, and
> `chat.example.com`) with your own.

### 1. Build & push the image to Azure Container Registry (ACR)

```bash
az acr create -g RG -n myregistry --sku Basic
az acr login -n myregistry
docker build -t myregistry.azurecr.io/internal-messaging:latest .
docker push myregistry.azurecr.io/internal-messaging:latest
```

### 2. Create the Web App (Linux container)

```bash
az appservice plan create -g RG -n myplan --is-linux --sku B1
az webapp create -g RG -p myplan -n myapp \
  --deployment-container-image-name myregistry.azurecr.io/internal-messaging:latest
```

### 3. Point it at your Azure MySQL database

```bash
az webapp config appsettings set -g RG -n myapp --settings \
  DATABASE_URL="mysql+pymysql://USER:PASSWORD@MYHOST.mysql.database.azure.com:3306/DBNAME" \
  WEBSITES_PORT=8000
```

The app creates its tables automatically on first boot. Make sure the MySQL
server's networking allows access from the Web App (enable "Allow public access
from Azure services", or use a VNet/Private Endpoint). Azure MySQL requires TLS,
which the app enables automatically for `mysql` URLs.

### 4. Add your custom subdomain

In your DNS provider, add records for `chat.example.com`:

```
CNAME  chat   myapp.azurewebsites.net
TXT    asuid.chat   <verification id from `az webapp config hostname get-external-ip` flow>
```

Then bind it and enable a free managed TLS certificate:

```bash
az webapp config hostname add -g RG --webapp-name myapp \
  --hostname chat.example.com

az webapp config ssl create -g RG --name myapp --hostname chat.example.com
az webapp config ssl bind -g RG --name myapp \
  --certificate-thumbprint <thumbprint-from-previous-step> --ssl-type SNI
```

Your messaging app is now live at **https://chat.example.com**.
