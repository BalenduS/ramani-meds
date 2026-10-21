// Sends Web Push notifications to the family's phones.
// Called by database triggers (every change) and by pg_cron every 5 minutes (reminders).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const START_UTC = Date.UTC(2026, 9, 18); // Day 1 = Sun 18 Oct 2026 (IST date)
const DAYS = 15;
const MEDS: Record<string, { n: string; slots: string[]; days: number; unit?: string }> = {
  o2: { n: "Oxygen off", slots: ["dawn"], days: 15 },
  wys: { n: "Wysolone", slots: ["am", "pm"], days: 10, unit: "tablets" },
  pul: { n: "Pulmoclear", slots: ["am", "pm"], days: 15, unit: "tablets" },
  erd: { n: "Erdosteine", slots: ["am", "pm"], days: 15, unit: "tablets" },
  for: { n: "Foracort neb", slots: ["am", "pm"], days: 15, unit: "respules" },
  rev: { n: "Revesmart neb", slots: ["noon"], days: 15, unit: "respules" },
  max: { n: "Maxvryz", slots: ["noon"], days: 15, unit: "tablets" },
  bip: { n: "BiPAP", slots: ["night"], days: 15 },
};
const CHECK_HOURS = ["06", "09", "12", "15", "18", "21"];
const W = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
function fmt(t: string) {
  let [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")} ${ap}` : `${h} ${ap}`;
}
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  const day = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - START_UTC) / 864e5);
  return { day, min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function dateLabel(i: number) {
  const d = new Date(START_UTC + i * 864e5);
  return `${W[d.getUTCDay()]} ${d.getUTCDate()} ${M[d.getUTCMonth()]}`;
}
async function getTimes() {
  const { data } = await sb.from("settings").select("value").eq("key", "times").maybeSingle();
  const t = Object.assign({ am: "08:00", pm: "20:00", night: "22:00" }, data?.value || {});
  return { ...t, noon: "14:00", dawn: "06:00" } as Record<string, string>;
}
const nameOf = (id: string) => (id.startsWith("sp") ? "SpO₂ check" : MEDS[id]?.n || id);
const timeOfRow = (slot: string, med: string, times: Record<string, string>) =>
  med === "o2" ? "06:00" : med.startsWith("sp") ? `${med.slice(2)}:00` : times[slot] || "08:00";

type Msg = { title: string; body: string; tag?: string };

async function send(msg: Msg, opts: { reminders?: boolean; exclude?: string | null; endpoint?: string }) {
  const { data: cfg } = await sb.from("push_config").select("vapid_public,vapid_private").single();
  webpush.setVapidDetails("https://balendus.github.io/ramani-meds/", cfg!.vapid_public, cfg!.vapid_private);
  let q = sb.from("push_sub").select("endpoint,p256dh,auth,name,activity,reminders");
  if (opts.endpoint) q = q.eq("endpoint", opts.endpoint);
  const { data: subs } = await q;
  const ex = (opts.exclude || "").trim().toLowerCase();
  const targets = (subs || []).filter((s) =>
    opts.endpoint ? true : (opts.reminders ? s.reminders : s.activity) && !(ex && (s.name || "").trim().toLowerCase() === ex)
  );
  const payload = JSON.stringify({ ...msg, url: "./" });
  const results = await Promise.allSettled(targets.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: "high" })
  ));
  const gone: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const code = (r.reason as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) gone.push(targets[i].endpoint);
      else console.log("push failed", code, String((r.reason as Error)?.message || r.reason));
    }
  });
  if (gone.length) await sb.from("push_sub").delete().in("endpoint", gone);
  return { sent: targets.length - gone.length, removed: gone.length };
}

