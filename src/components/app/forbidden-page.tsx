import Link from "next/link";
import { getI18n } from "@/lib/i18n/server";

export async function ForbiddenPage() {
  const { m } = await getI18n();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="tabular text-5xl font-medium text-muted-foreground/40">403</p>
      <h1 className="text-lg font-medium">{m.errors.pageForbiddenTitle}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{m.errors.pageForbiddenBody}</p>
      <Link href="/" className="mt-3 text-sm text-primary hover:underline">{m.common.back}</Link>
    </div>
  );
}
