#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import Table from "cli-table3";
import {
  loadConfig,
  saveConfig,
  loadAlertState,
  saveAlertState,
  resetAlertState,
  getConfigPath,
  getWebhookUrls,
  type Config,
} from "./services/config.js";
import {
  QuotaClient,
  type QuotaSnapshot,
  type ModelQuota,
  type CombinedQuotaSnapshot,
} from "./services/quota-client.js";
import {
  OpenAIQuotaClient,
  type OpenAIQuotaSnapshot,
  type OpenAIModelQuota,
} from "./services/openai-quota-client.js";
import {
  sendDiscordAlert,
  sendOpenAIDiscordAlert,
  sendDailyReport,
  getThresholdForPercentage,
} from "./services/discord.js";

const program = new Command();

program
  .name("ai-quota")
  .description("CLI tool for monitoring AI subscription quotas (Claude, OpenAI)")
  .version("2.0.0");

program
  .command("config")
  .description("Configure credentials")
  .option("--session-key <key>", "Claude.ai sessionKey cookie value")
  .option("--org-id <id>", "Claude.ai organization ID")
  .option("--openai-token <token>", "OpenAI OAuth access token")
  .option("--openai-refresh-token <token>", "OpenAI OAuth refresh token")
  .option("--openai-account-id <id>", "ChatGPT account ID (optional)")
  .option("--webhook <url>", "Discord webhook URL for alerts")
  .option("--webhook-add <url>", "Add an additional Discord webhook URL")
  .option("--webhook-remove <url>", "Remove a Discord webhook URL")
  .option("--webhook-list", "List configured webhook URLs")
  .action(
    (options: {
      sessionKey?: string;
      orgId?: string;
      openaiToken?: string;
      openaiRefreshToken?: string;
      openaiAccountId?: string;
      webhook?: string;
      webhookAdd?: string;
      webhookRemove?: string;
      webhookList?: boolean;
    }) => {
      const existing = loadConfig();

      if (options.webhookList && existing) {
        const urls = getWebhookUrls(existing);
        if (urls.length === 0) {
          console.log(chalk.yellow("No webhooks configured."));
        } else {
          console.log(chalk.cyan("Configured webhooks:"));
          urls.forEach((url, i) => console.log(`  ${i + 1}. ${url}`));
        }
        return;
      }

      const webhooks = new Set<string>(existing?.discordWebhooks || []);
      if (existing?.discordWebhook) webhooks.add(existing.discordWebhook);
      if (options.webhook) webhooks.add(options.webhook);
      if (options.webhookAdd) webhooks.add(options.webhookAdd);
      if (options.webhookRemove) webhooks.delete(options.webhookRemove);

      const webhookArray = [...webhooks];

      const config: Config = {
        ...existing,
        ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
        ...(options.orgId ? { organizationId: options.orgId } : {}),
        ...(webhookArray.length > 0 ? { discordWebhooks: webhookArray } : {}),
      };

      if (options.openaiToken && options.openaiRefreshToken) {
        config.openai = {
          accessToken: options.openaiToken,
          refreshToken: options.openaiRefreshToken,
          ...(options.openaiAccountId
            ? { accountId: options.openaiAccountId }
            : {}),
        };
      } else if (options.openaiToken || options.openaiRefreshToken) {
        console.error(
          chalk.red(
            "Both --openai-token and --openai-refresh-token are required together.",
          ),
        );
        process.exit(1);
      }

      saveConfig(config);
      console.log(chalk.green("✓ Configuration saved to " + getConfigPath()));

      if (config.sessionKey) {
        console.log(chalk.gray("  Claude: configured"));
      }
      if (config.openai) {
        console.log(chalk.gray("  OpenAI: configured"));
      }
      if (webhookArray.length > 0) {
        console.log(
          chalk.gray(`  ${webhookArray.length} webhook(s) configured`),
        );
      }
    },
  );

