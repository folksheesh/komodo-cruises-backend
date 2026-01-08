/**
 * KONFIGURASI
 */
const GOOGLE_API_KEY = "AIzaSyCaBu5hbQiZQbt8wl10bJzM08jFVuGeSuI";
const SPREADSHEET_ID = "1FqMYrf_uVoL_lU2WuoFj_59rXPHttuAqDI_mxnVN42I"; // Dest Sheet ID
const SHEET_NAME = "2026 OT (Normalized)";
const CABIN_DETAIL_SHEET = "Cabin Detail";

const OT2026 = [
  "SEMESTA VOYAGES",
  "AKASSA CRUISE",
  "DERYA LIVEABOARD",
  "GIONA LIVEABOARD",
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // CORS preflight support
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 1. Parsing Parameter
    const resource = (url.searchParams.get("resource") || "").toLowerCase();
    const date = url.searchParams.get("date");
    const cabinName = url.searchParams.get("name");
    const guests = parseInt(url.searchParams.get("guests") || "1", 10);

    // 2. Routing
    try {
      // === API: Cabin Detail ===
      if (resource === "cabindetail") {
        const details = await loadCabinDetailCached(env); // Panggil fungsi helper

        if (cabinName) {
          const found = details.find(
            (c) => c.cabin_name?.toUpperCase() === cabinName.toUpperCase()
          );
          if (!found) return jsonErr(`Cabin '${cabinName}' not found`);
          return jsonOk({ data: found });
        }
        return jsonOk({ total: details.length, data: details });
      }

      // === API: Operators ===
      if (resource === "operators") {
        return jsonOk({
          total: OT2026.length,
          operators: OT2026.map((x) => ({
            operator: x,
            sourceSheet: `${x} (Normalized)`,
          })),
        });
      }

      // === Fetch Main Data (Normalized) ===
      // Kita fetch data "Values" dan "Colors" sekaligus
      const sheetData = await loadSheetDataCached(SHEET_NAME, env);

      // === API: Cabins List ===
      if (resource === "cabins") {
        const allCabins = listCabinsAll(sheetData);
        return jsonOk({ cabins: allCabins });
      }

      // Validasi Date untuk Availability
      if (!date) return jsonErr("Missing ?date=YYYY-MM-DD");

      // Proses Logika Utama
      const res = summarizeOT2026ByDate(sheetData, date);

      if (resource === "availability") {
        return jsonOk({ date, ...res });
      }

      if (resource === "search") {
        if (!cabinName) return jsonErr("Missing ?name=cabinName");

        const cabinNorm = normalizeCabinName(cabinName);
        const matches = [];

        res.operators.forEach((op) => {
          const found = op.cabins.find(
            (c) => c.name.toUpperCase() === cabinNorm.toUpperCase()
          );
          if (found && found.available >= guests) {
            matches.push({ operator: op.operator, available: found.available });
          }
        });

        return jsonOk({ date, cabin: cabinNorm, guests, matches });
      }

      return jsonErr("Unknown resource");
    } catch (err) {
      return jsonErr(err.message);
    }
  },
};

/* =======================================================================
 * DATA FETCHING LAYERS (Pengganti SpreadsheetApp)
 * =======================================================================*/

