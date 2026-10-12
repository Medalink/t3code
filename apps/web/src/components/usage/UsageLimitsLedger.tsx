import {
  formatDuration,
  type LimitAccount,
  limitAccountStatus,
  type LimitPool,
} from "@t3tools/shared/usageLimits";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { providerClients } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { LimitWindows, ResetCredits } from "./UsageLimits";
import { AccountAvatar } from "./UsageLimitsAccount";

function refreshTargets(account: LimitAccount) {
  const native = account.reportedBy.filter((reporter) => reporter.instanceId !== null);
  const targets = native.length > 0 ? native : account.reportedBy;
  return [
    ...new Map(
      targets.map((target) => [`${target.environmentId}\u0000${target.instanceId ?? ""}`, target]),
    ).values(),
  ];
}

function LedgerRow({ account, now }: { readonly account: LimitAccount; readonly now: number }) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const status = limitAccountStatus(account, now);
  const provider = providerClients.get(account.driver)?.label ?? String(account.driver);
  const name = account.displayName ?? provider;
  const refresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all(
        refreshTargets(account).map(({ environmentId, instanceId }) =>
          refreshProviders({ environmentId, input: instanceId === null ? {} : { instanceId } }),
        ),
      );
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="grid gap-x-6 gap-y-3 py-3 md:grid-cols-[13rem_minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-0.5 text-xs">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">{name}</span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit"
          />
        ) : null}
        <span className="text-muted-foreground">
          {provider}
          {status.exhausted ? (
            <span className="text-destructive">
              {" · "}
              {status.backAt === null
                ? "out of quota"
                : `back in ${formatDuration(status.backAt - now)}`}
            </span>
          ) : null}
        </span>
        {Number.isFinite(status.lastSeenAt) ? (
          <span className="text-muted-foreground tabular-nums">
            Last seen {formatDayAwareTimestamp(account.limits.checkedAt, timestampFormat, now)}
          </span>
        ) : null}
      </div>
      <LimitWindows driver={account.driver} windows={account.limits.windows} now={now} compact />
      <div className="flex flex-col items-start gap-1 md:items-end">
        <Button
          variant="ghost-muted"
          size="xs"
          aria-label={`Refresh quota for ${name}`}
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshIcon refreshing={refreshing} />
          Refresh quota
        </Button>
        {account.redeem && account.limits.resetCredits ? (
          <ResetCredits
            environmentId={account.redeem.environmentId}
            input={account.redeem.input}
            credits={account.limits.resetCredits}
            now={now}
          />
        ) : null}
      </div>
    </div>
  );
}

/** Every account in the pool, one row each, in the pool's order. */
export function LimitLedger({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  return (
    <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60 px-4">
      {pool.accounts.map((account) => (
        <LedgerRow key={account.key} account={account} now={now} />
      ))}
    </div>
  );
}
