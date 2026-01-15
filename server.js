import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// CORS middleware
app.use(cors());

/**
 * KONFIGURASI
 */
const GOOGLE_API_KEY =
  process.env.GOOGLE_API_KEY || "AIzaSyCaBu5hbQiZQbt8wl10bJzM08jFVuGeSuI";
const SPREADSHEET_ID = "1FqMYrf_uVoL_lU2WuoFj_59rXPHttuAqDI_mxnVN42I";
const SHEET_NAME = "2026 OT (Normalized)";
const CABIN_DETAIL_SHEET = "Cabin Detail";

const OT2026 = [
  "SEMESTA VOYAGES",
  "AKASSA CRUISE",
  "DERYA LIVEABOARD",
  "GIONA LIVEABOARD",
];

// Main route handler
app.get("/", async (req, res) => {
  try {
    const resource = (req.query.resource || "").toLowerCase();
    const date = req.query.date;
    const cabinName = req.query.name;
    const guests = parseInt(req.query.guests || "1", 10);

    // === API: Cabin Detail ===
    if (resource === "cabindetail") {
      const details = await loadCabinDetailCached();

      if (cabinName) {
        const found = details.find(
          (c) => c.cabin_name?.toUpperCase() === cabinName.toUpperCase()
        );
        if (!found)
          return res.json({
            ok: false,
            error: `Cabin '${cabinName}' not found`,
          });
        return res.json({ ok: true, data: found });
      }
      return res.json({ ok: true, total: details.length, data: details });
    }

    // === API: Operators ===
    if (resource === "operators") {
      return res.json({
        ok: true,
        total: OT2026.length,
        operators: OT2026.map((x) => ({
          operator: x,
          sourceSheet: `${x} (Normalized)`,
        })),
      });
    }

    // === Fetch Main Data (Normalized) ===
    const sheetData = await loadSheetDataCached(SHEET_NAME);

    // === API: Cabins List ===
    if (resource === "cabins") {
      const allCabins = listCabinsAll(sheetData);
      return res.json({ ok: true, cabins: allCabins });
    }

    // Validasi Date untuk Availability
    if (!date)
      return res.json({ ok: false, error: "Missing ?date=YYYY-MM-DD" });

    // Proses Logika Utama
    const result = summarizeOT2026ByDate(sheetData, date);

    if (resource === "availability") {
      return res.json({ ok: true, date, ...result });
    }

    if (resource === "search") {
      if (!cabinName)
        return res.json({ ok: false, error: "Missing ?name=cabinName" });

      const cabinNorm = normalizeCabinName(cabinName);
      const matches = [];

      result.operators.forEach((op) => {
        const found = op.cabins.find(
          (c) => c.name.toUpperCase() === cabinNorm.toUpperCase()
        );
        if (found && found.available >= guests) {
          matches.push({ operator: op.operator, available: found.available });
        }
      });

      return res.json({ ok: true, date, cabin: cabinNorm, guests, matches });
    }

    return res.json({ ok: false, error: "Unknown resource" });
  } catch (err) {
    console.error(err);
    return res.json({ ok: false, error: err.message });
  }
});

/* =======================================================================
 * CACHING SYSTEM
 * =======================================================================*/
const cache = {
  sheetData: null,
  sheetDataTimestamp: 0,
  cabinDetail: null,
  cabinDetailTimestamp: 0,
};

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

function isCacheValid(timestamp) {
  return Date.now() - timestamp < CACHE_TTL;
}

/* =======================================================================
 * DATA FETCHING LAYERS
 * =======================================================================*/

async function loadSheetDataCached(sheetName) {
  // Return cached data if valid
  if (cache.sheetData && isCacheValid(cache.sheetDataTimestamp)) {
    console.log("Using cached sheet data");
    return cache.sheetData;
  }

  console.log("Fetching fresh sheet data from Google Sheets...");
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

  const rows = json.sheets[0].data[0].rowData || [];
  const values = [];
  const backgrounds = [];

  rows.forEach((row) => {
    const valRow = [];
    const bgRow = [];
    if (row.values) {
      row.values.forEach((cell) => {
        valRow.push(cell.formattedValue || "");
        const color = cell.userEnteredFormat?.backgroundColor || {};
        const isWhite =
          (!color.red && !color.green && !color.blue) ||
          (color.red === 1 && color.green === 1 && color.blue === 1);
        bgRow.push(isWhite ? "#ffffff" : "#colored");
      });
    }
    values.push(valRow);
    backgrounds.push(bgRow);
  });

  // Store in cache
  const data = { values, backgrounds };
  cache.sheetData = data;
  cache.sheetDataTimestamp = Date.now();
  console.log("Sheet data cached successfully");

  return data;
}

async function loadCabinDetailCached() {
  // Return cached data if valid
  if (cache.cabinDetail && isCacheValid(cache.cabinDetailTimestamp)) {
    console.log("Using cached cabin detail data");
    return cache.cabinDetail;
  }

  console.log("Fetching fresh cabin detail from Google Sheets...");
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
  const list = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const obj = {};
    headers.forEach((h, idx) => {
      const v = (row[idx] || "").toString().trim();
      if (h && v !== "") obj[h] = v;
    });

    if (!obj["name cabin"]) continue;

    const api_name = (obj["name cabin api"] || "").toUpperCase().trim();
    const cabin_name = obj["name cabin"].trim();
    const operator = obj["name boat"] || "Unknown";
    const description = obj["description"] || "";

    const baseCap = Number(obj["base capacity"] || 0);
    const extraCap = Number(obj["extra pax capacity"] || 0);
    let capacity = baseCap + extraCap;
    if (!capacity)
      capacity = Number(obj["total capacity"] || obj["capacity"] || 0);

    const priceRaw = obj["price"] || obj["komodo cruises-pricing"] || "";
    const price =
      Number((priceRaw || "").toString().replace(/[^\d]/g, "")) || 0;
    const trip_days = Number(obj["trip (days)"] || obj["days"] || 0);

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

  // Store in cache
  cache.cabinDetail = list;
  cache.cabinDetailTimestamp = Date.now();
  console.log("Cabin detail cached successfully");

  return list;
}

/* =======================================================================
 * LOGIC CORE
 * =======================================================================*/

function listCabinsAll(sheetData) {
  const out = new Set();
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
  const cols = rows > 0 ? values[0].length : 0;

  const shipByRow = Array(rows).fill(null);
  let currentShip = null;

  for (let r = 0; r < rows; r++) {
    const cellA = (values[r][0] || "").trim().toUpperCase();
    const cellB = (values[r][1] || "").trim().toUpperCase();
    const found = OT2026.find((s) => cellA === s || cellB === s);
    if (found) currentShip = found;
    shipByRow[r] = currentShip;
  }

  const perShip = {};
  OT2026.forEach((s) => (perShip[s] = {}));

  for (let r = 0; r < rows - 1; r++) {
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

  const operators = [];
  let total = 0;

  OT2026.forEach((op) => {
    const map = perShip[op] || {};
    const cabins = Object.keys(map)
      .sort()
      .map((raw) => ({
        name: raw,
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
