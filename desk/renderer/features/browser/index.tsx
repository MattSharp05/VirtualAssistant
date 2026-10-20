// The Browser window (JD-59): pages JARVIS acts in on the Mac, which Matthew can watch and take over.
// Tabs, then the toolbar (back, forward, reload, address, Take over / Hand back) and the status line
// (History, and the pill that reopens the task panel), then any question the task has for Matthew,
// then the page beside the task sidebar (JD-65: the task's running log, Pause / Stop and the box). In
// the app main lays the real page over the slot; the web preview draws a stand-in with the ring and
// caption of each action. With no page and no task the ask box is the window's centrepiece; on Start it
// moves into the sidebar. History takes the page's place while it's open.
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserCommand, BrowserTaskMode, BrowserTaskSummary } from "@jarvis/shared";
import { useBridgeChoice } from "../../app/bridge";
import { PageSlot } from "./PageSlot";
import { PreviewPage } from "./PreviewPage";
import { Tabs } from "./Tabs";
import { TaskComposer } from "./TaskComposer";
import { TaskHistory } from "./TaskHistory";
import { TaskQuestion } from "./TaskQuestion";
import { Glyph, TaskSidebar } from "./TaskSidebar";
import { isActive, shownTask, stateLabel } from "./taskModel";
import { Toolbar } from "./Toolbar";
import { useBrowser } from "./useBrowser";
import { useBrowserTasks } from "./useBrowserTasks";
import "./browser.css";
import "./task.css";

function NoPage() {
  return (
    <div className="browser-empty">
      <h2>No page open</h2>
      <p>JARVIS opens the page here when the task needs one. You can also type an address above.</p>
    </div>
  );
}

/** What the status line's pill says while the task panel is closed. */
function reopenLabel(task: BrowserTaskSummary | undefined): string {
  if (!task) return "Ask JARVIS";
  if (isActive(task)) return `${stateLabel(task.status)} · show the task`;
  return `${stateLabel(task.status)} · show the result`;
}

/** Now, each minute (a finished task's result leaves the sidebar after a while); a scenario can pin it. */
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
  // The task sidebar; closing it hides the log, never the task. A scenario can start with it closed.
  const [panelOpen, setPanelOpen] = useState(!ui?.taskPanelClosed);
  const [cleared, setCleared] = useState<string>();
  const now = useNow(ui?.now);
  // Where the hero box was when Start was pressed: the docked box moves from there.
  const launch = useRef<DOMRect>(undefined);
  const takeLaunch = useCallback(() => {
    const from = launch.current;
    launch.current = undefined;
    return from;
  }, []);
  // The task this window saw running: its result stays in the sidebar until New task.
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
  const start = async (text: string, mode: BrowserTaskMode) => {
    const ok = await tasks.start(text, mode);
    if (ok) setPanelOpen(true);
    return ok;
  };
  const active = state.tabs.find((t) => t.active);
  // No page and nothing going on: the ask box is the window. Otherwise the sidebar holds it (and the
  // task), unless Matthew closed it; then the status line's pill brings it back.
  const hero = !historyOpen && !active && !task;
  const sidebar = !hero && panelOpen;
  return (
    <div className="browser" data-control={state.control}>
      <Tabs
        tabs={state.tabs}
        onSwitch={(tabId) => command({ type: "switch-tab", tabId })}
        onClose={(tabId) => command({ type: "close-tab", tabId })}
        onNew={() => command({ type: "new-tab" })}
      />
      <Toolbar state={state} onCommand={command}>
        {!hero && !sidebar && (
          <button
            type="button"
            className="task-reopen"
            data-state={task?.status ?? "idle"}
            title="Show the task panel"
            onClick={() => setPanelOpen(true)}
          >
            {reopenLabel(task)}
          </button>
        )}
        <button
          type="button"
          className="task-button task-history-button"
          aria-pressed={historyOpen}
          aria-label="History"
          title="Browser tasks of the last 30 days"
          onClick={() => setHistoryOpen((o) => !o)}
        >
          <Glyph name="history" />
          History
        </button>
      </Toolbar>
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
      <div className="browser-body">
        <div className="browser-page">
          {historyOpen ? (
            <TaskHistory
              tasks={tasks.tasks}
              now={now}
              log={tasks.log}
              remove={tasks.remove}
              onClose={() => setHistoryOpen(false)}
            />
          ) : hero ? (
            <div className="browser-hero">
              <TaskComposer
                placement="hero"
                {...(tasks.error ? { error: tasks.error } : {})}
                onStart={start}
                onAnswer={() => {}}
                onLaunch={(from) => (launch.current = from)}
              />
            </div>
          ) : !active ? (
            <NoPage />
          ) : scenario !== undefined ? (
            <PreviewPage url={active.url} {...(action ? { action } : {})} />
          ) : (
            <PageSlot browser={browser} />
          )}
        </div>
        {sidebar && (
          <TaskSidebar
            {...(task ? { task } : {})}
            {...(tasks.error ? { error: tasks.error } : {})}
            log={tasks.log}
            onStart={start}
            onAnswer={(a) => task?.question && tasks.answer(task.id, { questionId: task.question.id, ...a })}
            onPause={() => task && tasks.pause(task.id)}
            onResume={() => task && tasks.resume(task.id)}
            onStop={() => task && tasks.stop(task.id)}
            onClear={() => setCleared(task?.id)}
            onClose={() => setPanelOpen(false)}
            takeLaunch={takeLaunch}
          />
        )}
      </div>
    </div>
  );
}
