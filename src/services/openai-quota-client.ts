import { loadConfig, saveConfig, type Config } from "./config.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
    secondary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
  };
  plan_type?: string;
  credits?: { balance?: number | string | null };
}

export interface OpenAIModelQuota {
  period: string;
  utilization: number;
  remaining: number;
  resetTime: Date;
  resetTimeDisplay: string;
  timeUntilReset: number;
  timeUntilResetFormatted: string;
}

export interface OpenAIQuotaSnapshot {
  primary: OpenAIModelQuota | null;
  secondary: OpenAIModelQuota | null;
  planType?: string;
  timestamp: Date;
}

interface TokenRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export class OpenAIQuotaClient {
  private accessToken: string;
  private refreshToken: string;
  private accountId?: string;

  constructor(accessToken: string, refreshToken: string, accountId?: string) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.accountId = accountId;
  }

  async fetchQuota(): Promise<OpenAIQuotaSnapshot> {
    let data: CodexUsageResponse;

    try {
      data = await this.fetchUsage();
    } catch (error) {
      if (error instanceof Error && error.message.includes("401")) {
        await this.refreshAccessToken();
        data = await this.fetchUsage();
      } else {
        throw error;
      }
    }

    return this.parseResponse(data);
  }

  private async fetchUsage(): Promise<CodexUsageResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "User-Agent": "ai-quota-cli/1.0.0",
      Accept: "application/json",
    };

    if (this.accountId) {
      headers["ChatGPT-Account-Id"] = this.accountId;
    }

    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI usage API failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as CodexUsageResponse;
  }

  private async refreshAccessToken(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: this.refreshToken,
    });

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI token refresh failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as TokenRefreshResponse;
    this.accessToken = data.access_token;

    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }

    // Persist refreshed tokens to config
    const config = loadConfig();
    if (config) {
      config.openai = {
        ...config.openai,
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        accountId: this.accountId,
      };
      saveConfig(config);
    }
  }

  private parseResponse(data: CodexUsageResponse): OpenAIQuotaSnapshot {
    const now = Date.now();

    const parseWindow = (
      window:
        | {
            limit_window_seconds?: number;
            used_percent?: number;
            reset_at?: number;
          }
        | undefined,
      fallbackPeriod: string,
    ): OpenAIModelQuota | null => {
      if (!window || window.used_percent === undefined) return null;

      const windowSeconds = window.limit_window_seconds ?? 0;
      const period = this.formatWindowPeriod(windowSeconds, fallbackPeriod);
      const resetTime = window.reset_at
        ? new Date(window.reset_at * 1000)
        : new Date(now + windowSeconds * 1000);
      const timeUntilReset = Math.max(0, resetTime.getTime() - now);

      return {
        period,
        utilization: window.used_percent,
        remaining: Math.max(0, 100 - window.used_percent),
        resetTime,
        resetTimeDisplay: this.formatTime(resetTime),
        timeUntilReset,
        timeUntilResetFormatted: this.formatDuration(timeUntilReset),
      };
    };

    return {
      primary: parseWindow(data.rate_limit?.primary_window, "primary"),
      secondary: parseWindow(data.rate_limit?.secondary_window, "secondary"),
      planType: data.plan_type,
      timestamp: new Date(),
    };
  }

  private formatWindowPeriod(seconds: number, fallback: string): string {
    if (seconds <= 0) return fallback;
    const hours = seconds / 3600;
    if (hours < 1) return `${Math.round(seconds / 60)}-min`;
    if (hours % 24 === 0) return `${hours / 24}-day`;
    return `${hours}-hour`;
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
    // No-op — plain fetch, no browser to clean up
  }
}