async function handleEvent(p: any) {
  const times = await getTimes();
  const today = istNow().day;
  const dayNote = (d: number) => (d === today ? "" : ` (${dateLabel(d)})`);
  const rows: any[] = p.rows || [];
  if (!rows.length) return { skipped: true };

  if (p.kind === "dose") {
    const r0 = rows[0];
    const t = fmt(timeOfRow(r0.slot, r0.med, times));
    const names = rows.map((r) => nameOf(r.med)).join(", ");
    if (p.op === "insert") {
      if (rows.length === 1 && r0.med === "o2")
        return send({ title: "Oxygen switched off", body: `By ${r0.by || "someone"}${dayNote(r0.day)}` }, { exclude: r0.by });
      return send({ title: `Given · ${t}${dayNote(r0.day)}`, body: `${names} · by ${r0.by || "someone"}` }, { exclude: r0.by });
    }
    return send({ title: "Tick removed", body: `${names} · ${t}${dayNote(r0.day)}` }, {});
  }
  if (p.kind === "spo2") {
    const r = rows[0];
    return send({
      title: `SpO₂ ${r.v}%${r.p ? ` · pulse ${r.p}` : ""}`,
      body: `${fmt(r.check.slice(2) + ":00")} check · by ${r.by || "someone"}${dayNote(r.day)}`,
    }, { exclude: r.by });
  }
  if (p.kind === "stock") {
    const r = rows[0];
    return send({ title: "Stock updated", body: `${nameOf(r.med)}: ${r.n} ${MEDS[r.med]?.unit || ""} at home · by ${r.by || "someone"}` }, { exclude: r.by });
  }
  if (p.kind === "times") {
    const v = rows[0].value || {};
    return send({ title: "Dose times changed", body: `Morning ${fmt(v.am)} · Evening ${fmt(v.pm)} · Bedtime ${fmt(v.night)}` }, {});
  }
  return { skipped: true };
}

async function handleTick() {
  const { day, min } = istNow();
  if (day < 0 || day >= DAYS) return { skipped: "outside plan" };
  const times = await getTimes();
  const { data: done } = await sb.from("dose_log").select("slot,med_id").eq("day", day);
  const has = new Set((done || []).map((r) => `${r.slot}|${r.med_id}`));
  const dbSlot = (s: string) => (s === "dawn" || s === "chk" ? "am" : s);

  type Item = { key: string; t: number; label: string; slot: string; ids: string[] };
  const items: Item[] = [];
  for (const slot of ["dawn", "am", "noon", "pm", "night"]) {
    const ids = Object.entries(MEDS).filter(([, m]) => m.slots.includes(slot) && day < m.days).map(([id]) => id);
    if (ids.length) items.push({ key: slot, t: toMin(times[slot]), label: fmt(times[slot]), slot, ids });
  }
  for (const h of CHECK_HOURS) {
    const t = toMin(`${h}:00`);
    if (t < toMin(times.night)) items.push({ key: `sp${h}`, t, label: fmt(`${h}:00`), slot: "chk", ids: [`sp${h}`] });
  }

  const out: string[] = [];
  for (const it of items) {
    const pending = it.ids.filter((id) => !has.has(`${dbSlot(it.slot)}|${id}`));
    if (!pending.length) continue;
    const isCheck = it.slot === "chk";
    const what = isCheck ? "SpO₂ check" : it.slot === "dawn" ? "Switch off the oxygen" : pending.map(nameOf).join(", ");
    let phase: "b" | "a" | null = null;
    if (min >= it.t - 15 && min < it.t - 5) phase = "b";
    else if (min >= it.t + 30 && min < it.t + 60) phase = "a";
    if (!phase) continue;
    const k = `${day}|${it.key}|${phase}`;
    const { error } = await sb.from("reminder_sent").insert({ k });
    if (error) continue; // already sent
    const msg: Msg = phase === "b"
      ? { title: `In 10 min · ${it.label}`, body: what, tag: `r-${day}-${it.key}` }
      : { title: `Not ticked yet · ${it.label}`, body: `${what}. Tap to open and tick it.`, tag: `r-${day}-${it.key}` };
    await send(msg, { reminders: true });
    out.push(k);
  }
  return { sent: out };
}

Deno.serve(async (req) => {
  try {
    const { data: cfg } = await sb.from("push_config").select("notify_secret").single();
    if (!cfg || req.headers.get("x-notify-secret") !== cfg.notify_secret) return new Response("forbidden", { status: 403 });
    const p = await req.json();
    let res: unknown;
    if (p.kind === "tick") res = await handleTick();
    else if (p.kind === "test") res = await send({ title: "Notifications are on", body: "This phone will get updates from the family and dose reminders." }, { endpoint: p.endpoint });
    else res = await handleEvent(p);
    return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.log("notify error", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
