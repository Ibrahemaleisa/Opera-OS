"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, NativeSelect } from "@/components/app/field";
import { Section } from "@/components/app/page";
import { useAction } from "@/hooks/use-action";
import { formObject } from "@/lib/form";
import { useI18n } from "@/lib/i18n/client";
import { updateOrgAction } from "./actions";
import { DigitsInput, NumberInput } from "@/components/app/number-input";

export function OrgSettingsForm({ orgSlug, initial }: { orgSlug: string; initial: Record<string, string | number> }) {
  const { m } = useI18n();
  const { run, pending, errorFor } = useAction(updateOrgAction, { orgSlug });
  return (
    <form
      className="grid max-w-4xl gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        run(formObject(e.currentTarget) as never);
      }}
    >
      <Section title={m.org.profile}>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label={m.common.nameAr} error={errorFor("name")} required><Input name="name" defaultValue={initial.name} required /></Field>
          <Field label={m.common.nameEn}><Input name="nameEn" defaultValue={initial.nameEn} dir="ltr" /></Field>
          <Field label={m.org.legalName}><Input name="legalName" defaultValue={initial.legalName} /></Field>
          <Field label={m.common.city}><Input name="city" defaultValue={initial.city} /></Field>
          <Field label={m.org.crNumber}><DigitsInput name="crNumber" defaultValue={initial.crNumber} /></Field>
          <Field label={m.org.vatNumber}><DigitsInput name="vatNumber" defaultValue={initial.vatNumber} /></Field>
          <Field label={m.common.email} error={errorFor("email")}><Input name="email" type="email" defaultValue={initial.email} dir="ltr" /></Field>
          <Field label={m.common.phone}><DigitsInput kind="tel" name="phone" defaultValue={initial.phone} /></Field>
        </div>
      </Section>
      <Section title={m.org.branding}>
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <Field label={m.org.brandColor} error={errorFor("brandColor")} htmlFor="org-brand-color">
            <div className="flex gap-2">
              <input id="org-brand-color" type="color" name="brandColor" defaultValue={String(initial.brandColor)} className="h-9 w-12 cursor-pointer rounded-md border bg-card p-1" />
            </div>
          </Field>
          <Field label={m.org.defaultLocale}>
            <NativeSelect name="defaultLocale" defaultValue={initial.defaultLocale}>
              <option value="ar">العربية</option>
              <option value="en">English</option>
            </NativeSelect>
          </Field>
          <Field label={m.org.calendar}>
            <NativeSelect name="calendar" defaultValue={initial.calendar}>
              <option value="gregory">{m.common.gregorian}</option>
              <option value="islamic-umalqura">{m.common.hijri}</option>
            </NativeSelect>
          </Field>
        </div>
      </Section>
      <Section title={m.nav.finance}>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label={m.org.financeThreshold} hint={m.org.financeThresholdHint}><NumberInput name="financeApprovalThreshold" defaultValue={initial.financeApprovalThreshold} /></Field>
          <Field label={m.org.retentionDays} hint={m.org.retentionHint}><NumberInput name="recipientRetentionDays" decimal={false} defaultValue={initial.recipientRetentionDays} /></Field>
        </div>
      </Section>
      <div><Button type="submit" disabled={pending}>{pending ? m.common.saving : m.common.save}</Button></div>
    </form>
  );
}