// Helper: Fetch Google API dan Cache hasilnya di memory Cloudflare (Cache API)
async function loadSheetDataCached(sheetName, env) {
  const cacheKey = `sheet-data-${sheetName}`;
  // Implementasi cache sederhana bisa menggunakan KV atau Cache API
  // Di sini kita fetch langsung untuk mempersingkat kode, tapi di prod wajib cache.

  // URL untuk mengambil Value (teks) dan Format (background color)
  // fields=sheets.data.rowData.values(formattedValue,userEnteredFormat.backgroundColor)
  // includeGridData=true itu berat, jadi kita limit fields-nya.
  const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?includeGridData=true&ranges=${encodeURIComponent(
    sheetName
  )}&fields=sheets(data(rowData(values(formattedValue,userEnteredFormat(backgroundColor)))))&key=${GOOGLE_API_KEY}`;

  const resp = await fetch(apiUrl);
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(
      `Gagal fetch Google Sheets API (${resp.status}): ${errorText}`
    );
  }
  const json = await resp.json();

  if (!json.sheets || !json.sheets[0]) throw new Error("Sheet not found");

  // Transformasi JSON Google API yang rumit menjadi Array 2D sederhana seperti GAS
  const rows = json.sheets[0].data[0].rowData || [];

  const values = [];
  const backgrounds = [];

  rows.forEach((row) => {
    const valRow = [];
    const bgRow = [];
    if (row.values) {
      row.values.forEach((cell) => {
        // Ambil text
        valRow.push(cell.formattedValue || "");

        // Ambil warna (Google API return RGB 0-1. Putih biasanya kosong atau 1,1,1)
        const color = cell.userEnteredFormat?.backgroundColor || {};
        const isWhite =
          (!color.red && !color.green && !color.blue) || // Kosong = putih default
          (color.red === 1 && color.green === 1 && color.blue === 1);
        bgRow.push(isWhite ? "#ffffff" : "#colored");
      });
    }
    values.push(valRow);
    backgrounds.push(bgRow);
  });

  return { values, backgrounds };
}

// Helper: Load Cabin Detail (Port from Apps Script v4.0)
async function loadCabinDetailCached(env) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(
    CABIN_DETAIL_SHEET
  )}?key=${GOOGLE_API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Gagal fetch Cabin Detail (${resp.status}): ${errorText}`);
  }
  const json = await resp.json();
  const rows = json.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0].map((h) => (h || "").toLowerCase().trim());
  const idxOf = (name) => headers.indexOf(name);

  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];

    // Build a lowercase-key object for flexible access
    const obj = {};
    headers.forEach((h, idx) => {
      const v = (row[idx] || "").toString().trim();
      if (h && v !== "") obj[h] = v;
    });

    if (!obj["name cabin"]) continue;

    // Ported fields
    const api_name = (obj["name cabin api"] || "").toUpperCase().trim();
    const cabin_name = obj["name cabin"].trim();
    const operator = obj["name boat"] || "Unknown";
    const description = obj["description"] || "";

    // Capacity = base capacity + extra pax capacity; fallback to total capacity
    const baseCap = Number(obj["base capacity"] || 0);
    const extraCap = Number(obj["extra pax capacity"] || 0);
    let capacity = baseCap + extraCap;
    if (!capacity)
      capacity = Number(obj["total capacity"] || obj["capacity"] || 0);

    // Price: numeric from 'price' fallback to older column
    const priceRaw = obj["price"] || obj["komodo cruises-pricing"] || "";
    const price =
      Number((priceRaw || "").toString().replace(/[^\d]/g, "")) || 0;

    // Trip days
    const trip_days = Number(obj["trip (days)"] || obj["days"] || 0);

    // Collect image URLs if any columns contain URLs
    const images = [];
    Object.values(obj).forEach((v) => {
      if (typeof v === "string" && /^https?:\/\//i.test(v)) images.push(v);
    });
    const image_main = images[0] || "";

    list.push({
      api_name,
      cabin_name,
      operator,
      description,
      capacity,
      price,
      trip_days,
      images,
      image_main,
    });
  }
  return list;
}

/* =======================================================================
 * LOGIC CORE (Porting dari GAS)
 * =======================================================================*/

function listCabinsAll(sheetData) {
  const out = new Set();
  // Di sini sheetData.values adalah Array 2D
  sheetData.values.forEach((row) => {
    const name = normalizeCabinName(row[0]) || normalizeCabinName(row[1]);
    if (name) out.add(name);
  });
  return [...out].sort();
}

