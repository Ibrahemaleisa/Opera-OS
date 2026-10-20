import Link from "next/link";
import { getI18n } from "@/lib/i18n/server";
import { RegisterForm } from "./register-form";

export const metadata = { title: "Create workspace" };

export default async function RegisterPage() {
  const { m } = await getI18n();
  return (
    <div>
      <h1 className="text-2xl font-medium">{m.auth.registerTitle}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{m.auth.registerSubtitle}</p>
      <RegisterForm />
      <p className="mt-6 text-sm text-muted-foreground">
        {m.auth.haveAccount}{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          {m.auth.signIn}
        </Link>
      </p>
    </div>
  );
}
