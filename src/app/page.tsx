import { redirect } from "next/navigation";
import { getSession } from "@/server/request";

export default async function Home() {
  const session = await getSession();
  redirect(session ? "/select-org" : "/login");
}
