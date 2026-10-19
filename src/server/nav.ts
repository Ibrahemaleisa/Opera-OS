import type { Messages } from "@/lib/i18n";
import type { ServiceContext } from "@/server/authz/context";
import { can, canAny } from "@/server/authz/policy";
import type { NavSection } from "@/components/app/sidebar";

/** Navigation is derived from permissions — but every page re-checks server-side. */
export function buildNav(ctx: ServiceContext, m: Messages, badges: { notifications?: number } = {}): NavSection[] {
  const b = `/o/${ctx.orgSlug}`;
  const n = m.nav;
  const sections: NavSection[] = [
    {
      label: n.sectionOperate,
      items: [
        { key: "dashboard", label: n.dashboard, href: b },
        { key: "projects", label: n.projects, href: `${b}/projects` },
        { key: "myWork", label: n.myWork, href: `${b}/my-work` },
        ...(can(ctx, "template.manage") ? [{ key: "templates", label: n.templates, href: `${b}/templates` }] : []),
      ],
    },
    {
      label: n.sectionDeliver,
      items: [
        ...(can(ctx, "delivery.view") ? [{ key: "delivery", label: n.delivery, href: `${b}/delivery` }] : []),
        ...(can(ctx, "recipient.view") ? [{ key: "recipients", label: n.recipients, href: `${b}/recipients` }] : []),
        ...(can(ctx, "delivery.dispatch") ? [{ key: "dispatch", label: n.dispatch, href: `${b}/dispatch` }] : []),
        ...(canAny(ctx, "campaign.manage", "campaign.approve") ? [{ key: "digital", label: n.digital, href: `${b}/digital` }] : []),
      ],
    },
    {
      label: n.sectionProduce,
      items: [
        ...(canAny(ctx, "event.manage", "incident.report") ? [{ key: "events", label: n.events, href: `${b}/events` }] : []),
        ...(can(ctx, "protocol.manage") ? [{ key: "protocol", label: n.protocol, href: `${b}/protocol` }] : []),
        ...(can(ctx, "booth.manage") ? [{ key: "booths", label: n.booths, href: `${b}/booths` }] : []),
        ...(can(ctx, "vendor.view") ? [{ key: "vendors", label: n.vendors, href: `${b}/vendors` }] : []),
        ...(can(ctx, "org.members.view") ? [{ key: "resources", label: n.resources, href: `${b}/resources` }] : []),
        ...(can(ctx, "finance.view") ? [{ key: "finance", label: n.finance, href: `${b}/finance` }] : []),
      ],
    },
    {
      label: n.sectionInsight,
      items: [
        ...(can(ctx, "report.view") ? [{ key: "reports", label: n.reports, href: `${b}/reports` }] : []),
        { key: "notifications", label: n.notifications, href: `${b}/notifications`, badge: badges.notifications },
      ],
    },
    {
      label: n.sectionAdmin,
      items: [
        ...(can(ctx, "org.members.view") ? [{ key: "members", label: n.members, href: `${b}/settings/members` }] : []),
        ...(can(ctx, "org.directory.manage") ? [{ key: "clients", label: n.clients, href: `${b}/settings/clients` }, { key: "venues", label: n.venues, href: `${b}/settings/venues` }] : []),
        ...(can(ctx, "automation.manage") ? [{ key: "automation", label: n.automation, href: `${b}/settings/automation` }] : []),
        ...(can(ctx, "org.audit.view") ? [{ key: "audit", label: n.audit, href: `${b}/settings/audit` }] : []),
        ...(can(ctx, "org.manage") ? [{ key: "settings", label: n.settings, href: `${b}/settings` }] : []),
      ],
    },
  ];
  return sections.filter((s) => s.items.length);
}
