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
} from "./services/quota-client.js";
import {
  sendDiscordAlert,
  sendDailyReport,
  getThresholdForPercentage,
} from "./services/discord.js";

const program = new Command();

program
  .name("claude-quota")
  .description("CLI tool for monitoring Claude AI subscription quotas")
  .version("1.0.0");

program
  .command("config")
  .description("Configure credentials")
  .requiredOption("--session-key <key>", "Claude.ai sessionKey cookie value")
  .requiredOption("--org-id <id>", "Claude.ai organization ID")
  .option("--webhook <url>", "Discord webhook URL for alerts")
  .option("--webhook-add <url>", "Add an additional Discord webhook URL")
  .option("--webhook-remove <url>", "Remove a Discord webhook URL")
  .option("--webhook-list", "List configured webhook URLs")
  .action(
    (options: {
      sessionKey: string;
      orgId: string;
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
        sessionKey: options.sessionKey,
        organizationId: options.orgId,
        ...(webhookArray.length > 0
          ? { discordWebhooks: webhookArray }
          : {}),
      };
      saveConfig(config);
      console.log(chalk.green("✓ Configuration saved to " + getConfigPath()));
      if (webhookArray.length > 0) {
        console.log(chalk.gray(`  ${webhookArray.length} webhook(s) configured`));
      }
    },
  );

program
  .command("status")
  .description("Show current quota status")
  .option("-j, --json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    const config = loadConfig();
    if (!config) {
      console.error(
        chalk.red(
          "Not configured. Run: claude-quota config --session-key <key> --org-id <id>",
        ),
      );
      process.exit(1);
    }

    const spinner = ora("Fetching quota data...").start();
    const client = new QuotaClient(config.sessionKey, config.organizationId);

    try {
      const snapshot = await client.fetchQuota();
      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(snapshot, null, 2));
      } else {
        displayQuotaTable(snapshot);
      }
    } catch (error) {
      spinner.fail(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`),
      );
      process.exit(1);
    } finally {
      await client.dispose();
    }
  });

program
  .command("watch")
  .description("Watch mode - refresh periodically")
  .option(
    "-i, --interval <seconds>",
    "Refresh interval in seconds",
    "60",
  )
  .action(async (options: { interval: string }) => {
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

    const client = new QuotaClient(config.sessionKey, config.organizationId);

    const refresh = async () => {
      try {
        const snapshot = await client.fetchQuota();
        console.clear();
        console.log(
          chalk.gray(
            `Last updated: ${new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}\n`,
          ),
        );
        displayQuotaTable(snapshot);
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
      await client.dispose();
      process.exit(0);
    });
  });

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
      if (process.env.DISCORD_WEBHOOK) webhookUrls.push(process.env.DISCORD_WEBHOOK);
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

      const client = new QuotaClient(config.sessionKey, config.organizationId);

      const dailyReportHour = parseInt(options.dailyReportHour);
      let lastDailyReportDate = "";

      const checkDailyReport = async (
        snapshot: import("./services/quota-client.js").QuotaSnapshot,
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
          await sendDailyReport(uniqueUrls, snapshot);
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
          const snapshot = await client.fetchQuota();
          const state = loadAlertState();
          let alertsSent = 0;

          for (const quota of [snapshot.fiveHour, snapshot.sevenDay]) {
            if (!quota) continue;

            const threshold = getThresholdForPercentage(quota.utilization);
            if (threshold === null) continue;

            const alertedThresholds = state[quota.period] || [];

            if (!alertedThresholds.includes(threshold)) {
              console.log(
                chalk.gray(`[${timestamp}]`),
                chalk.yellow(
                  `Alert: ${quota.period} at ${quota.utilization.toFixed(1)}% (threshold: ${threshold}%)`,
                ),
              );

              await sendDiscordAlert(uniqueUrls, quota, threshold, snapshot);
              state[quota.period] = [...alertedThresholds, threshold];
              alertsSent++;
            }

            if (quota.utilization < 20) {
              state[quota.period] = [];
            }
          }

          saveAlertState(state);

          await checkDailyReport(snapshot, timestamp);

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
        await client.dispose();
        return;
      }

      const intervalMs = parseInt(options.interval) * 60 * 1000;
      console.log(
        chalk.cyan(
          `🔍 Monitoring quotas (every ${options.interval} min, daily report at ${dailyReportHour}:00 KST). Ctrl+C to exit.`,
        ),
      );

      await runOnce();
      const timer = setInterval(runOnce, intervalMs);

      process.on("SIGINT", async () => {
        clearInterval(timer);
        await client.dispose();
        process.exit(0);
      });
    },
  );

function displayQuotaTable(snapshot: QuotaSnapshot): void {
  console.log(chalk.bold.cyan("\n☁️  Claude Quota Status\n"));

  const table = new Table({
    head: [
      chalk.white("Window"),
      chalk.white("Usage"),
      chalk.white("Reset In"),
      chalk.white("Reset At"),
    ],
    style: { head: [], border: ["gray"] },
  });

  for (const quota of [snapshot.fiveHour, snapshot.sevenDay]) {
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
      `\n  Updated: ${snapshot.timestamp.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    ),
  );
  console.log();
}

program.parse();
