// Test-only: a small multi-table fake of the supabase-js query builder, enough for
// lib/notify.js and lambdas/sundial-notify. Shared by both suites. Not bundled by any
// Lambda (nothing under lambdas/ imports it).
//
// Supports: from(table).select(cols, { count, head }) / insert / upsert / update / delete,
// then .eq .in .is .not .order .limit .maybeSingle .single, awaited. `upsert` honours
// `onConflict` ("a,b") and `ignoreDuplicates`; a conflict with ignoreDuplicates=false
// replaces the row (what PostgREST does with merge-duplicates).

export function fakeSupabase(store, { failInsert = false } = {}) {
  let seq = 1;
  const nextId = () => `row-${seq++}`;
  function chain(table, op, payload, opts = {}) {
    const rows = () => (store[table] ||= []);
    const c = { filters: [], order: null, limit: null, single: false, count: null, head: false };
    const apply = () => {
      let out = rows().filter((r) => c.filters.every((f) => f(r)));
      if (c.order) out = [...out].sort((a, b) => (a[c.order.col] < b[c.order.col] ? -1 : 1) * (c.order.asc ? 1 : -1));
      if (c.limit != null) out = out.slice(0, c.limit);
      return out;
    };
    const finish = () => {
      if (op === "insert") {
        if (failInsert) return { data: null, error: { message: "insert refused (test)" } };
        const list = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: nextId(), ...p }));
        rows().push(...list);
        return { data: list, error: null };
      }
      if (op === "upsert") {
        if (failInsert) return { data: null, error: { message: "insert refused (test)" } };
        const keys = String(opts.onConflict || "id").split(",").map((s) => s.trim());
        const out = [];
        for (const p of Array.isArray(payload) ? payload : [payload]) {
          // NULL never conflicts (Postgres treats NULLs as distinct in a unique index).
          const hit = keys.every((k) => p[k] != null) ? rows().find((r) => keys.every((k) => r[k] === p[k])) : null;
          if (hit) {
            if (opts.ignoreDuplicates) continue;
            Object.assign(hit, p);
            out.push(hit);
          } else {
            const row = { id: nextId(), ...p };
            rows().push(row);
            out.push(row);
          }
        }
        return { data: out, error: null };
      }
      if (op === "update") {
        const hit = apply();
        for (const r of hit) Object.assign(r, payload);
        return { data: hit, error: null };
      }
      if (op === "delete") {
        const hit = apply();
        store[table] = rows().filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      const data = apply();
      if (c.head) return { data: null, error: null, count: data.length };
      return { data, error: null, count: c.count ? data.length : null };
    };
    const api = {
      select: (_cols, o) => ((c.count = o?.count ?? null), (c.head = !!o?.head), api),
      eq: (col, v) => (c.filters.push((r) => r[col] === v), api),
      neq: (col, v) => (c.filters.push((r) => r[col] !== v), api),
      in: (col, vals) => (c.filters.push((r) => vals.includes(r[col])), api),
      is: (col, v) => (c.filters.push((r) => r[col] === v), api),
      not: (col, _o, v) => (c.filters.push((r) => !(r[col] === (v === "null" ? null : v))), api),
      gt: (col, v) => (c.filters.push((r) => r[col] > v), api),
      lt: (col, v) => (c.filters.push((r) => r[col] < v), api),
      order: (col, o) => ((c.order = { col, asc: o?.ascending !== false }), api),
      limit: (n) => ((c.limit = n), api),
      maybeSingle: () => Promise.resolve(finish()).then((res) => ({ ...res, data: res.data?.[0] ?? null })),
      single: () => Promise.resolve(finish()).then((res) => ({ ...res, data: res.data?.[0] ?? null })),
      then: (resolve, reject) => Promise.resolve(finish()).then(resolve, reject),
    };
    return api;
  }
  return {
    from: (table) => ({
      select: (cols, o) => chain(table, "select").select(cols, o),
      insert: (row) => chain(table, "insert", row),
      upsert: (row, opts) => chain(table, "upsert", row, opts),
      update: (patch) => chain(table, "update", patch),
      delete: () => chain(table, "delete"),
    }),
  };
}
