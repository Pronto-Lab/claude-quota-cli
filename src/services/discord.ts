import type { ModelQuota, QuotaSnapshot, CombinedQuotaSnapshot } from "./quota-client.js";
import type { OpenAIModelQuota, OpenAIQuotaSnapshot } from "./openai-quota-client.js";

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

function getAlertStyle(threshold: number): { color: number; emoji: string } {
  if (threshold >= 80) return { color: 0xff0000, emoji: "🔴" };
  if (threshold >= 60) return { color: 0xff8c00, emoji: "🟠" };
  if (threshold >= 40) return { color: 0xffd700, emoji: "🟡" };
  return { color: 0x00ff00, emoji: "🟢" };
}

// Claude alert
export async function sendDiscordAlert(
  webhookUrls: string | string[],
  quota: ModelQuota,
  threshold: number,
  snapshot?: QuotaSnapshot,
): Promise<void> {
  const urls = Array.isArray(webhookUrls) ? webhookUrls : [webhookUrls];
  const { color, emoji } = getAlertStyle(threshold);

  const periodLabel = quota.period === "5-hour" ? "5시간" : "7일";

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "구간", value: periodLabel, inline: true },
    { name: "사용량", value: `${quota.utilization.toFixed(1)}%`, inline: true },
    { name: "리셋까지", value: quota.timeUntilResetFormatted, inline: true },
    { name: "리셋 시각", value: quota.resetTimeDisplay, inline: true },
  ];

  if (quota.period === "5-hour" && snapshot?.sevenDay) {
    const sd = snapshot.sevenDay;
    fields.push(
      { name: "\u200B", value: "**── 주간 현황 ──**", inline: false },
      { name: "주간 사용량", value: `${sd.utilization.toFixed(1)}%`, inline: true },
      { name: "주간 리셋까지", value: sd.timeUntilResetFormatted, inline: true },
      { name: "주간 리셋 시각", value: formatDateTimeKST(sd.resetTime), inline: true },
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

// OpenAI alert
export async function sendOpenAIDiscordAlert(
  webhookUrls: string | string[],
  quota: OpenAIModelQuota,
  threshold: number,
  snapshot?: OpenAIQuotaSnapshot,
): Promise<void> {
  const urls = Array.isArray(webhookUrls) ? webhookUrls : [webhookUrls];
  const { color, emoji } = getAlertStyle(threshold);

  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "구간", value: quota.period, inline: true },
    { name: "사용량", value: `${quota.utilization.toFixed(1)}%`, inline: true },
    { name: "리셋까지", value: quota.timeUntilResetFormatted, inline: true },
    { name: "리셋 시각", value: quota.resetTimeDisplay, inline: true },
  ];

  if (snapshot) {
    const other = quota.period.includes("hour")
      ? snapshot.secondary
      : snapshot.primary;
    if (other) {
      fields.push(
        { name: "\u200B", value: `**── ${other.period} 현황 ──**`, inline: false },
        { name: `${other.period} 사용량`, value: `${other.utilization.toFixed(1)}%`, inline: true },
        { name: `${other.period} 리셋까지`, value: other.timeUntilResetFormatted, inline: true },
        { name: `${other.period} 리셋 시각`, value: formatDateTimeKST(other.resetTime), inline: true },
      );
    }
  }

  const planLabel = snapshot?.planType ? ` (${snapshot.planType})` : "";
  const embed = {
    title: `${emoji} OpenAI Quota Alert${planLabel}`,
    description: `${quota.period} 사용량이 **${threshold}%**를 초과했습니다`,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };

  await postToWebhooks(urls, { embeds: [embed] });
}

// Combined daily report
export async function sendDailyReport(
  webhookUrls: string | string[],
  combined: CombinedQuotaSnapshot,
): Promise<void> {
  const urls = Array.isArray(webhookUrls) ? webhookUrls : [webhookUrls];
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  // Claude section
  const claude = combined.claude;
  if (claude) {
    fields.push({ name: "☁️ **Claude**", value: "\u200B", inline: false });

    if (claude.fiveHour) {
      const fh = claude.fiveHour;
      const bar = makeBar(fh.utilization);
      fields.push(
        { name: "⏱️ 5시간 사용량", value: `${bar} **${fh.utilization.toFixed(1)}%**`, inline: false },
        { name: "리셋까지", value: fh.timeUntilResetFormatted, inline: true },
        { name: "리셋 시각", value: fh.resetTimeDisplay, inline: true },
        { name: "\u200B", value: "\u200B", inline: true },
      );
    }

    if (claude.sevenDay) {
      const sd = claude.sevenDay;
      const bar = makeBar(sd.utilization);
      fields.push(
        { name: "📅 주간 사용량", value: `${bar} **${sd.utilization.toFixed(1)}%**`, inline: false },
        { name: "리셋까지", value: sd.timeUntilResetFormatted, inline: true },
        { name: "리셋 시각", value: formatDateTimeKST(sd.resetTime), inline: true },
        { name: "\u200B", value: "\u200B", inline: true },
      );
    }
  }

  // OpenAI section
  const openai = combined.openai;
  if (openai) {
    const planLabel = openai.planType ? ` (${openai.planType})` : "";
    fields.push({ name: `🤖 **OpenAI Codex${planLabel}**`, value: "\u200B", inline: false });

    if (openai.primary) {
      const p = openai.primary;
      const bar = makeBar(p.utilization);
      fields.push(
        { name: `⏱️ ${p.period} 사용량`, value: `${bar} **${p.utilization.toFixed(1)}%**`, inline: false },
        { name: "리셋까지", value: p.timeUntilResetFormatted, inline: true },
        { name: "리셋 시각", value: p.resetTimeDisplay, inline: true },
        { name: "\u200B", value: "\u200B", inline: true },
      );
    }

    if (openai.secondary) {
      const s = openai.secondary;
      const bar = makeBar(s.utilization);
      fields.push(
        { name: `📅 ${s.period} 사용량`, value: `${bar} **${s.utilization.toFixed(1)}%**`, inline: false },
        { name: "리셋까지", value: s.timeUntilResetFormatted, inline: true },
        { name: "리셋 시각", value: formatDateTimeKST(s.resetTime), inline: true },
        { name: "\u200B", value: "\u200B", inline: true },
      );
    }
  }

  const embed = {
    title: "📊 AI Quota Daily Report",
    description: `일일 현황 리포트 — ${formatDateKST(new Date())}`,
    color: 0x5865f2,
    fields,
    footer: { text: "ai-quota-cli" },
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
