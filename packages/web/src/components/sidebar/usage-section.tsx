"use client";

import type { SessionState } from "@open-inspect/shared";

interface UsageSectionProps {
  totalTokens?: number;
  totalCost?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number): string {
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function UsageSection({ totalTokens = 0, totalCost = 0 }: UsageSectionProps) {

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Tokens</p>
          <p className="text-sm font-medium text-foreground font-mono">
            {formatTokens(totalTokens)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Cost</p>
          <p className="text-sm font-medium text-foreground font-mono">
            {formatCost(totalCost)}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Compact inline usage for the header bar */
export function UsagePill({ totalTokens = 0, totalCost = 0 }: UsageSectionProps) {

  return (
    <span className="text-xs text-muted-foreground font-mono">
      {formatTokens(totalTokens)} · {formatCost(totalCost)}
    </span>
  );
}
