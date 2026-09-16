import { redirect } from "next/navigation";

/** Documents live in the reader's Recents menu now. */
export default function DocumentsGone() {
  redirect("/");
}