program
  .command("status")
  .description("Show current quota status")
  .option("-j, --json", "Output as JSON")
  .option("--claude-only", "Show Claude only")
  .option("--openai-only", "Show OpenAI only")
  .action(
    async (options: {
      json?: boolean;
      claudeOnly?: boolean;
      openaiOnly?: boolean;
    }) => {
      const config = loadConfig();
      if (!config) {
        console.error(
          chalk.red(
            "Not configured. Run: ai-quota config --session-key <key> --org-id <id>",
          ),
        );
        process.exit(1);
      }

      const spinner = ora("Fetching quota data...").start();
      const combined: CombinedQuotaSnapshot = { timestamp: new Date() };
      let claudeClient: QuotaClient | null = null;
      let openaiClient: OpenAIQuotaClient | null = null;

      try {
        const hasClaude = config.sessionKey && config.organizationId;
        const hasOpenAI = config.openai?.accessToken && config.openai?.refreshToken;

        if (hasClaude && !options.openaiOnly) {
          claudeClient = new QuotaClient(
            config.sessionKey!,
            config.organizationId!,
          );
          combined.claude = await claudeClient.fetchQuota();
        }

        if (hasOpenAI && !options.claudeOnly) {
          openaiClient = new OpenAIQuotaClient(
            config.openai!.accessToken,
            config.openai!.refreshToken,
            config.openai!.accountId,
          );
          combined.openai = await openaiClient.fetchQuota();
        }

        spinner.stop();

        if (!combined.claude && !combined.openai) {
          console.error(
            chalk.red("No providers configured or selected."),
          );
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(combined, null, 2));
        } else {
          if (combined.claude) displayClaudeQuotaTable(combined.claude);
          if (combined.openai) displayOpenAIQuotaTable(combined.openai);
        }
      } catch (error) {
        spinner.fail(
          chalk.red(
            `Error: ${error instanceof Error ? error.message : error}`,
          ),
        );
        process.exit(1);
      } finally {
        await claudeClient?.dispose();
        await openaiClient?.dispose();
      }
    },
  );

program
  .command("watch")
  .description("Watch mode - refresh periodically")
  .option("-i, --interval <seconds>", "Refresh interval in seconds", "60")
  .option("--claude-only", "Watch Claude only")
  .option("--openai-only", "Watch OpenAI only")
  .action(
    async (options: {
      interval: string;
      claudeOnly?: boolean;
      openaiOnly?: boolean;
    }) => {
      const config = loadConfig();
      if (!config) {
        console.error(chalk.red("Not configured."));
        process.exit(1);
      }

      const intervalMs = parseInt(options.interval) * 1000;
      console.log(
        chalk.gray(
          `Watch mode (refreshing every ${options.interval}s). Ctrl+C to exit.\n`,
        ),
      );

      const hasClaude = config.sessionKey && config.organizationId;
      const hasOpenAI =
        config.openai?.accessToken && config.openai?.refreshToken;

      const claudeClient =
        hasClaude && !options.openaiOnly
          ? new QuotaClient(config.sessionKey!, config.organizationId!)
          : null;
      const openaiClient =
        hasOpenAI && !options.claudeOnly
          ? new OpenAIQuotaClient(
              config.openai!.accessToken,
              config.openai!.refreshToken,
              config.openai!.accountId,
            )
          : null;

      const refresh = async () => {
        try {
          console.clear();
          console.log(
            chalk.gray(
              `Last updated: ${new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}\n`,
            ),
          );

          if (claudeClient) {
            const snapshot = await claudeClient.fetchQuota();
            displayClaudeQuotaTable(snapshot);
          }
          if (openaiClient) {
            const snapshot = await openaiClient.fetchQuota();
            displayOpenAIQuotaTable(snapshot);
          }
        } catch (error) {
          console.error(
            chalk.red(
              `Error: ${error instanceof Error ? error.message : error}`,
            ),
          );
        }
      };

      await refresh();
      const timer = setInterval(refresh, intervalMs);

      process.on("SIGINT", async () => {
        clearInterval(timer);
        await claudeClient?.dispose();
        await openaiClient?.dispose();
        process.exit(0);
      });
    },
  );

