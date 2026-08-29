const state = { records: [], filter: "all", uploading: false };
const $ = (selector) => document.querySelector(selector);
const ui = {
  app: $("#app"), pinPanel: $("#pinPanel"), pinForm: $("#pinForm"), pinInput: $("#pinInput"),
  ocrBadge: $("#ocrBadge"), defaultConcept: $("#defaultConcept"), fileInput: $("#fileInput"),
  folderInput: $("#folderInput"), cameraInput: $("#cameraInput"), dropZone: $("#dropZone"),
  progressPanel: $("#progressPanel"), progressText: $("#progressText"), progressCount: $("#progressCount"),
  progressBar: $("#progressBar"), uploadMessage: $("#uploadMessage"), recordCount: $("#recordCount"),
  readyCount: $("#readyCount"), reviewCount: $("#reviewCount"), totalAmount: $("#totalAmount"),
  recordsBody: $("#recordsBody"), emptyState: $("#emptyState"), period: $("#period"),
  exportButton: $("#exportButton"), clearAll: $("#clearAll"), addressList: $("#addressList")
};

function initialPin() {
  const queryPin = new URL(location.href).searchParams.get("pin");
  if (queryPin) localStorage.setItem("lector-tks-pin", queryPin);
  return queryPin || localStorage.getItem("lector-tks-pin") || "";
}

let accessPin = initialPin();

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}), "X-Access-Pin": accessPin };
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) throw new Error("PIN_INVALID");
  if (!response.ok) {
    let message = "No se pudo completar la operación.";
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response;
}

function money(value) {
  return new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(Number(value || 0));
}

function currentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function recordIsComplete(record) {
  return /^\d{4}-\d{2}-\d{2}$/.test(record.date) && Number(record.amount) > 0 && /^\d{11}$/.test(record.cuit) && /^\d{9,20}$/.test(record.invoice) && record.concept.trim();
}

function fieldClass(record, field) {
  if (field === "date") return /^\d{4}-\d{2}-\d{2}$/.test(record.date) ? "" : "needs-review";
  if (field === "amount") return Number(record.amount) > 0 ? "" : "needs-review";
  if (field === "cuit") return /^\d{11}$/.test(record.cuit) ? "" : "needs-review";
  if (field === "invoice") return /^\d{9,20}$/.test(record.invoice) ? "" : "needs-review";
  if (field === "concept") return record.concept.trim() ? "" : "needs-review";
  return "";
}

function render() {
  const ready = state.records.filter(recordIsComplete);
  const review = state.records.filter((record) => !recordIsComplete(record));
  ui.recordCount.textContent = state.records.length;
  ui.readyCount.textContent = ready.length;
  ui.reviewCount.textContent = review.length;
  ui.totalAmount.textContent = money(state.records.reduce((sum, record) => sum + Number(record.amount || 0), 0));
  ui.exportButton.disabled = !state.records.length || review.length > 0 || state.uploading;

  const visible = state.records.filter((record) => state.filter === "all" || (state.filter === "ready" ? recordIsComplete(record) : !recordIsComplete(record)));
  ui.emptyState.hidden = visible.length > 0;
  ui.emptyState.textContent = state.records.length ? "No hay comprobantes en este filtro." : "Todavía no cargaste comprobantes.";
  ui.recordsBody.innerHTML = visible.map((record) => {
    const complete = recordIsComplete(record);
    const origin = `${record.source_file}${record.page_number > 1 ? ` · pág. ${record.page_number}` : ""}`;
    const warningTitle = record.warnings?.join(" ") || (complete ? "Datos completos" : "Revisar campos marcados");
    return `<tr data-id="${record.id}">
      <td><span class="status ${complete ? "ready" : "review"}" title="${escapeHtml(warningTitle)}">${complete ? "Listo" : "Revisar"}</span></td>
      <td><input class="cell-input ${fieldClass(record, "date")}" data-field="date" type="date" value="${escapeHtml(record.date)}" /></td>
      <td><input class="cell-input amount-input ${fieldClass(record, "amount")}" data-field="amount" inputmode="decimal" value="${record.amount ?? ""}" /></td>
      <td><input class="cell-input code-input ${fieldClass(record, "cuit")}" data-field="cuit" inputmode="numeric" maxlength="11" value="${escapeHtml(record.cuit)}" /></td>
      <td><input class="cell-input code-input ${fieldClass(record, "invoice")}" data-field="invoice" inputmode="numeric" maxlength="20" value="${escapeHtml(record.invoice)}" /></td>
      <td><input class="cell-input concept-input ${fieldClass(record, "concept")}" data-field="concept" list="concepts" value="${escapeHtml(record.concept)}" /></td>
      <td class="source" title="${escapeHtml(origin)}"><span>${escapeHtml(origin)}</span><small>${record.extraction_method === "qr" ? "QR fiscal" : "OCR"} · ${record.confidence}%</small></td>
      <td class="row-actions"><button class="save-row" type="button">Guardar</button><button class="delete-row" type="button" aria-label="Eliminar">×</button></td>
    </tr>`;
  }).join("");
}

