// The Mac's browser over rpc (JD-59): every browser.* kind the server sends, validated
// (browser/validate.ts) and handed to the BrowserAgent. A refusal (Matthew has the browser, a bad ref,
// an address that isn't one) goes back as the rpc's error, word for word.
import { BROWSER_RPC } from "@jarvis/shared";
import type { BrowserAgent } from "../browser/agent";
import * as v from "../browser/validate";
import type { RpcHandler } from "./index";

export function browserRpcHandlers(agent: BrowserAgent): Record<string, RpcHandler> {
  return {
    [BROWSER_RPC.open]: async (p) => agent.open(v.openRequest(p)),
    [BROWSER_RPC.navigate]: async (p) => agent.navigate(v.navigateRequest(p)),
    [BROWSER_RPC.tabs]: async (p) => agent.tabs(v.tabsRequest(p)),
    [BROWSER_RPC.snapshot]: async (p) => agent.snapshot(v.snapshotRequest(p)),
    [BROWSER_RPC.click]: async (p) => agent.click(v.clickRequest(p)),
    [BROWSER_RPC.type]: async (p) => agent.type(v.typeRequest(p)),
    [BROWSER_RPC.select]: async (p) => agent.select(v.selectRequest(p)),
    [BROWSER_RPC.press]: async (p) => agent.press(v.pressRequest(p)),
    [BROWSER_RPC.scroll]: async (p) => agent.scroll(v.scrollRequest(p)),
    [BROWSER_RPC.wait]: async (p) => agent.wait(v.waitRequest(p)),
    [BROWSER_RPC.screenshot]: async () => agent.screenshot(),
    [BROWSER_RPC.status]: async (p) => agent.setStatus(v.statusRequest(p)),
  };
}
