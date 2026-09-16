/**
 * Provision the invite-only test accounts (email + password, plan pro).
 * Works against ANY Supabase (local now, cloud at deploy) — set env first:
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 * Usage:
 *   npx tsx scripts/provision-users.ts            (creates the 4 default accounts)
 *   npx tsx scripts/provision-users.ts email pass (creates/updates one account)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const DEFAULT_ACCOUNTS: [string, string][] = [
  ["test1@readdeeper.app", "Zebra-Citeste-71"],
  ["test2@readdeeper.app", "Somn-Adanc-82"],
  ["test3@readdeeper.app", "Margine-Carte-93"],
  ["test4@readdeeper.app", "Pagina-Vie-64"],
];

async function main() {
  const { createSupabaseAdmin } = await import("../lib/supabase/admin");
  const admin = createSupabaseAdmin();
  const accounts: [string, string][] =
    process.argv[2] && process.argv[3] ? [[process.argv[2], process.argv[3]]] : DEFAULT_ACCOUNTS;

  console.log(`Tinta: ${process.env.NEXT_PUBLIC_SUPABASE_URL}\n`);
  for (const [email, password] of accounts) {
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    let userId = created?.user?.id;
    if (error) {
      // already exists -> reset the password so the handed-out one always works
      const { data: list } = await admin.auth.admin.listUsers();
      const existing = list?.users.find((u) => u.email === email);
      if (!existing) {
        console.log(`FAIL ${email}: ${error.message}`);
        continue;
      }
      userId = existing.id;
      const { error: updErr } = await admin.auth.admin.updateUserById(userId, { password });
      if (updErr) {
        console.log(`FAIL ${email}: ${updErr.message}`);
        continue;
      }
    }
    await admin.from("profiles").upsert({ user_id: userId!, plan: "pro" });
    console.log(`OK   ${email}  parola: ${password}  (plan: pro)`);
  }
  console.log("\nGata — da-le prietenilor emailul + parola; se logheaza la /login.");
}
void main();
