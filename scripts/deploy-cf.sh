#!/usr/bin/env bash
# Deploy CF Worker: terraform apply + restore secrets
# Usage: ./scripts/deploy-cf.sh
set -euo pipefail

cd "$(dirname "$0")/../terraform/environments/production"

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-8U8YofBueIIea51Nlz8gJPRKOCy8rD9A0nl5N8q-}"
WORKER_NAME="open-inspect-control-plane-carboncopy"
TFVARS="terraform.tfvars"

echo "=== Building control-plane ==="
cd "$(dirname "$0")/.."
npm run build -w @open-inspect/control-plane
cd terraform/environments/production

echo "=== Terraform taint + apply ==="
terraform taint 'module.control_plane_worker.cloudflare_worker_version.this'
terraform taint 'module.control_plane_worker.cloudflare_workers_deployment.this'
terraform apply \
  -target='module.control_plane_worker.cloudflare_worker_version.this' \
  -target='module.control_plane_worker.cloudflare_workers_deployment.this' \
  -auto-approve

echo "=== Restoring secrets ==="
echo "O02x8XYej0l4SyA9ijPoYITp7lRCjanRlf5Es44TH7w=" | npx wrangler secret put TOKEN_ENCRYPTION_KEY --name "$WORKER_NAME"
echo "flBrzqJbzO7D0onNSoZuO+NnGEFnoQjpovB9JoqG3Nc=" | npx wrangler secret put REPO_SECRETS_ENCRYPTION_KEY --name "$WORKER_NAME"
echo "7fc0f4b9724e7f4b9b9287868cd6090aeab7f0f30e0570581f2c3dcc61c07e95" | npx wrangler secret put INTERNAL_CALLBACK_SECRET --name "$WORKER_NAME"
echo "867f0c9c6b98b382a35dcbfc011fd71aedd003ec2e7c1d1459122bc2fe2d1f25" | npx wrangler secret put MODAL_API_SECRET --name "$WORKER_NAME"
echo "ak-HSSXoyYSCbkZtXcwSJutTC" | npx wrangler secret put MODAL_TOKEN_ID --name "$WORKER_NAME"
echo "as-8hVMwsoeBfnIEh0xUeJkYB" | npx wrangler secret put MODAL_TOKEN_SECRET --name "$WORKER_NAME"
echo "2895902" | npx wrangler secret put GITHUB_APP_ID --name "$WORKER_NAME"
echo "110995518,115973319" | npx wrangler secret put GITHUB_APP_INSTALLATION_ID --name "$WORKER_NAME"
grep 'github_client_secret' "$TFVARS" | head -1 | sed 's/.*= *"//' | sed 's/"$//' | npx wrangler secret put GITHUB_CLIENT_SECRET --name "$WORKER_NAME"
sed -n '/github_app_private_key/,/^EOF/p' "$TFVARS" | sed '1d;$d' | npx wrangler secret put GITHUB_APP_PRIVATE_KEY --name "$WORKER_NAME"

echo "=== Done ==="
