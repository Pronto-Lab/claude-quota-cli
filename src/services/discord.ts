import type { ModelQuota, QuotaSnapshot } from "./quota-client.js";

const THRESHOLDS = [80, 60, 40, 20];

export function getThresholdForPercentage(utilization: number): number | null {
  for (const threshold of THRESHOLDS) {
    if (utilization >= threshold && utilization < threshold + 20) {
      return threshold;
    }
  }
  if (utilization >= 80) return 80;
  return null;
}

export async function sendDiscordAlert(
  webhookUrl: string,
  quota: ModelQuota,
  threshold: number,
  snapshot?: QuotaSnapshot,
): Promise<void> {
  let color: number;
  let emoji: string;

  if (threshold >= 80) {
    color = 0xff0000;
    emoji = "🔴";
  } else if (threshold >= 60) {
    color = 0xff8c00;
    emoji = "🟠";
  } else if (threshold >= 40) {
    color = 0xffd700;
    emoji = "🟡";
  } else {
    color = 0x00ff00;
    emoji = "🟢";
  }

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    {
      name: "Utilization",
      value: `${quota.utilization.toFixed(1)}%`,
      inline: true,
    },
    {
      name: "Reset In",
      value: quota.timeUntilResetFormatted,
      inline: true,
    },
    { name: "Reset At", value: quota.resetTimeDisplay, inline: true },
  ];

  // Include 7-day info when alerting on 5-hour window
  if (quota.period === "5-hour" && snapshot?.sevenDay) {
    const sd = snapshot.sevenDay;
    fields.push(
      { name: "\u200B", value: "**── 7-Day Window ──**", inline: false },
      {
        name: "Weekly Usage",
        value: `${sd.utilization.toFixed(1)}%`,
        inline: true,
      },
      {
        name: "Weekly Reset In",
        value: sd.timeUntilResetFormatted,
        inline: true,
      },
      {
        name: "Weekly Reset At",
        value: formatDateTimeKST(sd.resetTime),
        inline: true,
      },
    );
  }

  const embed = {
    title: `${emoji} Claude Quota Alert: ${quota.period}`,
    description: `Usage exceeded **${threshold}%**`,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook failed: ${response.status}`);
  }
}

export async function sendDailyReport(
  webhookUrl: string,
  snapshot: QuotaSnapshot,
): Promise<void> {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  if (snapshot.fiveHour) {
    const fh = snapshot.fiveHour;
    const bar = makeBar(fh.utilization);
    fields.push(
      {
        name: "⏱️ 5-Hour Window",
        value: `${bar} **${fh.utilization.toFixed(1)}%**`,
        inline: false,
      },
      {
        name: "Reset In",
        value: fh.timeUntilResetFormatted,
        inline: true,
      },
      {
        name: "Reset At",
        value: fh.resetTimeDisplay,
        inline: true,
      },
      { name: "\u200B", value: "\u200B", inline: true },
    );
  }

  if (snapshot.sevenDay) {
    const sd = snapshot.sevenDay;
    const bar = makeBar(sd.utilization);
    fields.push(
      {
        name: "📅 7-Day Window",
        value: `${bar} **${sd.utilization.toFixed(1)}%**`,
        inline: false,
      },
      {
        name: "Reset In",
        value: sd.timeUntilResetFormatted,
        inline: true,
      },
      {
        name: "Reset At",
        value: formatDateTimeKST(sd.resetTime),
        inline: true,
      },
      { name: "\u200B", value: "\u200B", inline: true },
    );
  }

  const embed = {
    title: "📊 Claude Daily Quota Report",
    description: `Daily status update — ${formatDateKST(new Date())}`,
    color: 0x5865f2,
    fields,
    footer: { text: "claude-quota-cli" },
    timestamp: new Date().toISOString(),
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!response.ok) {
    throw new Error(`Discord daily report webhook failed: ${response.status}`);
  }
}

function makeBar(pct: number): string {
  const filled = Math.round((pct / 100) * 10);
  const empty = 10 - filled;
  return "▓".repeat(filled) + "░".repeat(empty);
}

function formatDateKST(date: Date): string {
  return date.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    timeZone: "Asia/Seoul",
  });
}

function formatDateTimeKST(date: Date): string {
  return date.toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  });
}
