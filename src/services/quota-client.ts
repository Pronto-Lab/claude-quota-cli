import { chromium, type Browser, type BrowserContext } from "playwright-core";

export interface UsageWindow {
  utilization: number;
  resets_at: string;
}

export interface ClaudeUsageResponse {
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
}

export interface ModelQuota {
  period: string;
  utilization: number;
  remaining: number;
  resetTime: Date;
  resetTimeDisplay: string;
  timeUntilReset: number;
  timeUntilResetFormatted: string;
}

export interface QuotaSnapshot {
  fiveHour: ModelQuota | null;
  sevenDay: ModelQuota | null;
  timestamp: Date;
}

export class QuotaClient {
  private sessionKey: string;
  private organizationId: string;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(sessionKey: string, organizationId: string) {
    this.sessionKey = this.parseSessionKey(sessionKey);
    this.organizationId = organizationId;
  }

  private parseSessionKey(raw: string): string {
    if (!raw) return "";
    if (raw.includes("sessionKey=")) {
      const match = raw.match(/sessionKey=([^;]+)/);
      return match ? match[1].trim() : raw;
    }
    return raw.trim();
  }

  async fetchQuota(): Promise<QuotaSnapshot> {
    if (!this.sessionKey || !this.organizationId) {
      throw new Error("Session key and organization ID not configured");
    }

    const data = await this.fetchWithPlaywright();
    return this.parseResponse(data);
  }

  private async fetchWithPlaywright(): Promise<ClaudeUsageResponse> {
    try {
      if (!this.browser) {
        this.browser = await chromium.launch({
          headless: false,
          args: [
            "--headless=new",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
          ],
        });
      }

      if (!this.context) {
        this.context = await this.browser.newContext({
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          locale: "en-US",
          timezoneId: "Asia/Seoul",
        });

        await this.context.addCookies([
          {
            name: "sessionKey",
            value: this.sessionKey,
            domain: ".claude.ai",
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
          {
            name: "lastActiveOrg",
            value: this.organizationId,
            domain: ".claude.ai",
            path: "/",
            secure: true,
            sameSite: "Lax",
          },
        ]);
      }

      const page = await this.context.newPage();

      await page.addInitScript(`
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        if (!window.chrome) { window.chrome = { runtime: {} }; }
      `);

      await page.goto("https://claude.ai/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      try {
        await page.waitForFunction(
          `(() => {
            const body = document.body.innerText;
            return !body.includes('Verifying you are human') &&
                   !body.includes('claude.ai needs to review the security');
          })()`,
          { timeout: 30000 },
        );
      } catch {
      }

      await page.waitForTimeout(2000);

      const url = `https://claude.ai/api/organizations/${this.organizationId}/usage`;

      const result = await page.evaluate(async (apiUrl: string) => {
        try {
          const response = await fetch(apiUrl, {
            method: "GET",
            credentials: "include",
            headers: {
              accept: "*/*",
              "anthropic-client-platform": "web_claude_ai",
            },
          });

          if (!response.ok) {
            return { error: `HTTP ${response.status}: ${response.statusText}` };
          }

          const data = await response.json();
          return { data };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }, url);

      await page.close();

      if ("error" in result && result.error) {
        throw new Error(String(result.error));
      }

      return (result as { data: ClaudeUsageResponse }).data;
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to fetch quota: ${msg}`);
    }
  }

  private parseResponse(data: ClaudeUsageResponse): QuotaSnapshot {
    const now = Date.now();

    const parseWindow = (
      window: UsageWindow | undefined,
      period: string,
    ): ModelQuota | null => {
      if (!window) return null;

      const resetTime = new Date(window.resets_at);
      const timeUntilReset = Math.max(0, resetTime.getTime() - now);

      return {
        period,
        utilization: window.utilization,
        remaining: Math.max(0, 100 - window.utilization),
        resetTime,
        resetTimeDisplay: this.formatTime(resetTime),
        timeUntilReset,
        timeUntilResetFormatted: this.formatDuration(timeUntilReset),
      };
    };

    return {
      fiveHour: parseWindow(data.five_hour, "5-hour"),
      sevenDay: parseWindow(data.seven_day, "7-day"),
      timestamp: new Date(),
    };
  }

  private formatTime(date: Date): string {
    return date.toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Seoul",
    });
  }

  private formatDuration(ms: number): string {
    const totalMinutes = Math.floor(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  async dispose(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