async function loadRecords() {
  const response = await api("/api/records");
  state.records = (await response.json()).records;
  render();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`No pude leer ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

function acceptedFile(file) {
  return file.type.startsWith("image/") || file.type === "application/pdf" || /\.(jpe?g|jfif|png|webp|bmp|tiff?|pdf)$/i.test(file.name);
}

async function uploadFiles(fileList) {
  if (state.uploading) return;
  const files = [...fileList].filter(acceptedFile);
  if (!files.length) {
    ui.uploadMessage.textContent = "No encontré imágenes o PDF compatibles.";
    ui.uploadMessage.className = "message error";
    return;
  }
  state.uploading = true;
  ui.progressPanel.hidden = false;
  ui.uploadMessage.textContent = "";
  render();
  let created = 0; let duplicates = 0; const errors = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    ui.progressText.textContent = `Procesando ${file.name}`;
    ui.progressCount.textContent = `${index + 1} / ${files.length}`;
    ui.progressBar.style.width = `${Math.round(index * 100 / files.length)}%`;
    try {
      const data = await fileToDataUrl(file);
      const response = await api("/api/upload", { method: "POST", body: JSON.stringify({ name: file.name, data, default_concept: ui.defaultConcept.value }) });
      const payload = await response.json();
      created += payload.created.length;
      duplicates += payload.duplicates.length;
    } catch (error) {
      if (error.message === "PIN_INVALID") { showPin(); break; }
      errors.push(`${file.name}: ${error.message}`);
    }
  }
  ui.progressBar.style.width = "100%";
  ui.progressText.textContent = "Proceso terminado";
  state.uploading = false;
  await loadRecords();
  const parts = [`${created} registro${created === 1 ? "" : "s"} agregado${created === 1 ? "" : "s"}`];
  if (duplicates) parts.push(`${duplicates} duplicado${duplicates === 1 ? "" : "s"} omitido${duplicates === 1 ? "" : "s"}`);
  if (errors.length) parts.push(`${errors.length} archivo${errors.length === 1 ? "" : "s"} con error`);
  ui.uploadMessage.textContent = `${parts.join(" · ")}${errors.length ? `. ${errors.join(" | ")}` : "."}`;
  ui.uploadMessage.className = `message ${errors.length ? "error" : "success"}`;
  [ui.fileInput, ui.folderInput, ui.cameraInput].forEach((input) => { input.value = ""; });
}

async function saveRow(row) {
  const id = Number(row.dataset.id);
  const payload = {};
  row.querySelectorAll("[data-field]").forEach((input) => { payload[input.dataset.field] = input.value.trim(); });
  payload.amount = Number(String(payload.amount).replace(",", "."));
  payload.cuit = payload.cuit.replace(/\D/g, "");
  payload.invoice = payload.invoice.replace(/\D/g, "");
  payload.learn_concept = true;
  const button = row.querySelector(".save-row");
  button.disabled = true; button.textContent = "Guardando…";
  try {
    const response = await api(`/api/records/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
    const updated = (await response.json()).record;
    state.records = state.records.map((record) => record.id === id ? updated : record);
    render();
  } catch (error) {
    alert(error.message);
    button.disabled = false; button.textContent = "Guardar";
  }
}

