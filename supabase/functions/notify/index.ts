// Sends Web Push notifications to the family's phones.
// Called by database triggers (every change) and by pg_cron every 5 minutes (reminders).
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// Ongoing plan from the 31 Oct 2026 review. The old 15-day plan (dose_log) is archived: no reminders for it.
const MEDS: Record<string, { n: string; unit?: string }> = {
  wy2: { n: "Wysolone 10 mg", unit: "tablets" },
  ezd: { n: "Erdozyd-AB", unit: "tablets" },
  azf: { n: "Airz-FB neb", unit: "respules" },
};
const SLOTS = ["am", "pm"];
const SLOT_NAME: Record<string, string> = { am: "Morning", pm: "Night" };
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
  const date = d.toISOString().slice(0, 10);
  return { date, min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function dateLabel(s: string) {
  const d = new Date(s + "T00:00:00Z");
  return `${W[d.getUTCDay()]} ${d.getUTCDate()} ${M[d.getUTCMonth()]}`;
}
async function getTimes() {
  const { data } = await sb.from("settings").select("value").eq("key", "times").maybeSingle();
  return Object.assign({ am: "08:00", pm: "20:00" }, data?.value || {}) as Record<string, string>;
}
const nameOf = (id: string) => MEDS[id]?.n || id;
const ctxName = (c: string) => (c === "o2" ? "on O₂" : "room air");

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
  const today = istNow().date;
  const rows: any[] = p.rows || [];
  if (!rows.length) return { skipped: true };

  if (p.kind === "dose2") {
    const r0 = rows[0];
    const when = `${SLOT_NAME[r0.slot] || r0.slot}${r0.date === today ? "" : ` (${dateLabel(r0.date)})`}`;
    const names = rows.map((r) => nameOf(r.med)).join(", ");
    if (p.op === "insert") return send({ title: `Given · ${when}`, body: `${names} · by ${r0.by || "someone"}` }, { exclude: r0.by });
    return send({ title: "Tick removed", body: `${names} · ${when}` }, {});
  }
  if (p.kind === "o2") {
    const r = rows[0];
    const low = r.v != null && r.alert != null && r.v < r.alert;
    const sp = r.v != null ? `SpO₂ ${r.v}% ${ctxName(r.ctx)}${r.p ? `, pulse ${r.p}` : ""}` : "";
    const fl = (v: unknown) => (v == null ? "" : `${Number(v)} L/min`);
    let by = `by ${r.by || "someone"}`;
    if (r.backdated && r.at) {
      const d = new Date(new Date(r.at).getTime() + 5.5 * 3600e3);
      by += ` · for ${fmt(`${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`)}`;
    }
    let title: string, body: string;
    if (r.k !== "break" && r.prev === r.k) {
      title = `Oxygen flow changed to ${fl(r.flow)}`;
      body = [r.prevflow != null ? `Was ${fl(r.prevflow)}` : "", by].filter(Boolean).join(" · ");
    } else if (r.k === "break") {
      title = low ? `Low SpO₂ ${r.v}% · break started` : "Oxygen break started";
      body = [sp, r.remind ? `reminder in ${r.remind} min` : "", by].filter(Boolean).join(" · ");
    } else if (r.k === "bipap") {
      title = `Oxygen + BiPAP started${r.flow ? ` · ${fl(r.flow)}` : ""}`;
      body = [sp, by].filter(Boolean).join(" · ");
    } else if (r.prev === "break") {
      title = low ? `Low SpO₂ ${r.v}% after the break` : `Break over · oxygen back on${r.flow ? ` · ${fl(r.flow)}` : ""}`;
      body = [sp, r.mins != null ? `${r.mins} min off oxygen` : "", by].filter(Boolean).join(" · ");
    } else if (r.prev === "bipap") {
      title = "BiPAP off · oxygen continues";
      body = by;
    } else {
      title = `Oxygen on${r.flow ? ` · ${fl(r.flow)}` : ""}`;
      body = [sp, by].filter(Boolean).join(" · ");
    }
    // A low reading goes to everyone, including the person who logged it.
    return send({ title, body, tag: low ? "low-spo2" : undefined }, { exclude: low ? null : r.by });
  }
  if (p.kind === "spo2b") {
    const r = rows[0];
    const low = r.alert != null && r.v < r.alert;
    return send({
      title: `${low ? "Low SpO₂" : "SpO₂"} ${r.v}% ${ctxName(r.ctx)}`,
      body: `${r.p ? `Pulse ${r.p} · ` : ""}by ${r.by || "someone"}`,
    }, { exclude: low ? null : r.by });
  }
  if (p.kind === "stock") {
    const r = rows[0];
    return send({ title: "Stock updated", body: `${nameOf(r.med)}: ${r.n} ${MEDS[r.med]?.unit || ""} at home · by ${r.by || "someone"}` }, { exclude: r.by });
  }
  if (p.kind === "times") {
    const v = rows[0].value || {};
    return send({ title: "Dose times changed", body: `Morning ${fmt(v.am)} · Night ${fmt(v.pm)}` }, {});
  }
  return { skipped: true };
}

async function once(k: string) {
  const { error } = await sb.from("reminder_sent").insert({ k });
  return !error;
}

async function handleTick() {
  const { date, min } = istNow();
  const out: string[] = [];

  // Oxygen break reminders: when the chosen time is up, and again 15 min later if still on break.
  const { data: last } = await sb.from("o2_event").select("id,kind,at,remind_at,by").order("at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (last && last.kind === "break" && last.remind_at) {
    const due = new Date(last.remind_at).getTime(), now = Date.now();
    const mins = Math.round((now - new Date(last.at).getTime()) / 6e4);
    for (const [ph, at] of [["1", due], ["2", due + 15 * 6e4]] as [string, number][]) {
      if (now >= at && now < at + 60 * 6e4 && await once(`brk|${last.id}|${ph}`)) {
        await send({
          title: ph === "1" ? "Break time is up" : `Still off oxygen · ${mins} min`,
          body: "Check SpO₂ on room air, then put the oxygen back on and log it.",
          tag: `brk-${last.id}`,
        }, { reminders: true });
        out.push(`brk|${last.id}|${ph}`);
      }
    }
  }

  // Medicine reminders: 10 min before, and 30 min after if not ticked.
  const times = await getTimes();
  const { data: done } = await sb.from("med_log2").select("slot,med_id").eq("date", date);
  const has = new Set((done || []).map((r) => `${r.slot}|${r.med_id}`));
  for (const slot of SLOTS) {
    const t = toMin(times[slot]);
    const pending = Object.keys(MEDS).filter((id) => !has.has(`${slot}|${id}`));
    if (!pending.length) continue;
    let phase: "b" | "a" | null = null;
    if (min >= t - 15 && min < t - 5) phase = "b";
    else if (min >= t + 30 && min < t + 60) phase = "a";
    if (!phase) continue;
    const k = `${date}|${slot}|${phase}`;
    if (!(await once(k))) continue;
    const what = pending.map(nameOf).join(", ");
    const label = `${SLOT_NAME[slot]} · ${fmt(times[slot])}`;
    await send(phase === "b"
      ? { title: `In 10 min · ${label}`, body: what, tag: `r-${date}-${slot}` }
      : { title: `Not ticked yet · ${label}`, body: `${what}. Tap to open and tick it.`, tag: `r-${date}-${slot}` }, { reminders: true });
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
