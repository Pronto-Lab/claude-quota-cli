import type { ModelQuota } from "./quota-client.js";

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

  const embed = {
    title: `${emoji} Claude Quota Alert: ${quota.period}`,
    description: `Usage exceeded **${threshold}%**`,
    color,
    fields: [
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
    ],
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
