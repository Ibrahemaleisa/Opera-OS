"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/app/field";
import { useI18n } from "@/lib/i18n/client";
import { optOutAction, submitRsvpAction } from "./actions";

type Response = "ATTENDING" | "DECLINED" | "MAYBE";

export function RsvpForm({ token, status, closed, suppressed, askOptOut }: { token: string; status: string | null; closed: boolean; suppressed: boolean; askOptOut: boolean }) {
  const { m, tk } = useI18n();
  const p = m.digital.public;
  const router = useRouter();
  const [response, setResponse] = useState<Response>((status as Response) ?? "ATTENDING");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [optedOut, setOptedOut] = useState(suppressed);
  const [pending, start] = useTransition();

  const doOptOut = () =>
    start(async () => {
      const r = await optOutAction(token);
      if (r.ok) setOptedOut(true);
      else setError(tk(r.error));
    });

  if (optedOut) return <p className="rounded-md bg-muted px-3 py-2 text-sm" data-testid="rsvp-opted-out">{p.optedOut}</p>;
  if (askOptOut)
    return (
      <div className="grid gap-3">
        <Button variant="outline" disabled={pending} onClick={doOptOut} data-testid="rsvp-optout">{p.optOut}</Button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    );

  return (
    <div className="grid gap-4">
      {(done || status) && <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-success" data-testid="rsvp-thanks">{p.thanks}</p>}
      {closed ? (
        <p className="text-sm text-muted-foreground">{p.closed}</p>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            setError(null);
            start(async () => {
              const r = await submitRsvpAction({ token, response, guestsCount: fd.get("guestsCount") || 1, note: (fd.get("note") as string) || null });
              if (r.ok) {
                setDone(true);
                router.refresh();
              } else setError(tk(r.error));
            });
          }}
        >
          <p className="text-sm font-medium">{p.respond}</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup">
            {(["ATTENDING", "DECLINED", "MAYBE"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={response === k}
                onClick={() => setResponse(k)}
                data-testid={`rsvp-${k.toLowerCase()}`}
                className={`rounded-md border px-2 py-2 text-sm transition-colors ${response === k ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                {k === "ATTENDING" ? p.attending : k === "DECLINED" ? p.declined : p.maybe}
              </button>
            ))}
          </div>
          {response !== "DECLINED" && (
            <Field label={p.guests} htmlFor="guestsCount"><Input id="guestsCount" name="guestsCount" type="number" min={1} max={10} defaultValue={1} dir="ltr" /></Field>
          )}
          <Field label={p.note} htmlFor="note"><Textarea id="note" name="note" rows={2} maxLength={500} /></Field>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button type="submit" disabled={pending} data-testid="rsvp-submit">{p.submit}</Button>
        </form>
      )}
      <button type="button" className="justify-self-center text-[11px] text-muted-foreground hover:underline" onClick={doOptOut} disabled={pending}>{p.optOut}</button>
    </div>
  );
}
