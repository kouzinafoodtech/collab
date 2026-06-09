# One-time setup: deploy from GitHub Actions (nothing on your machine)

After this, every push to the deploy branch builds and ships to Azure
automatically. You never run anything locally. There are exactly two places you
touch, both in a browser:

1. **Azure Cloud Shell** (https://shell.azure.com) — to create a credential.
2. **GitHub → repo → Settings → Secrets** — to paste that credential in.

---

## Step 1 — Create an Azure credential for GitHub (in Azure Cloud Shell)

Open https://shell.azure.com (runs in your browser, on Azure — not your laptop).
Paste this block. It creates an app registration that GitHub can log in *as* via
OIDC, with **no password to store**, scoped to deploy in your subscription.

```bash
REPO="kouzinafoodtech/collab"
BRANCH="claude/upbeat-goldberg-1iwz26"

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)

APP_ID=$(az ad app create --display-name "github-internal-messaging" --query appId -o tsv)
az ad sp create --id "$APP_ID"

# Let it create/deploy resources in your subscription.
# (Tighten to a single resource group later if you prefer.)
az role assignment create --assignee "$APP_ID" \
  --role Contributor \
  --scope "/subscriptions/$SUBSCRIPTION_ID"

# Trust GitHub Actions runs from your repo + branch (this is what replaces a password).
az ad app federated-credential create --id "$APP_ID" --parameters "{
  \"name\": \"github-collab\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:${REPO}:ref:refs/heads/${BRANCH}\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"

echo
echo "Copy these into GitHub secrets:"
echo "AZURE_CLIENT_ID=$APP_ID"
echo "AZURE_TENANT_ID=$TENANT_ID"
echo "AZURE_SUBSCRIPTION_ID=$SUBSCRIPTION_ID"
```

> Also add a federated credential for `main` (and for the
> `workflow_dispatch`/manual path) if you later deploy from those — repeat the
> `federated-credential create` with the matching `subject`. For manual
> `workflow_dispatch` runs the subject is
> `repo:${REPO}:ref:refs/heads/<branch-you-run-from>`.

---

## Step 2 — Add the secrets in GitHub

In the browser: **GitHub → your `collab` repo → Settings → Secrets and variables
→ Actions → New repository secret.** Add four:

| Secret name             | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`       | the `AZURE_CLIENT_ID` printed above                                    |
| `AZURE_TENANT_ID`       | the `AZURE_TENANT_ID` printed above                                    |
| `AZURE_SUBSCRIPTION_ID` | the `AZURE_SUBSCRIPTION_ID` printed above                             |
| `DATABASE_URL`          | `mysql+pymysql://USER:PASSWORD@HOST.mysql.database.azure.com:3306/DB` |

These live encrypted in GitHub and are injected into the workflow at run time.
They are never in the repo, never printed in logs, and never sent to anyone.

---

## Step 3 — Deploy

Just push to the branch (or click **Actions → Deploy to Azure Container Apps →
Run workflow**). The workflow:

1. Logs into Azure via OIDC.
2. Builds the Docker image **on Azure** (`az acr build`).
3. Deploys to Container Apps (scale-to-zero, port 8000), with `DATABASE_URL`
   stored as an encrypted Container Apps secret.
4. Prints the live `https://...azurecontainerapps.io` URL in the run summary.

---

## Step 4 — Custom subdomain (one time, in Azure Cloud Shell)

The app's live URL is shown in the Actions run summary. To put it on
`chat.example.com`, in Cloud Shell:

```bash
RG=rg-internal-messaging
APP=internal-messaging
ENVIRONMENT=msg-env
DOMAIN=chat.example.com

FQDN=$(az containerapp show -g "$RG" -n "$APP" --query properties.configuration.ingress.fqdn -o tsv)
ASUID=$(az containerapp show -g "$RG" -n "$APP" --query properties.customDomainVerificationId -o tsv)

echo "Add these DNS records at your registrar:"
echo "  CNAME  ${DOMAIN%%.*}        $FQDN"
echo "  TXT    asuid.${DOMAIN%%.*}  $ASUID"

# After DNS propagates, bind it with a FREE managed certificate:
az containerapp hostname add  -g "$RG" -n "$APP" --hostname "$DOMAIN"
az containerapp hostname bind -g "$RG" -n "$APP" --hostname "$DOMAIN" \
  --environment "$ENVIRONMENT" --validation-method CNAME
```

Live at **https://chat.example.com**. 🎉

---

## Where do my credentials go? (summary)

- **You** paste them into **Azure Cloud Shell** (browser) and **GitHub Secrets**
  (browser). Both are on Azure / GitHub — nothing on your machine, nothing in
  this chat.
- The OIDC setup means GitHub holds **no Azure password at all** — just three
  non-secret IDs plus a trust relationship.
- `DATABASE_URL` is the only real secret in GitHub, and it's encrypted.
