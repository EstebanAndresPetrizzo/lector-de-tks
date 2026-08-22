const state = { records: [], stream: null, detector: null, zxingControls: null, active: false, seen: new Map(), selectedCameraId: "" };
const $ = (selector) => document.querySelector(selector);
const ui = {
  video: $("#video"), status: $("#scanStatus"), badge: $("#cameraBadge"), cameraEmpty: $("#cameraEmpty"), start: $("#startCamera"), stop: $("#stopCamera"), cameraSelect: $("#cameraSelect"), autoAdd: $("#autoAdd"), form: $("#expenseForm"), clear: $("#clearForm"), date: $("#date"), amount: $("#amount"), cuit: $("#cuit"), invoice: $("#invoice"), concept: $("#concept"), lastScan: $("#lastScan"), body: $("#recordsBody"), summary: $("#recordsSummary"), period: $("#period"), export: $("#exportXlsx")
};

function isoToday() { return new Date().toLocaleDateString("en-CA"); }
function currentMonth() { return new Date().toISOString().slice(0, 7); }
function setStatus(message) { ui.status.textContent = message; }
function beep() { try { const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.frequency.value = 940; gain.gain.setValueAtTime(.055, context.currentTime); oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .09); } catch {} }
function normalizeInvoice(pointOfSale, number) { return `${String(pointOfSale).padStart(4, "0")}${String(number).padStart(8, "0")}`; }

function decodeBase64(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function parseAfipQr(rawValue) {
  try {
    const url = new URL(rawValue);
    const payload = url.searchParams.get("p");
    if (!payload || !/afip\.gob\.ar$/i.test(url.hostname)) return null;
    const data = JSON.parse(decodeBase64(payload));
    if (!data.fecha || !data.cuit || data.importe === undefined || data.ptoVta === undefined || data.nroCmp === undefined) return null;
    return { date: data.fecha, amount: Number(data.importe), cuit: String(data.cuit), invoice: normalizeInvoice(data.ptoVta, data.nroCmp) };
  } catch { return null; }
}

function hasRecentValue(rawValue) { const previous = state.seen.get(rawValue); return previous && Date.now() - previous < 4500; }
function applyScan(rawValue) {
  if (hasRecentValue(rawValue)) return;
  state.seen.set(rawValue, Date.now());
  const expense = parseAfipQr(rawValue);
  if (!expense) { setStatus("Código leído, pero no es un QR fiscal de AFIP. Escaneá el QR del ticket."); ui.lastScan.textContent = "Código de producto detectado"; return; }
  ui.date.value = expense.date; ui.amount.value = expense.amount.toFixed(2); ui.cuit.value = expense.cuit; ui.invoice.value = expense.invoice;
  ui.lastScan.textContent = `Leído: ${expense.cuit} · ${expense.invoice}`; setStatus("QR fiscal leído correctamente."); beep();
  if (navigator.vibrate) navigator.vibrate(80);
  if (ui.autoAdd.checked) addRecord(expense);
}

async function scanWithNativeDetector() {
  try {
    if (!("BarcodeDetector" in window)) return false;
    const supported = await BarcodeDetector.getSupportedFormats();
    if (!supported.includes("qr_code")) return false;
    const usefulFormats = ["qr_code", "ean_13", "ean_8", "code_128", "code_39"].filter((format) => supported.includes(format));
    state.detector = new BarcodeDetector({ formats: usefulFormats });
    const scan = async () => {
      if (!state.active) return;
      try { const codes = await state.detector.detect(ui.video); codes.forEach((code) => applyScan(code.rawValue)); } catch {}
      window.setTimeout(scan, 120);
    };
    scan();
    return true;
  } catch { return false; }
}

async function scanWithZxing() {
  if (!window.ZXingBrowser?.BrowserMultiFormatReader) throw new Error("No se pudo cargar el lector de códigos QR.");
  state.zxingReader = new ZXingBrowser.BrowserMultiFormatReader();
  state.zxingControls = await state.zxingReader.decodeFromVideoElement(ui.video, (result) => {
    if (result) applyScan(result.getText());
  });
}

async function populateCameras() {
  const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  ui.cameraSelect.innerHTML = cameras.map((camera, index) => `<option value="${camera.deviceId}">${camera.label || `Cámara ${index + 1}`}</option>`).join("");
  if (!cameras.length) ui.cameraSelect.innerHTML = '<option value="">No se encontró una cámara</option>';
  const matchingCamera = cameras.some((camera) => camera.deviceId === state.selectedCameraId);
  state.selectedCameraId = matchingCamera ? state.selectedCameraId : (cameras[0]?.deviceId ?? "");
  ui.cameraSelect.value = state.selectedCameraId;
  ui.cameraSelect.disabled = cameras.length < 2;
}

async function enableContinuousFocus(track) {
  try {
    const capabilities = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
    if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
      return true;
    }
  } catch {}
  return false;
}

