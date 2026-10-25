import { getI18n } from "@/lib/i18n/server";
import { ForgotForm } from "./forgot-form";

export const metadata = { title: "Reset password" };

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email } = await searchParams;
  const { m } = await getI18n();
  return (
    <div>
      <h1 className="text-2xl font-medium">{m.auth.forgot.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{m.auth.forgot.subtitle}</p>
      <ForgotForm email={typeof email === "string" ? email.slice(0, 200) : ""} />
    </div>
  );
}
