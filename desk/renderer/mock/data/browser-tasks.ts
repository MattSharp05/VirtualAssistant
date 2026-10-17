// Browser tasks (JD-60) in demo-day: the Browser window's History menu has the last few days' tasks,
// and the task box starts new ones through the mock routes.
import { browserTaskRoutes, pastTasks, tasksData } from "../browserTasks";
import type { ScenarioPart } from "../types";

const part: ScenarioPart = { data: tasksData(pastTasks), routes: [browserTaskRoutes] };

export default part;
