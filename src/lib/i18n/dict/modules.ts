import { dashboard } from "./dashboard";
import { delivery, importErrors } from "./delivery";
import { digital } from "./digital";
import { events } from "./events";
import { protocol } from "./protocol";
import { booths, finance, resources, vendors } from "./production";
import { notif } from "./notif";
import { portal, reports } from "./portal";
import { org } from "./org";
import { projects } from "./projects";
import { tasks } from "./tasks";
import { templates } from "./templates";
import { shell } from "./shell";

// Module dictionaries are registered here as modules are added.
export const modules = { shell, notif, dashboard, delivery, importErrors, digital, events, protocol, booths, vendors, finance, resources, portal, reports, org, projects, tasks, templates };