async function deleteRow(row) {
  if (!confirm("¿Eliminar este comprobante de la lista?")) return;
  const id = Number(row.dataset.id);
  await api(`/api/records/${id}`, { method: "DELETE" });
  state.records = state.records.filter((record) => record.id !== id);
  render();
}

async function exportExcel() {
  try {
    ui.exportButton.disabled = true; ui.exportButton.textContent = "Generando…";
    const response = await api("/api/export", { method: "POST", body: JSON.stringify({ period: ui.period.value }) });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `Registro Deducciones ${ui.period.value || "registro"}.xlsx`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    alert(error.message);
  } finally {
    ui.exportButton.textContent = "Descargar Excel"; render();
  }
}

async function clearAll() {
  if (!state.records.length || !confirm("¿Vaciar toda la lista? El Excel que ya hayas descargado no se borrará.")) return;
  await api("/api/records/clear", { method: "POST", body: "{}" });
  state.records = []; render();
}

function showPin() {
  ui.app.hidden = true; ui.pinPanel.hidden = false; ui.pinInput.focus();
}

async function initialize() {
  if (!accessPin) { showPin(); return; }
  try {
    const info = await (await api("/api/info")).json();
    ui.ocrBadge.textContent = info.ocr_available ? "OCR disponible" : "OCR no instalado";
    ui.ocrBadge.className = `badge ${info.ocr_available ? "success" : "warning"}`;
    ui.addressList.innerHTML = info.addresses.length ? info.addresses.map((address) => `<button type="button" data-copy="${escapeHtml(address)}">${escapeHtml(address)}</button>`).join("") : "<span>No pude detectar una dirección de red.</span>";
    ui.pinPanel.hidden = true; ui.app.hidden = false;
    await loadRecords();
  } catch (error) {
    if (error.message === "PIN_INVALID") showPin(); else alert(error.message);
  }
}

ui.period.value = currentPeriod();
ui.pinForm.addEventListener("submit", (event) => { event.preventDefault(); accessPin = ui.pinInput.value; localStorage.setItem("lector-tks-pin", accessPin); initialize(); });
[ui.fileInput, ui.folderInput, ui.cameraInput].forEach((input) => input.addEventListener("change", () => uploadFiles(input.files)));
ui.dropZone.addEventListener("dragover", (event) => { event.preventDefault(); ui.dropZone.classList.add("dragging"); });
ui.dropZone.addEventListener("dragleave", () => ui.dropZone.classList.remove("dragging"));
ui.dropZone.addEventListener("drop", (event) => { event.preventDefault(); ui.dropZone.classList.remove("dragging"); uploadFiles(event.dataTransfer.files); });
document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.filter = button.dataset.filter; render(); }));
ui.recordsBody.addEventListener("click", (event) => { const row = event.target.closest("tr"); if (!row) return; if (event.target.closest(".save-row")) saveRow(row); if (event.target.closest(".delete-row")) deleteRow(row); });
ui.exportButton.addEventListener("click", exportExcel);
ui.clearAll.addEventListener("click", clearAll);
ui.addressList.addEventListener("click", async (event) => { const button = event.target.closest("[data-copy]"); if (!button) return; await navigator.clipboard.writeText(button.dataset.copy); const previous = button.textContent; button.textContent = "Copiado"; setTimeout(() => { button.textContent = previous; }, 1200); });
initialize();