program
  .command("monitor")
  .description(
    "Monitor quotas and send Discord alerts at thresholds (80%, 60%, 40%, 20%)",
  )
  .option("--webhook <url>", "Discord webhook URL (or use config)")
  .option("--interval <minutes>", "Check interval in minutes", "5")
  .option("--once", "Run once and exit (for cron)")
  .option("--reset-state", "Reset alert state")
  .option(
    "--daily-report-hour <hour>",
    "Send daily report at this hour (0-23, KST)",
    "9",
  )
  .action(
    async (options: {
      webhook?: string;
      interval: string;
      once?: boolean;
      resetState?: boolean;
      dailyReportHour: string;
    }) => {
      const config = loadConfig();
      if (!config) {
        console.error(chalk.red("Not configured."));
        process.exit(1);
      }

      const webhookUrls = getWebhookUrls(config);
      if (options.webhook) webhookUrls.push(options.webhook);
      if (process.env.DISCORD_WEBHOOK)
        webhookUrls.push(process.env.DISCORD_WEBHOOK);
      const uniqueUrls = [...new Set(webhookUrls)];
      if (uniqueUrls.length === 0) {
        console.error(
          chalk.red(
            "Discord webhook required. Use --webhook, config, or DISCORD_WEBHOOK env var.",
          ),
        );
        process.exit(1);
      }

      if (options.resetState) {
        resetAlertState();
        console.log(chalk.green("Alert state reset."));
      }

      const hasClaude = config.sessionKey && config.organizationId;
      const hasOpenAI =
        config.openai?.accessToken && config.openai?.refreshToken;

      const claudeClient = hasClaude
        ? new QuotaClient(config.sessionKey!, config.organizationId!)
        : null;
      const openaiClient = hasOpenAI
        ? new OpenAIQuotaClient(
            config.openai!.accessToken,
            config.openai!.refreshToken,
            config.openai!.accountId,
          )
        : null;

      const dailyReportHour = parseInt(options.dailyReportHour);
      let lastDailyReportDate = "";

      const checkDailyReport = async (
        combined: CombinedQuotaSnapshot,
        timestamp: string,
      ) => {
        const now = new Date();
        const kstHour = parseInt(
          now.toLocaleString("en-US", {
            hour: "numeric",
            hour12: false,
            timeZone: "Asia/Seoul",
          }),
        );
        const kstDate = now.toLocaleDateString("ko-KR", {
          timeZone: "Asia/Seoul",
        });

        if (kstHour === dailyReportHour && lastDailyReportDate !== kstDate) {
          lastDailyReportDate = kstDate;
          console.log(
            chalk.gray(`[${timestamp}]`),
            chalk.blue("Sending daily report..."),
          );
          await sendDailyReport(uniqueUrls, combined);
          console.log(
            chalk.gray(`[${timestamp}]`),
            chalk.blue("Daily report sent."),
          );
        }
      };

      const runOnce = async () => {
        const timestamp = new Date().toLocaleTimeString("ko-KR", {
          timeZone: "Asia/Seoul",
        });

        try {
          const state = loadAlertState();
          let alertsSent = 0;
          const combined: CombinedQuotaSnapshot = { timestamp: new Date() };

          if (claudeClient) {
            const snapshot = await claudeClient.fetchQuota();
            combined.claude = snapshot;

            for (const quota of [snapshot.fiveHour, snapshot.sevenDay]) {
              if (!quota) continue;

              const threshold = getThresholdForPercentage(quota.utilization);
              if (threshold === null) continue;

              const stateKey = `claude:${quota.period}`;
              const alertedThresholds = state[stateKey] || [];

              if (!alertedThresholds.includes(threshold)) {
                console.log(
                  chalk.gray(`[${timestamp}]`),
                  chalk.yellow(
                    `Claude alert: ${quota.period} at ${quota.utilization.toFixed(1)}% (threshold: ${threshold}%)`,
                  ),
                );

                await sendDiscordAlert(
                  uniqueUrls,
                  quota,
                  threshold,
                  snapshot,
                );
                state[stateKey] = [...alertedThresholds, threshold];
                alertsSent++;
              }

              if (quota.utilization < 20) {
                state[stateKey] = [];
              }
            }
          }

          if (openaiClient) {
            const snapshot = await openaiClient.fetchQuota();
            combined.openai = snapshot;

            for (const [key, quota] of [
              ["primary", snapshot.primary] as const,
              ["secondary", snapshot.secondary] as const,
            ]) {
              if (!quota) continue;

              const threshold = getThresholdForPercentage(quota.utilization);
              if (threshold === null) continue;

              const stateKey = `openai:${key}`;
              const alertedThresholds = state[stateKey] || [];

              if (!alertedThresholds.includes(threshold)) {
                console.log(
                  chalk.gray(`[${timestamp}]`),
                  chalk.yellow(
                    `OpenAI alert: ${quota.period} at ${quota.utilization.toFixed(1)}% (threshold: ${threshold}%)`,
                  ),
                );

                await sendOpenAIDiscordAlert(
                  uniqueUrls,
                  quota,
                  threshold,
                  snapshot,
                );
                state[stateKey] = [...alertedThresholds, threshold];
                alertsSent++;
              }

              if (quota.utilization < 20) {
                state[stateKey] = [];
              }
            }
          }

          saveAlertState(state);

          await checkDailyReport(combined, timestamp);

          if (alertsSent === 0) {
            console.log(
              chalk.gray(`[${timestamp}]`),
              chalk.green("All quotas OK"),
            );
          }
        } catch (error) {
          console.error(
            chalk.gray(`[${timestamp}]`),
            chalk.red(`Error: ${error}`),
          );
        }
      };

      if (options.once) {
        await runOnce();
        await claudeClient?.dispose();
        await openaiClient?.dispose();
        return;
      }

      const intervalMs = parseInt(options.interval) * 60 * 1000;
      const providers: string[] = [];
      if (claudeClient) providers.push("Claude");
      if (openaiClient) providers.push("OpenAI");
      console.log(
        chalk.cyan(
          `🔍 Monitoring ${providers.join(" + ")} quotas (every ${options.interval} min, daily report at ${dailyReportHour}:00 KST). Ctrl+C to exit.`,
        ),
      );

      await runOnce();
      const timer = setInterval(runOnce, intervalMs);

      process.on("SIGINT", async () => {
        clearInterval(timer);
        await claudeClient?.dispose();
        await openaiClient?.dispose();
        process.exit(0);
      });
    },
  );