async function startCamera() {
  try {
    setStatus("Solicitando acceso a la webcam…");
    const videoConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, ...(state.selectedCameraId ? { deviceId: { exact: state.selectedCameraId } } : { facingMode: { ideal: "environment" } }) };
    state.stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    ui.video.srcObject = state.stream; await ui.video.play(); state.active = true;
    await populateCameras();
    const continuousFocus = await enableContinuousFocus(state.stream.getVideoTracks()[0]);
    ui.cameraEmpty.hidden = true; ui.start.disabled = true; ui.stop.disabled = false; ui.badge.textContent = "Escaneando"; ui.badge.classList.add("active");
    const focusMessage = continuousFocus ? "Foco continuo activado. " : "Esta cámara no informa autofoco; " ;
    if (await scanWithNativeDetector()) setStatus(`${focusMessage}apuntá al QR de AFIP.`);
    else { await scanWithZxing(); setStatus(`${focusMessage}apuntá al QR de AFIP.`); }
  } catch (error) { stopCamera(); setStatus(`No pude iniciar la cámara: ${error.message}`); }
}
function stopCamera() { state.active = false; state.zxingControls?.stop(); state.zxingControls = null; state.zxingReader?.reset(); state.zxingReader = null; state.stream?.getTracks().forEach((track) => track.stop()); state.stream = null; ui.video.srcObject = null; ui.cameraEmpty.hidden = false; ui.start.disabled = false; ui.stop.disabled = true; ui.badge.textContent = "Cámara apagada"; ui.badge.classList.remove("active"); }
function formRecord() { return { date: ui.date.value, amount: Number(ui.amount.value), cuit: ui.cuit.value.replace(/\D/g, ""), invoice: ui.invoice.value.replace(/\D/g, ""), concept: ui.concept.value.trim() }; }
function addRecord(prefilled, source = "manual") { const record = { ...formRecord(), ...prefilled, concept: prefilled?.concept ?? ui.concept.value.trim() }; if (!record.date || !Number.isFinite(record.amount) || record.amount < 0 || !/^\d{11}$/.test(record.cuit) || !record.invoice || !record.concept) { setStatus("Revisá los datos antes de agregar el gasto."); return false; } const duplicate = state.records.some((item) => item.cuit === record.cuit && item.invoice === record.invoice); if (duplicate) return false; state.records.unshift(record); renderRecords(); setStatus(source === "mobile" ? "Nuevo gasto recibido del celular." : "Gasto agregado. Podés seguir escaneando."); return true; }
function money(value) { return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(value); }
function renderRecords() { if (!state.records.length) { ui.body.innerHTML = '<tr class="empty-row"><td colspan="6">Todavía no hay gastos registrados.</td></tr>'; } else { ui.body.innerHTML = state.records.map((record, index) => `<tr><td>${record.date.split("-").reverse().join("/")}</td><td class="amount">${money(record.amount)}</td><td>${record.cuit}</td><td>${record.invoice}</td><td>${record.concept}</td><td class="actions"><button class="delete" data-index="${index}">Quitar</button></td></tr>`).join(""); } const total = state.records.reduce((sum, record) => sum + record.amount, 0); ui.summary.textContent = `${state.records.length} gasto${state.records.length === 1 ? "" : "s"} · ${money(total)}`; ui.export.disabled = !state.records.length; }
async function exportXlsx() { try { ui.export.disabled = true; ui.export.textContent = "Generando…"; const response = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records: state.records, period: ui.period.value }) }); if (!response.ok) { const body = await response.json(); throw new Error(body.error); } const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `Registro Deducciones ${ui.period.value || "gastos"}.xlsx`; link.click(); URL.revokeObjectURL(link.href); setStatus("Excel generado con el mismo formato de tu modelo."); } catch (error) { setStatus(`No pude generar el Excel: ${error.message}`); } finally { ui.export.disabled = !state.records.length; ui.export.textContent = "Descargar Excel"; } }
async function receiveMobileRecords() { try { const response = await fetch("/api/mobile-records"); if (!response.ok) return; const body = await response.json(); body.records.forEach((record) => addRecord(record, "mobile")); } catch {} }

ui.start.addEventListener("click", startCamera); ui.stop.addEventListener("click", stopCamera); ui.cameraSelect.addEventListener("change", async () => { state.selectedCameraId = ui.cameraSelect.value; if (state.active) { stopCamera(); await startCamera(); } }); ui.form.addEventListener("submit", (event) => { event.preventDefault(); addRecord(); }); ui.clear.addEventListener("click", () => { ui.form.reset(); ui.date.value = isoToday(); ui.concept.value = "GASTOS DE RESPRESENTACION"; }); ui.body.addEventListener("click", (event) => { const button = event.target.closest("[data-index]"); if (!button) return; state.records.splice(Number(button.dataset.index), 1); renderRecords(); }); ui.export.addEventListener("click", exportXlsx); window.addEventListener("beforeunload", stopCamera);
ui.date.value = isoToday(); ui.period.value = currentMonth(); renderRecords(); receiveMobileRecords(); window.setInterval(receiveMobileRecords, 1500);
