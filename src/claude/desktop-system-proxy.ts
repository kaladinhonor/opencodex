import type { OcxConfig } from "../types";
import {
  readWindowsProxyBypassRegistry,
  readWindowsSystemProxy,
  windowsProxyOverrideBypasses,
  type WindowsProxyBypassValues,
  type WindowsSystemProxyResult,
} from "../lib/windows-system-proxy";
import { inspectDesktopFirstParty, observeClaudeDesktopMode } from "./desktop-first-party";
import { desktopFirstPartyDesired } from "./first-party-settings";

/**
 * Whether the Windows system proxy silently bypasses Desktop first-party mode.
 *
 * When Claude Desktop starts the Code tab's Claude Code process, it resolves the operating
 * system proxy for the API host and, when that yields an HTTP proxy, passes it to the process
 * as `HTTPS_PROXY`/`HTTP_PROXY`. That inherited value takes precedence over the `env` block
 * OpenCodex writes into the user's `~/.claude/settings.json` (only Claude Code managed settings
 * override it), so Code-tab traffic goes to the system proxy and never reaches the intercept.
 * Routed subagent models then fail, and nothing else reports why. A system proxy such as Clash or
 * v2rayN, with no bypass for the API host, is the common case.
 *
 * Observe-only: this reads the registry and never changes it. A PAC script, and WPAD detection
 * that this does not read, decide per request, so a PAC answer is reported as unknown rather
 * than guessed. Like the other doctor proxy surfaces it never prints the proxy value, which can
 * carry credentials.
 */

export const FIRST_PARTY_API_HOST = "api.anthropic.com";

export type DesktopSystemProxyAssessment =
  | { kind: "not-applicable" }
  | { kind: "no-proxy" }
  | { kind: "bypassed" }
  | { kind: "conflict" }
  | { kind: "pac" }
  | { kind: "unreadable" };

export interface DesktopSystemProxyInput {
  platform: NodeJS.Platform;
  firstPartyApplied: boolean;
  systemProxy: WindowsSystemProxyResult;
  bypass: WindowsProxyBypassValues;
}

export function assessDesktopSystemProxy(input: DesktopSystemProxyInput): DesktopSystemProxyAssessment {
  if (input.platform !== "win32" || !input.firstPartyApplied) return { kind: "not-applicable" };
  if (input.bypass.autoConfigUrl) return { kind: "pac" };
  const proxy = input.systemProxy;
  if (proxy.kind === "unreadable") return { kind: "unreadable" };
  // Desktop skips SOCKS entries, and an http=-only value does not cover an https:// API host.
  if (proxy.kind !== "proxy" || !proxy.httpsUrl) return { kind: "no-proxy" };
  if (windowsProxyOverrideBypasses(input.bypass.proxyOverride, FIRST_PARTY_API_HOST)) return { kind: "bypassed" };
  return { kind: "conflict" };
}

export function formatDesktopSystemProxyLines(assessment: DesktopSystemProxyAssessment): string[] {
  switch (assessment.kind) {
    case "not-applicable":
      return [];
    case "no-proxy":
      return ["  ok  No Windows system proxy covers the Claude API; the Code tab uses the OpenCodex proxy from settings.json."];
    case "bypassed":
      return [`  ok  ${FIRST_PARTY_API_HOST} is on the Windows proxy bypass list; the Code tab uses the OpenCodex proxy from settings.json.`];
    case "pac":
      return [
        "  --  Windows uses a proxy auto-config (PAC) script, so OpenCodex cannot tell whether Claude Desktop",
        `      sends ${FIRST_PARTY_API_HOST} through a proxy. If routed models fail in the Code tab, make the script return DIRECT for it.`,
      ];
    case "unreadable":
      return ["  --  Could not read the Windows proxy settings."];
    case "conflict":
      return [
        `  !!  The Windows system proxy applies to ${FIRST_PARTY_API_HOST}. Claude Desktop passes it to the Code tab`,
        "      as HTTPS_PROXY, which takes precedence over the OpenCodex proxy in ~/.claude/settings.json,",
        "      so first-party routing is bypassed and routed models fail there.",
        `      Fix: add ${FIRST_PARTY_API_HOST} to your proxy client's system-proxy bypass list (Clash Verge: system_proxy_bypass),`,
        "      then fully quit and reopen Claude Desktop.",
      ];
  }
}

/** Reads the live state. Registry reads run only on Windows with Desktop first-party applied. */
export function collectDesktopSystemProxy(
  config: Pick<OcxConfig, "claudeCode" | "clientIntegrations" | "port" | "runtimeRole">,
  platform: NodeJS.Platform = process.platform,
): DesktopSystemProxyAssessment {
  if (platform !== "win32") return { kind: "not-applicable" };
  let firstPartyApplied = false;
  try {
    const settings = inspectDesktopFirstParty(config).settings.kind;
    firstPartyApplied = (settings === "applied" || settings === "stale")
      && desktopFirstPartyDesired(config, observeClaudeDesktopMode(config));
  } catch { // no-excuse-ok: catch -- unreadable Claude settings are no first-party evidence.
    firstPartyApplied = false;
  }
  if (!firstPartyApplied) return { kind: "not-applicable" };
  return assessDesktopSystemProxy({
    platform,
    firstPartyApplied,
    systemProxy: readWindowsSystemProxy(),
    bypass: readWindowsProxyBypassRegistry(),
  });
}
