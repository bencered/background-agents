# Deployment Runbook

## Prerequisites

- `terraform/environments/production/terraform.tfvars` populated (Cloudflare, Vercel, Modal, GitHub credentials)
- Vercel project linked: `.vercel/` in repo root (`npx vercel link --scope carbon-copy --project open-inspect-carboncopy`)
- `enable_durable_object_bindings = true` in tfvars (normal state)

## Redeploy Everything

```bash
cd background-agents

# 1. Pull latest
git pull origin main

# 2. Clean + rebuild shared package (IMPORTANT: clean first to avoid stale files)
rm -rf packages/shared/dist
npm install
npm run build -w @open-inspect/shared

# 3. Deploy infra (workers, KV, D1 migrations, Modal)
cd terraform/environments/production
terraform init        # only needed if modules/providers changed
terraform apply       # review plan, then approve

# 4. Deploy web app (builds remotely on Vercel)
cd ../../..
npx vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```

## Deploy Individual Components

### Control plane worker only
```bash
rm -rf packages/shared/dist && npm run build -w @open-inspect/shared
cd terraform/environments/production
terraform apply -target=null_resource.control_plane_build -target=module.control_plane_worker
```

### Web app only
```bash
npx vercel deploy --prod --yes --token "$VERCEL_TOKEN"
```

### Modal sandbox runner only
```bash
cd terraform/environments/production
terraform apply -target=module.modal_app
```

### D1 migrations only
```bash
cd terraform/environments/production
terraform apply -target=null_resource.d1_migrations
```

## Gotchas

### Stale shared dist files
Always `rm -rf packages/shared/dist` before rebuilding. TypeScript generates both `dist/types.js` (empty barrel) and `dist/types/index.js` (actual exports). If both exist, esbuild resolves the wrong one and you get "No matching export" errors.

### Durable Object migrations (new DO classes)
Adding a new Durable Object class requires a two-phase deploy:

1. **Phase 1** — Set `enable_durable_object_bindings = false` in tfvars, then `terraform apply`. This creates the worker version with DO migration metadata (declares new classes) but without bindings.

2. **Phase 2** — Set `enable_durable_object_bindings = true`, then `terraform apply` again. This adds the DO bindings to the worker.

For a completely fresh deployment, also set:
- `migration_old_tag = ""` (no previous tag)
- `migration_tag = "v1"`
- `new_sqlite_classes = ["SessionDO", "SchedulerDO"]` (all classes)

Then after Phase 2 succeeds, restore to incremental values (`old_tag = "v1"`, `tag = "v2"`, etc.).

### Circular worker dependencies
If workers reference each other via service bindings, you can't delete them normally. Fix:
1. Upload a stub worker via the Cloudflare API to remove bindings
2. Delete the dependent workers
3. Delete the stub

```bash
# Upload stub to break circular deps
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/scripts/$WORKER_NAME" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F "metadata=@metadata.json;type=application/json" \
  -F "worker.js=@stub.js;type=application/javascript+module"
```

### Vercel deploys from repo root
The Vercel project uses `root_directory = "packages/web"` with install command `cd ../.. && npm install && npm run build -w @open-inspect/shared`. Always deploy from the repo root, not `packages/web`.

## URLs

| Service | URL |
|---------|-----|
| Control plane | https://open-inspect-control-plane-carboncopy.carboncopy.workers.dev |
| Web dashboard | https://open-inspect-carboncopy.vercel.app |
| Modal health | https://bence--open-inspect-api-health.modal.run |

## Terraform State

State is stored in Cloudflare R2 bucket `open-inspect-terraform-state`. The D1 database (`c112517a-bb7c-4970-aa92-96f2b7c2c7be`) contains persistent data — don't destroy it without backing up.

## Known Issues

### Workers.dev URL includes account subdomain
The correct URL format is `<worker-name>.<account-subdomain>.workers.dev`, e.g. `open-inspect-control-plane-carboncopy.carboncopy.workers.dev`. The terraform output currently omits the account subdomain (`carboncopy`) — don't trust it blindly.
