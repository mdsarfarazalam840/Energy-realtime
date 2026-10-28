/* Deterministic fallback snapshot so the dashboard still tells the story when
   the export has not run yet. It is always labelled as demo data. */

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDemoSnapshot(now = Date.now()) {
  const random = mulberry32(0x51de77);
  const stepMs = 2 * 3600 * 1000;
  const days = 14;
  const count = Math.floor((days * 24 * 3600 * 1000) / stepMs);
  const end = Math.floor(now / stepMs) * stepMs - 10 * 60 * 1000;
  const start = end - (count - 1) * stepMs;
  const points = [];

  for (let i = 0; i < count; i += 1) {
    const t = start + i * stepMs;
    const date = new Date(t);
    const hour = date.getUTCHours() + date.getUTCMinutes() / 60;
    const day = i / (count / 14);

    const daily = Math.sin(((hour - 7) / 24) * Math.PI * 2);
    const weekly = Math.sin((day / 7) * Math.PI * 2 + 0.6);
    const drift = (random() - 0.5) * 14;
    const spike = random() > 0.975 ? (random() - 0.35) * 120 : 0;
    const entsoePrice = 172 + daily * 46 + weekly * 22 + drift + spike;

    const eleczDaily = Math.sin(((hour - 9) / 24) * Math.PI * 2);
    const eleczNoise = (random() - 0.5) * 7;
    const eleczSpike = random() > 0.96 ? (random() - 0.55) * 34 : 0;
    const eleczPrice = 21 + eleczDaily * 12 + eleczNoise + eleczSpike;

    const aemoDaily = Math.sin(((hour - 17) / 24) * Math.PI * 2);
    const aemoNoise = (random() - 0.5) * 32;
    const aemoPrice = 82 + aemoDaily * 38 + aemoNoise;

    points.push({
      t,
      z: "DE_LU",
      p: Math.round(entsoePrice * 100) / 100,
      s: "entsoe",
    });
    points.push({
      t: t + 4 * 60 * 1000,
      z: "DE",
      p: Math.round(eleczPrice * 100) / 100,
      s: "elecz",
    });
    for (const [index, zone] of ["NSW1", "QLD1", "VIC1", "SA1", "TAS1"].entries()) {
      const regionalPrice = aemoPrice + (index - 2) * 5 + (random() - 0.5) * 11;
      points.push({
        t: t + 8 * 60 * 1000 + index * 12000,
        z: zone,
        p: Math.round(regionalPrice * 100) / 100,
        s: "aemo",
      });
    }
  }

  const latest = Math.max(...points.map((point) => point.t));

  return {
    schema_version: 1,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    mode: "demo",
    demo: true,
    meta: {
      table: "demo.energy_prices_realtime",
      window_days: days,
      row_count: points.length,
      raw_row_count: points.length,
      sources: ["aemo", "elecz", "entsoe"],
      zones: ["DE", "DE_LU", "NSW1", "QLD1", "SA1", "TAS1", "VIC1"],
      currency: "EUR/MWh",
      first_timestamp: new Date(points[0].t).toISOString(),
      latest_timestamp: new Date(latest).toISOString(),
      latest_timestamp_ms: latest,
      query_ms: 0,
      demo: true,
    },
    points,
  };
}
