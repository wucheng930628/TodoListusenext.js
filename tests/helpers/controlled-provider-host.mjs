import { createElement, StrictMode } from "react";
import { ControlledApiProvider, useControlledApi } from "../../src/hooks/controlled-api-provider.mjs";
import { hookHost } from "./react-hook-host.mjs";

export async function providerHarness(api, config) {
  const host = await hookHost(); let state;
  function Probe() { state = useControlledApi(); return null; }
  function Tree() { return createElement(StrictMode, null, createElement(ControlledApiProvider, { api, config }, createElement(Probe))); }
  await host.render(Tree);
  return { host, get state() { return state; }, async flush() { for (let n = 0; n < 12; n++) await host.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); }, async action(fn) { let result; await host.act(async () => { result = await fn(state); }); return result; } };
}
