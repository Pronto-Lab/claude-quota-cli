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

async function postToWebhooks(
  webhookUrls: string[],
  body: Record<string, unknown>,
): Promise<void> {
  const results = await Promise.allSettled(
    webhookUrls.map(async (url) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`Discord webhook failed (${response.status}): ${url}`);
      }
    }),
  );
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length === webhookUrls.length) {
    throw new Error(
      `All webhooks failed: ${(failures[0] as PromiseRejectedResult).reason}`,
    );
  }
}

export async function sendDiscordAlert(
  webhookUrls: string | string[],
  quota: ModelQuota,
  threshold: number,
  snapshot?: QuotaSnapshot,
): Promise<void> {
  const urls = Array.isArray(webhookUrls) ? webhookUrls : [webhookUrls];
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

  const periodLabel = quota.period === "5-hour" ? "5시간" : "7일";

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    {
      name: "구간",
      value: periodLabel,
      inline: true,
    },
    {
      name: "사용량",
      value: `${quota.utilization.toFixed(1)}%`,
      inline: true,
    },
    {
      name: "리셋까지",
      value: quota.timeUntilResetFormatted,
      inline: true,
    },
    { name: "리셋 시각", value: quota.resetTimeDisplay, inline: true },
  ];

  if (quota.period === "5-hour" && snapshot?.sevenDay) {
    const sd = snapshot.sevenDay;
    fields.push(
      { name: "\u200B", value: "**── 주간 현황 ──**", inline: false },
      {
        name: "주간 사용량",
        value: `${sd.utilization.toFixed(1)}%`,
        inline: true,
      },
      {
        name: "주간 리셋까지",
        value: sd.timeUntilResetFormatted,
        inline: true,
      },
      {
        name: "주간 리셋 시각",
        value: formatDateTimeKST(sd.resetTime),
        inline: true,
      },
    );
  }

  const embed = {
    title: `${emoji} Claude Quota Alert`,
    description: `${periodLabel} 사용량이 **${threshold}%**를 초과했습니다`,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };

  await postToWebhooks(urls, { embeds: [embed] });
}

export async function sendDailyReport(
  webhookUrls: string | string[],
  snapshot: QuotaSnapshot,
): Promise<void> {
  const urls = Array.isArray(webhookUrls) ? webhookUrls : [webhookUrls];
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  if (snapshot.fiveHour) {
    const fh = snapshot.fiveHour;
    const bar = makeBar(fh.utilization);
    fields.push(
      {
        name: "⏱️ 5시간 사용량",
        value: `${bar} **${fh.utilization.toFixed(1)}%**`,
        inline: false,
      },
      {
        name: "리셋까지",
        value: fh.timeUntilResetFormatted,
        inline: true,
      },
      {
        name: "리셋 시각",
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
        name: "📅 주간 사용량",
        value: `${bar} **${sd.utilization.toFixed(1)}%**`,
        inline: false,
      },
      {
        name: "리셋까지",
        value: sd.timeUntilResetFormatted,
        inline: true,
      },
      {
        name: "리셋 시각",
        value: formatDateTimeKST(sd.resetTime),
        inline: true,
      },
      { name: "\u200B", value: "\u200B", inline: true },
    );
  }

  const embed = {
    title: "📊 Claude Daily Quota Report",
    description: `일일 현황 리포트 — ${formatDateKST(new Date())}`,
    color: 0x5865f2,
    fields,
    footer: { text: "claude-quota-cli" },
    timestamp: new Date().toISOString(),
  };

  await postToWebhooks(urls, { embeds: [embed] });
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
