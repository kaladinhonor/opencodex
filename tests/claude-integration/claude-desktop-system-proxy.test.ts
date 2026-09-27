import { describe, expect, test } from "bun:test";
import {
  assessDesktopSystemProxy,
  collectDesktopSystemProxy,
  formatDesktopSystemProxyLines,
  type DesktopSystemProxyInput,
} from "../../src/claude/desktop-system-proxy";
import { parseWindowsProxyServer, windowsProxyOverrideBypasses } from "../../src/lib/windows-system-proxy";
import type { OcxConfig } from "../../src/types";

const CLASH = parseWindowsProxyServer("127.0.0.1:7897");
const CLASH_BYPASS = "localhost;127.*;192.168.*;10.*;<local>";

function input(overrides: Partial<DesktopSystemProxyInput> = {}): DesktopSystemProxyInput {
  return {
    platform: "win32",
    firstPartyApplied: true,
    systemProxy: CLASH,
    bypass: { proxyOverride: CLASH_BYPASS, autoConfigUrl: null },
    ...overrides,
  };
}

describe("windowsProxyOverrideBypasses", () => {
  test("matches exact hosts, wildcards and leading-dot suffixes case-insensitively", () => {
    expect(windowsProxyOverrideBypasses(`${CLASH_BYPASS};api.anthropic.com`, "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses("*.anthropic.com", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses("*anthropic*", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses(".anthropic.com", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses(" API.Anthropic.COM ", "api.anthropic.com")).toBe(true);
  });

  test("does not treat <local>, private ranges, or a lookalike as covering the API host", () => {
    expect(windowsProxyOverrideBypasses(CLASH_BYPASS, "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses("<local>", "intranet")).toBe(true);
    expect(windowsProxyOverrideBypasses("api.anthropic.com.evil", "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses("apixanthropic.com", "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses(null, "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses("", "api.anthropic.com")).toBe(false);
  });

  test("honours scheme and port qualifiers for an HTTPS host", () => {
    expect(windowsProxyOverrideBypasses("https://api.anthropic.com", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses("http://api.anthropic.com", "api.anthropic.com")).toBe(false);
    expect(windowsProxyOverrideBypasses("api.anthropic.com:443", "api.anthropic.com")).toBe(true);
    expect(windowsProxyOverrideBypasses("api.anthropic.com:8443", "api.anthropic.com")).toBe(false);
  });
});

describe("assessDesktopSystemProxy", () => {
  test("flags a system proxy that covers the API host, without printing the proxy value", () => {
    expect(assessDesktopSystemProxy(input())).toEqual({ kind: "conflict" });
    const credentialed = parseWindowsProxyServer("user:secret@proxy.corp:8080");
    const verdict = assessDesktopSystemProxy(input({ systemProxy: credentialed }));
    expect(verdict).toEqual({ kind: "conflict" });
    const text = formatDesktopSystemProxyLines(verdict).join("\n");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("proxy.corp");
  });

  test("is clear once the API host is on the bypass list", () => {
    const bypass = { proxyOverride: `${CLASH_BYPASS};api.anthropic.com`, autoConfigUrl: null };
    expect(assessDesktopSystemProxy(input({ bypass }))).toEqual({ kind: "bypassed" });
  });

  test("is clear when no system proxy can reach an https:// API host", () => {
    expect(assessDesktopSystemProxy(input({ systemProxy: { kind: "disabled" } }))).toEqual({ kind: "no-proxy" });
    expect(assessDesktopSystemProxy(input({ systemProxy: parseWindowsProxyServer("socks=127.0.0.1:1080") })))
      .toEqual({ kind: "no-proxy" });
    expect(assessDesktopSystemProxy(input({ systemProxy: parseWindowsProxyServer("http=127.0.0.1:8080") })))
      .toEqual({ kind: "no-proxy" });
    expect(assessDesktopSystemProxy(input({ systemProxy: parseWindowsProxyServer("https=127.0.0.1:8080") })).kind)
      .toBe("conflict");
  });

  test("reports a PAC script as unknown instead of guessing", () => {
    const bypass = { proxyOverride: null, autoConfigUrl: "http://127.0.0.1:33331/pac" };
    expect(assessDesktopSystemProxy(input({ bypass }))).toEqual({ kind: "pac" });
    expect(assessDesktopSystemProxy(input({ bypass, systemProxy: { kind: "disabled" } }))).toEqual({ kind: "pac" });
  });

  test("stays silent off Windows or without an applied Desktop first-party install", () => {
    expect(assessDesktopSystemProxy(input({ platform: "darwin" }))).toEqual({ kind: "not-applicable" });
    expect(assessDesktopSystemProxy(input({ firstPartyApplied: false }))).toEqual({ kind: "not-applicable" });
    expect(formatDesktopSystemProxyLines({ kind: "not-applicable" })).toEqual([]);
  });

  test("an unreadable registry is reported, not treated as a conflict", () => {
    expect(assessDesktopSystemProxy(input({ systemProxy: { kind: "unreadable" } }))).toEqual({ kind: "unreadable" });
  });
});

describe("formatDesktopSystemProxyLines", () => {
  test("a conflict names the fix and the restart", () => {
    const text = formatDesktopSystemProxyLines({ kind: "conflict" }).join("\n");
    expect(text).toContain("!!");
    expect(text).toContain("api.anthropic.com");
    expect(text).toContain("bypass list");
    expect(text).toContain("reopen Claude Desktop");
  });

  test("clear states print a single ok line", () => {
    for (const kind of ["no-proxy", "bypassed"] as const) {
      const lines = formatDesktopSystemProxyLines({ kind });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("  ok");
    }
  });
});

test("collectDesktopSystemProxy never touches the registry off Windows", () => {
  const config = { port: 10100, clientIntegrations: { "claude-desktop": true },
    claudeCode: { desktopMode: "first-party" } } as Pick<OcxConfig, "claudeCode" | "clientIntegrations" | "port" | "runtimeRole">;
  expect(collectDesktopSystemProxy(config, "linux")).toEqual({ kind: "not-applicable" });
  expect(collectDesktopSystemProxy(config, "darwin")).toEqual({ kind: "not-applicable" });
});
