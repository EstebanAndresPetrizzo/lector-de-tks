import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createWorker } from "tesseract.js";
import { createRequire } from "node:module";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const publicDir = path.join(appDir, "public");
const templatePath = path.resolve(appDir, "..", "Registro Deducciones Diciembre 2025.xlsx");
const exporterPath = path.join(appDir, "export_excel.py");
const exportsDir = path.join(appDir, "exports");
const pythonExecutable = "C:\\Users\\Esteban Andres\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? "0.0.0.0";
const mobileRecords = [];
const mobileRecordKeys = new Set();
let ocrWorkerPromise;
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(response, status, body, headers = {}) {
  response.writeHead(status, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", ...headers });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 15_000_000) throw new Error("La solicitud es demasiado grande.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cleanRecord(record) {
  const date = String(record.date ?? "");
  const cuit = String(record.cuit ?? "").replace(/\D/g, "");
  const invoice = String(record.invoice ?? "").replace(/\D/g, "");
  const amount = Number(record.amount);
  const concept = String(record.concept ?? "").trim().slice(0, 100);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Cada gasto debe tener una fecha válida.");
  if (!/^\d{11}$/.test(cuit)) throw new Error("Cada CUIT debe tener 11 dígitos.");
  if (!invoice || invoice.length > 20) throw new Error("Cada número de factura debe tener entre 1 y 20 dígitos.");
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Cada importe debe ser válido.");
  if (!concept) throw new Error("Indicá el concepto de cada gasto.");

  return { date, cuit, invoice, amount, concept };
}

function parseOcrText(text) {
  const normalized = text.replace(/\r/g, "").replace(/[|]/g, "1");
  const dateMatch = normalized.match(/\b(\d{2})[\/-](\d{2})[\/-](\d{4})\b|\b(\d{4})[\/-](\d{2})[\/-](\d{2})\b/);
  const cuitMatch = normalized.match(/(?:cuit|c\.u\.i\.t\.?)\s*[:\-]?\s*(\d[\d\s\-.]{9,16}\d)/i);
  const amountMatch = normalized.match(/(?:total|importe|monto)\s*[:\-]?\s*\$?\s*([\d.]+(?:,\d{1,2})?)/i);
  const invoiceMatch = normalized.match(/(?:n[roº°.]?|comprobante|factura)\s*[:\-]?\s*(\d{1,5})\s*[-/]\s*(\d{1,8})/i);
  const draft = {};
  if (dateMatch) draft.date = dateMatch[4] ? `${dateMatch[4]}-${dateMatch[5]}-${dateMatch[6]}` : `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
  if (cuitMatch) draft.cuit = cuitMatch[1].replace(/\D/g, "").slice(0, 11);
  if (amountMatch) draft.amount = amountMatch[1];
  if (invoiceMatch) {
    draft.pointOfSale = invoiceMatch[1].replace(/\D/g, "");
    draft.receiptNumber = invoiceMatch[2].replace(/\D/g, "");
  }
  return draft;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    const langPath = require("@tesseract.js-data/spa").langPath;
    ocrWorkerPromise = createWorker("spa", 1, { langPath });
  }
  return ocrWorkerPromise;
}

async function recognizeTicket(image) {
  if (typeof image !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(image)) throw new Error("La foto no tiene un formato válido.");
  const worker = await getOcrWorker();
  const result = await worker.recognize(Buffer.from(image, "base64"));
  return parseOcrText(result.data.text);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { windowsHide: true });
    let stderr = "";
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.on("error", reject);
    process.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || "No se pudo generar el Excel.")));
  });
}

async function createWorkbook(records) {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "lector-tks-"));
  const dataPath = path.join(temporaryDir, "gastos.json");
  const outputPath = path.join(temporaryDir, "Registro Deducciones.xlsx");
  try {
    await fs.writeFile(dataPath, JSON.stringify(records), "utf8");
    await run(pythonExecutable, [exporterPath, templatePath, dataPath, outputPath]);
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

function localAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((network) => network && network.family === "IPv4" && !network.internal).map((network) => network.address);
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(publicDir, relative);
  if (!target.startsWith(`${publicDir}${path.sep}`)) return send(response, 403, "No autorizado");
  try {
    const content = await fs.readFile(target);
    send(response, 200, content, { "Content-Type": mimeTypes[path.extname(target)] ?? "application/octet-stream" });
  } catch {
    send(response, 404, "No encontrado");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "OPTIONS") return send(response, 204, "");

    if (request.method === "GET" && url.pathname === "/api/mobile-records") {
      return send(response, 200, JSON.stringify({ records: mobileRecords }), { "Content-Type": "application/json; charset=utf-8" });
    }

    if (request.method === "POST" && url.pathname === "/api/mobile-record") {
      const body = await readJson(request);
      const record = cleanRecord(body);
      const key = `${record.cuit}-${record.invoice}`;
      if (mobileRecordKeys.has(key)) return send(response, 409, JSON.stringify({ error: "Ese comprobante ya fue recibido en la PC." }), { "Content-Type": "application/json; charset=utf-8" });
      mobileRecordKeys.add(key);
      mobileRecords.unshift({ ...record, receivedAt: new Date().toISOString() });
      return send(response, 201, JSON.stringify({ message: "Gasto recibido en la PC." }), { "Content-Type": "application/json; charset=utf-8" });
    }

    if (request.method === "POST" && url.pathname === "/api/ocr") {
      const body = await readJson(request);
      const draft = await recognizeTicket(body.image);
      return send(response, 200, JSON.stringify({ draft }), { "Content-Type": "application/json; charset=utf-8" });
    }

    if (request.method === "POST" && url.pathname === "/api/export") {
      const body = await readJson(request);
      if (!Array.isArray(body.records) || body.records.length === 0) throw new Error("Todavía no hay gastos para exportar.");
      if (body.records.length > 1000) throw new Error("Podés exportar hasta 1000 gastos por vez.");
      const records = body.records.map(cleanRecord);
      const workbook = await createWorkbook(records);
      const period = /^\d{4}-\d{2}$/.test(String(body.period)) ? body.period : "gastos";
      return send(response, 200, workbook, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Registro Deducciones ${period}.xlsx"`,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/mobile-export") {
      const body = await readJson(request);
      if (!Array.isArray(body.records) || body.records.length === 0) throw new Error("Todavía no hay gastos para exportar.");
      if (body.records.length > 1000) throw new Error("Podés exportar hasta 1000 gastos por vez.");
      const records = body.records.map(cleanRecord);
      const workbook = await createWorkbook(records);
      const period = /^\d{4}-\d{2}$/.test(String(body.period)) ? body.period : "gastos";
      await fs.mkdir(exportsDir, { recursive: true });
      const fileName = `Registro Deducciones ${period}.xlsx`;
      await fs.writeFile(path.join(exportsDir, fileName), workbook);
      return send(response, 200, JSON.stringify({ fileName, message: "Excel generado en la PC." }), { "Content-Type": "application/json; charset=utf-8" });
    }

    if (request.method === "GET") return serveStatic(request, response, url.pathname);
    send(response, 405, "Método no permitido");
  } catch (error) {
    send(response, 400, JSON.stringify({ error: error instanceof Error ? error.message : "No se pudo completar la operación." }), {
      "Content-Type": "application/json; charset=utf-8",
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`El lector ya está abierto en http://localhost:${port}`);
    process.exit(0);
  }
  console.error(error);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Lector de tickets listo en http://localhost:${port}`);
  localAddresses().forEach((address) => console.log(`Celular en la misma red: http://${address}:${port}`));
});
