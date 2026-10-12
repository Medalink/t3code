// @vitest-environment jsdom

import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitHistoryIndex,
} from "@t3tools/shared/usageLimits";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("./limitsForecastPreferences", async () => {
  const { useState } = await import("react");
  return { useLimitsForecastPreferences: () => useState({ drainOverrides: {} }) };
});
vi.mock("../ui/select", async () => {
  const { createContext, createElement, useContext } = await import("react");
  type Props = { readonly children?: React.ReactNode };
  const Pick = createContext<(value: string) => void>(() => undefined);
  return {
    Select: ({
      onValueChange,
      children,
    }: Props & { readonly onValueChange: (value: string) => void }) =>
      createElement(Pick.Provider, { value: onValueChange }, createElement("div", null, children)),
    SelectTrigger: ({ children, "aria-label": label }: Props & { readonly "aria-label": string }) =>
      createElement("div", { role: "combobox", "aria-label": label }, children),
    SelectValue: ({ children }: Props) => createElement("span", null, children),
    SelectPopup: ({ children }: Props) => createElement("div", null, children),
    SelectItem: ({ value, children }: Props & { readonly value: string }) => {
      const pick = useContext(Pick);
      return createElement("button", { role: "option", onClick: () => pick(value) }, children);
    },
  };
});

import { PoolForecast } from "./UsageLimitsForecast";

const HOUR = 3_600_000;
const now = Date.parse("2026-09-11T12:00:00.000Z");
const history: LimitHistoryIndex = new Map();

const pool = collectLimitPools(
  collectLimitAccounts(
    new Map([
      [
        EnvironmentId.make("env"),
        {
          entry: { target: { label: "Laptop" } },
          serverConfig: {
            providers: [
              {
                instanceId: ProviderInstanceId.make("codex"),
                driver: ProviderDriverKind.make("codex"),
                enabled: true,
                installed: true,
                version: null,
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: new Date(now).toISOString(),
                models: [],
                slashCommands: [],
                skills: [],
                usageLimits: {
                  checkedAt: new Date(now).toISOString(),
                  windows: [
                    {
                      id: "primary",
                      kind: "session",
                      label: "Session",
                      usedPercent: 40,
                      windowDurationMins: 300,
                      resetsAt: new Date(now + 3.5 * HOUR).toISOString(),
                    },
                    {
                      id: "secondary",
                      kind: "weekly",
                      label: "Weekly",
                      usedPercent: 60,
                      windowDurationMins: 7 * 24 * 60,
                      resetsAt: new Date(now + 5 * 24 * HOUR).toISOString(),
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    ]),
  ),
  now,
)[0]!;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<PoolForecast pool={pool} history={history} now={now} color="#000" />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const shownWindow = () =>
  container.querySelector('[aria-label="Forecast window"]')?.textContent ?? null;
const settingsButton = () =>
  [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Forecast settings"),
  )!;
const drainInput = () => {
  const label = [...container.querySelectorAll("label")].find(
    (candidate) => candidate.textContent === "Drain per hour",
  );
  return label ? (document.getElementById(label.htmlFor) as HTMLInputElement) : null;
};

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pickWindow(label: string) {
  const option = [
    ...container
      .querySelector('[aria-label="Forecast window"]')!
      .parentElement!.querySelectorAll('[role="option"]'),
  ].find((candidate) => candidate.textContent === label) as HTMLElement;
  await click(option);
}

it("shows the window projected to run dry first", () => {
  expect(shownWindow()).toBe("Session");
  expect(drainInput()).toBeNull();
});

it("stays on the window being tuned when a manual rate moves the binding window", async () => {
  await click(settingsButton());
  const input = drainInput()!;
  await type(input, "10");

  expect(shownWindow()).toBe("Session");
  expect(container.textContent).toContain("manual rate");
  expect(drainInput()).toBe(input);
  expect(input.value).toBe("10");
});

it("keeps settings open for the newly picked window", async () => {
  await click(settingsButton());
  await pickWindow("Weekly");

  expect(shownWindow()).toBe("Weekly");
  expect(settingsButton().getAttribute("aria-expanded")).toBe("true");
  expect(drainInput()?.value).toBe("");
});

it("hides the settings panel when closed", async () => {
  await click(settingsButton());
  expect(drainInput()).not.toBeNull();
  await click(settingsButton());

  expect(drainInput()).toBeNull();
  expect(settingsButton().getAttribute("aria-expanded")).toBe("false");
});