function summarizeOT2026ByDate(sheetData, date) {
  const { values, backgrounds } = sheetData;
  const y = +date.slice(0, 4);
  const m = +date.slice(5, 7);
  const d = +date.slice(8, 10);

  const rows = values.length;
  // Handling jika row kosong, ambil max col dari row pertama
  const cols = rows > 0 ? values[0].length : 0;

  // 1. Ship Mapping
  const shipByRow = Array(rows).fill(null);
  let currentShip = null;

  for (let r = 0; r < rows; r++) {
    // Pastikan cell ada sebelum akses index
    const cellA = (values[r][0] || "").trim().toUpperCase();
    const cellB = (values[r][1] || "").trim().toUpperCase();
    const found = OT2026.find((s) => cellA === s || cellB === s);
    if (found) currentShip = found;
    shipByRow[r] = currentShip;
  }

  const perShip = {};
  OT2026.forEach((s) => (perShip[s] = {}));

  // 2. Iterasi Ketersediaan
  for (let r = 0; r < rows - 1; r++) {
    // Safety check array bounds
    if (!values[r] || !values[r + 1]) continue;

    const vR0 = (values[r][0] || "").toUpperCase();
    const vR1 = (values[r][1] || "").toUpperCase();
    const vNext0 = (values[r + 1][0] || "").toUpperCase();
    const vNext1 = (values[r + 1][1] || "").toUpperCase();

    if (vR0 !== "NO." || vR1 !== "TYPE OF CABIN") continue;
    if (vNext0 !== "NO." || vNext1 !== "TYPE OF CABIN") continue;

    const monthRow = r;
    const spanRow = r + 1;
    const shipName = shipByRow[r];
    if (!shipName) continue;

    let endRow = spanRow + 1;
    while (endRow < rows && values[endRow] && values[endRow][1]) endRow++;

    for (let c = 2; c < cols; c++) {
      const spanTxt = values[spanRow][c];
      const span = parseDaySpan(spanTxt);
      if (!span) continue;

      let month = detectMonthFromText(values[monthRow][c]) || m;
      if (month !== m) continue;

      const match =
        span.end < span.start
          ? d === span.start
          : d >= span.start && d <= span.end;

      if (!match) continue;

      for (let rr = spanRow + 1; rr < endRow; rr++) {
        if (!values[rr]) continue;

        const raw = values[rr][1];
        const name = normalizeCabinName(raw);
        if (!name) continue;

        const txt = (values[rr][c] || "").trim();
        // Cek background color dari array hasil transformasi kita
        const bgClr =
          backgrounds[rr] && backgrounds[rr][c]
            ? backgrounds[rr][c]
            : "#ffffff";

        const empty = txt === "";
        const white = bgClr === "#ffffff";

        if (empty && white) {
          perShip[shipName][name] = (perShip[shipName][name] || 0) + 1;
        }
      }
    }
  }

  // 3. Formatting Result
  const operators = [];
  let total = 0;

  // Note: Kita butuh data detail untuk mapping nama cantik (optional)
  // Untuk performa, bisa di-skip atau di-load terpisah

  OT2026.forEach((op) => {
    const map = perShip[op] || {};
    const cabins = Object.keys(map)
      .sort()
      .map((raw) => ({
        name: raw, // Bisa ditambah logic mapping nama di sini
        available: map[raw],
      }));

    const t = cabins.reduce((s, c) => s + c.available, 0);
    total += t;
    operators.push({ operator: op, total: t, cabins });
  });

  return { total, operators };
}

/* =======================================================================
 * UTILS
 * =======================================================================*/
function parseDaySpan(txt) {
  if (!txt) return null;
  const str = txt.toString();
  const m = str.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (m) return { start: +m[1], end: +m[2] };
  const n = str.match(/^(\d{1,2})$/);
  if (n) return { start: +n[1], end: +n[1] };
  return null;
}

function detectMonthFromText(txt) {
  if (!txt) return null;
  const t = txt.toString().toUpperCase();
  if (t.includes("FEB")) return 2;
  if (t.includes("MAR")) return 3;
  if (t.includes("APR")) return 4;
  if (t.includes("MEI") || t.includes("MAY")) return 5;
  if (t.includes("JUN")) return 6;
  if (t.includes("JUL")) return 7;
  if (t.includes("AUG") || t.includes("AGU")) return 8;
  if (t.includes("SEP")) return 9;
  if (t.includes("OCT") || t.includes("OKT")) return 10;
  if (t.includes("NOV")) return 11;
  if (t.includes("DEC") || t.includes("DES")) return 12;
  return null;
}

function normalizeCabinName(txt) {
  if (!txt) return null;
  const clean = txt
    .toString()
    .replace(/^\d+[\.\-\)]*/, "")
    .trim();
  if (!clean) return null;
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

function jsonOk(obj) {
  return new Response(JSON.stringify({ ok: true, ...obj }, null, 2), {
    headers: corsHeaders(),
  });
}

function jsonErr(error) {
  return new Response(JSON.stringify({ ok: false, error }, null, 2), {
    headers: corsHeaders(),
  });
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
