import Link from "next/link";
import { redirect } from "next/navigation";
import { getI18n } from "@/lib/i18n/server";
import { getSession } from "@/server/request";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const session = await getSession();
  const { next } = await searchParams;
  if (session) redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/select-org");
  const { m } = await getI18n();
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{m.auth.signInTitle}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{m.auth.signInSubtitle}</p>
      <LoginForm next={next} />
      <p className="mt-6 text-sm text-muted-foreground">
        {m.auth.noAccount}{" "}
        <Link href="/register" className="font-medium text-primary hover:underline">
          {m.auth.register}
        </Link>
      </p>
    </div>
  );
}
