// The Browser window (JD-59): pages JARVIS acts in on the Mac, which Matthew can watch and take over.
// Tabs, then the toolbar (back, forward, reload, address, Take over / Hand back) and the task's status
// line, then the task strip (JD-60: the task box with its Normal / Full autonomy switch, the running
// task's Pause / Stop, History) and any question it has for Matthew, then the page: in the app main
// lays the real one over the slot; the web preview draws a stand-in with the ring and caption of each
// action. History takes the page's place while it's open.
import { useEffect, useState } from "react";
import type { BrowserCommand } from "@jarvis/shared";
import { useBridgeChoice } from "../../app/bridge";
import { PageSlot } from "./PageSlot";
import { PreviewPage } from "./PreviewPage";
import { Tabs } from "./Tabs";
import { TaskHistory } from "./TaskHistory";
import { TaskQuestion } from "./TaskQuestion";
import { TaskStrip } from "./TaskStrip";
import { isActive, shownTask } from "./taskModel";
import { Toolbar } from "./Toolbar";
import { useBrowser } from "./useBrowser";
import { useBrowserTasks } from "./useBrowserTasks";
import "./browser.css";
import "./task.css";

function NoPage() {
  return (
    <div className="browser-empty">
      <h2>No page open</h2>
      <p>
        When you ask JARVIS to do something on the web, it opens the page here so you can watch, and take over
        whenever you like. You can also type an address above.
      </p>
    </div>
  );
}

/** Now, each minute (a finished task's result leaves the strip after a while); a scenario can pin it. */
function useNow(fixed?: string): number {
  const [now, setNow] = useState(() => (fixed ? Date.parse(fixed) : Date.now()));
  useEffect(() => {
    if (fixed) return;
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, [fixed]);
  return now;
}

export default function BrowserWindow() {
  const { bridge, scenario, ui } = useBridgeChoice();
  const { state, action } = useBrowser(bridge);
  const tasks = useBrowserTasks(bridge);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cleared, setCleared] = useState<string>();
  const now = useNow(ui?.now);
  // The task this window saw running: its result stays on the strip until New task.
  const running = tasks.tasks.find(isActive)?.id;
  const [followed, setFollowed] = useState<string>();
  if (running && running !== followed) setFollowed(running);
  const browser = bridge.browser;
  if (!browser)
    return (
      <div className="browser-empty">
        <h2>The browser works in the app</h2>
      </div>
    );
  if (!state) return <div className="browser" aria-busy="true" />;

  const task = shownTask(tasks.tasks, now, cleared, followed);
  const command = (c: BrowserCommand) => {
    void browser
      .command(c)
      .then(() => {
        // Hand back carries a waiting or paused task on (src/browser/tasks.ts resume).
        if (c.type === "hand-back" && task && (task.status === "waiting" || task.status === "paused"))
          tasks.resume(task.id);
      })
      .catch(() => {});
  };
  const active = state.tabs.find((t) => t.active);
  return (
    <div className="browser" data-control={state.control}>
      <Tabs
        tabs={state.tabs}
        onSwitch={(tabId) => command({ type: "switch-tab", tabId })}
        onClose={(tabId) => command({ type: "close-tab", tabId })}
        onNew={() => command({ type: "new-tab" })}
      />
      <Toolbar state={state} onCommand={command} />
      <TaskStrip
        {...(task ? { task } : {})}
        {...(tasks.error ? { error: tasks.error } : {})}
        historyOpen={historyOpen}
        onStart={(text, mode) => tasks.start(text, mode)}
        onPause={() => task && tasks.pause(task.id)}
        onResume={() => task && tasks.resume(task.id)}
        onStop={() => task && tasks.stop(task.id)}
        onClear={() => setCleared(task?.id)}
        onHistory={() => setHistoryOpen((o) => !o)}
      />
      {task?.status === "waiting" && task.question && (
        <TaskQuestion
          key={task.question.id}
          question={task.question}
          control={state.control}
          onAnswer={(a) => tasks.answer(task.id, { questionId: task.question!.id, ...a })}
          onTakeOver={() => command({ type: "take-over" })}
          onHandBack={() => command({ type: "hand-back" })}
        />
      )}
      <div className="browser-page">
        {historyOpen ? (
          <TaskHistory tasks={tasks.tasks} now={now} log={tasks.log} onClose={() => setHistoryOpen(false)} />
        ) : !active ? (
          <NoPage />
        ) : scenario !== undefined ? (
          <PreviewPage url={active.url} {...(action ? { action } : {})} />
        ) : (
          <PageSlot browser={browser} />
        )}
      </div>
    </div>
  );
}
