import { redirect } from "next/navigation";

/** The library concept is gone — the app opens straight into the reader. */
export default function LibraryGone() {
  redirect("/");
}
