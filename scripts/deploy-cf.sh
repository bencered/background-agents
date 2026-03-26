#!/usr/bin/env bash
# Deploy CF Workers: terraform apply + restore secrets
# Usage: ./scripts/deploy-cf.sh [--linear-bot-only | --control-plane-only]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-8U8YofBueIIea51Nlz8gJPRKOCy8rD9A0nl5N8q-}"
CP_WORKER="open-inspect-control-plane-carboncopy"
LB_WORKER="open-inspect-linear-bot-carboncopy"
TFVARS="$REPO_ROOT/terraform/environments/production/terraform.tfvars"
TFDIR="$REPO_ROOT/terraform/environments/production"

DEPLOY_CP=true
DEPLOY_LB=true
if [[ "${1:-}" == "--linear-bot-only" ]]; then DEPLOY_CP=false; fi
if [[ "${1:-}" == "--control-plane-only" ]]; then DEPLOY_LB=false; fi

# ─── Build ────────────────────────────────────────────────────────────────────
echo "=== Building shared ==="
npm run build -w @open-inspect/shared

if $DEPLOY_CP; then
  echo "=== Building control-plane ==="
  npm run build -w @open-inspect/control-plane
fi
if $DEPLOY_LB; then
  echo "=== Building linear-bot ==="
  npm run build -w @open-inspect/linear-bot
fi

# ─── Terraform ────────────────────────────────────────────────────────────────
cd "$TFDIR"

TARGETS=()
if $DEPLOY_CP; then
  terraform taint 'module.control_plane_worker.cloudflare_worker.this' || true
  TARGETS+=(-target='module.control_plane_worker')
fi
if $DEPLOY_LB; then
  terraform taint 'module.linear_bot_worker[0].cloudflare_worker_version.this' || true
  terraform taint 'module.linear_bot_worker[0].cloudflare_workers_deployment.this' || true
  TARGETS+=(-target='module.linear_bot_worker[0]')
fi

echo "=== Terraform apply ==="
terraform apply "${TARGETS[@]}" -auto-approve

# ─── Restore Secrets ──────────────────────────────────────────────────────────
if $DEPLOY_CP; then
  echo "=== Restoring control-plane secrets ==="
  echo "O02x8XYej0l4SyA9ijPoYITp7lRCjanRlf5Es44TH7w=" | npx wrangler secret put TOKEN_ENCRYPTION_KEY --name "$CP_WORKER"
  echo "flBrzqJbzO7D0onNSoZuO+NnGEFnoQjpovB9JoqG3Nc=" | npx wrangler secret put REPO_SECRETS_ENCRYPTION_KEY --name "$CP_WORKER"
  echo "7fc0f4b9724e7f4b9b9287868cd6090aeab7f0f30e0570581f2c3dcc61c07e95" | npx wrangler secret put INTERNAL_CALLBACK_SECRET --name "$CP_WORKER"
  echo "867f0c9c6b98b382a35dcbfc011fd71aedd003ec2e7c1d1459122bc2fe2d1f25" | npx wrangler secret put MODAL_API_SECRET --name "$CP_WORKER"
  echo "ak-HSSXoyYSCbkZtXcwSJutTC" | npx wrangler secret put MODAL_TOKEN_ID --name "$CP_WORKER"
  echo "as-8hVMwsoeBfnIEh0xUeJkYB" | npx wrangler secret put MODAL_TOKEN_SECRET --name "$CP_WORKER"
  echo "2895902" | npx wrangler secret put GITHUB_APP_ID --name "$CP_WORKER"
  echo "110995518,115973319" | npx wrangler secret put GITHUB_APP_INSTALLATION_ID --name "$CP_WORKER"
  grep 'github_client_secret' "$TFVARS" | head -1 | sed 's/.*= *"//' | sed 's/"$//' | npx wrangler secret put GITHUB_CLIENT_SECRET --name "$CP_WORKER"
  sed -n '/github_app_private_key/,/^EOF/p' "$TFVARS" | sed '1d;$d' | npx wrangler secret put GITHUB_APP_PRIVATE_KEY --name "$CP_WORKER"
fi

if $DEPLOY_LB; then
  echo "=== Restoring linear-bot secrets ==="
  grep 'linear_webhook_secret' "$TFVARS" | head -1 | sed 's/.*= *"//' | sed 's/"$//' | npx wrangler secret put LINEAR_WEBHOOK_SECRET --name "$LB_WORKER"
  grep 'linear_client_secret' "$TFVARS" | head -1 | sed 's/.*= *"//' | sed 's/"$//' | npx wrangler secret put LINEAR_CLIENT_SECRET --name "$LB_WORKER"
  echo "7fc0f4b9724e7f4b9b9287868cd6090aeab7f0f30e0570581f2c3dcc61c07e95" | npx wrangler secret put INTERNAL_CALLBACK_SECRET --name "$LB_WORKER"
fi

echo "=== Deploy complete ==="
