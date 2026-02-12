import * as fs from "fs";
import * as path from "path";

const CONFIG_DIR = path.join(process.env.HOME || "/tmp", ".claude-quota");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const STATE_FILE = path.join(CONFIG_DIR, "alert-state.json");

export interface Config {
  sessionKey: string;
  organizationId: string;
  discordWebhook?: string;
}

export interface AlertState {
  [period: string]: number[];
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig(): Config | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

export function loadAlertState(): AlertState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as AlertState;
  } catch {
    return {};
  }
}

export function saveAlertState(state: AlertState): void {
  ensureConfigDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function resetAlertState(): void {
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
