import { redirect } from "next/navigation";

/**
 * The command center moved to `/dashboard`, which is now the Overview. This
 * route stays behind so existing bookmarks and shared links keep working.
 */
export default function NewDashboardPage() {
  redirect("/dashboard");
}
