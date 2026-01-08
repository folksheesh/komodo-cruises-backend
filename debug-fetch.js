const GOOGLE_API_KEY = "AIzaSyCaBu5hbQiZQbt8wl10bJzM08jFVuGeSuI";
const SPREADSHEET_ID = "1FqMYrf_uVoL_lU2WuoFj_59rXPHttuAqDI_mxnVN42I";
const SHEET_NAME = "2026 OT (Normalized)";

async function run() {
  console.log("Testing fetch from pure Node.js...");
  const t0 = performance.now();
  const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}?includeGridData=true&ranges=${encodeURIComponent(
    SHEET_NAME
  )}&fields=sheets(data(rowData(values(formattedValue,userEnteredFormat.backgroundColor))))&key=${GOOGLE_API_KEY}`;

  try {
    const resp = await fetch(apiUrl);
    if (!resp.ok) throw new Error(await resp.text());
    console.log("Response Status:", resp.status);
    const text = await resp.text();
    console.log("Content Length:", text.length);
    console.log("Time:", (performance.now() - t0).toFixed(2), "ms");
  } catch (e) {
    console.error("Error:", e);
  }
}

run();