function displayClaudeQuotaTable(snapshot: QuotaSnapshot): void {
  console.log(chalk.bold.cyan("\n☁️  Claude Quota Status\n"));
  displayProviderTable([snapshot.fiveHour, snapshot.sevenDay], snapshot.timestamp);
}

function displayOpenAIQuotaTable(snapshot: OpenAIQuotaSnapshot): void {
  const planLabel = snapshot.planType ? ` (${snapshot.planType})` : "";
  console.log(chalk.bold.green(`\n🤖  OpenAI Codex Quota Status${planLabel}\n`));
  displayProviderTable([snapshot.primary, snapshot.secondary], snapshot.timestamp);
}

function displayProviderTable(
  quotas: Array<ModelQuota | OpenAIModelQuota | null>,
  timestamp: Date,
): void {
  const table = new Table({
    head: [
      chalk.white("Window"),
      chalk.white("Usage"),
      chalk.white("Reset In"),
      chalk.white("Reset At"),
    ],
    style: { head: [], border: ["gray"] },
  });

  for (const quota of quotas) {
    if (!quota) continue;

    const pct = quota.utilization;
    const barLen = 20;
    const filled = Math.round((pct / 100) * barLen);
    const empty = barLen - filled;

    let colorFn: (s: string) => string;
    if (pct >= 80) {
      colorFn = chalk.red;
    } else if (pct >= 60) {
      colorFn = chalk.yellow;
    } else {
      colorFn = chalk.green;
    }

    const bar = colorFn("█".repeat(filled) + "░".repeat(empty));
    const pctStr = colorFn(`${pct.toFixed(1)}%`);

    table.push([
      quota.period,
      `${bar} ${pctStr}`,
      quota.timeUntilResetFormatted,
      quota.resetTimeDisplay,
    ]);
  }

  console.log(table.toString());
  console.log(
    chalk.gray(
      `\n  Updated: ${timestamp.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    ),
  );
  console.log();
}

program.parse();
