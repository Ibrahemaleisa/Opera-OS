import { dashboard } from "./dashboard";
import { notif } from "./notif";
import { org } from "./org";
import { projects } from "./projects";
import { tasks } from "./tasks";
import { templates } from "./templates";
import { shell } from "./shell";

// Module dictionaries are registered here as modules are added.
export const modules = { shell, notif, dashboard, org, projects, tasks, templates };
