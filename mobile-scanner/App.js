import { CameraView, useCameraPermissions } from "expo-camera";
import { useMemo, useRef, useState } from "react";
import { Alert, Image, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

const DEFAULT_CONCEPT = "GASTOS DE RESPRESENTACION";
const ELECTRONIC_QR_HOSTS = new Set(["afip.gob.ar", "www.afip.gob.ar", "arca.gob.ar", "www.arca.gob.ar"]);

function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function emptyDraft() {
  return { date: todayIso(), amount: "", cuit: "", pointOfSale: "", receiptNumber: "" };
}

function onlyDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function decodeBase64(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const normalized = value.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  let bits = 0; let bitCount = 0; let output = "";
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) continue;
    bits = (bits << 6) | index;
    bitCount += 6;
    if (bitCount >= 8) { bitCount -= 8; output += String.fromCharCode((bits >> bitCount) & 255); }
  }
  return output;
}

function normalizedQrPath(url) {
  return url.pathname.replace(/\/+$/, "").toLowerCase();
}

function parseElectronicQr(url) {
  const payload = url.searchParams.get("p");
  if (!payload) return null;

  try {
    const data = JSON.parse(decodeBase64(payload));
    const draft = {
      date: String(data.fecha ?? ""),
      amount: String(data.importe ?? ""),
      cuit: onlyDigits(data.cuit),
      pointOfSale: onlyDigits(data.ptoVta),
      receiptNumber: onlyDigits(data.nroCmp),
    };
    const amount = Number(draft.amount);
    if (!isValidIsoDate(draft.date)) return null;
    if (!/^\d{11}$/.test(draft.cuit)) return null;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!/^\d{1,5}$/.test(draft.pointOfSale) || Number(draft.pointOfSale) <= 0) return null;
    if (!/^\d{1,8}$/.test(draft.receiptNumber) || Number(draft.receiptNumber) <= 0) return null;
    return draft;
  } catch {
    return null;
  }
}

function identifyFiscalQr(rawValue) {
  try {
    const url = new URL(rawValue.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "unknown" };

    const hostname = url.hostname.toLowerCase();
    if (ELECTRONIC_QR_HOSTS.has(hostname) && normalizedQrPath(url) === "/fe/qr" && url.searchParams.has("p")) {
      const draft = parseElectronicQr(url);
      return draft ? { kind: "electronic", draft } : { kind: "invalid-electronic" };
    }

    const dataFiscalToken = url.searchParams.get("qr")?.trim() ?? "";
    if (
      hostname === "qr.afip.gob.ar"
      && normalizedQrPath(url) === ""
      && /^[A-Za-z0-9_-]{22}(?:,,)?$/.test(dataFiscalToken)
    ) {
      return { kind: "data-fiscal" };
    }

    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

function parseAmount(value) {
  const raw = String(value ?? "").trim();
  let normalized;

  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(raw)) {
    normalized = raw.replace(/\./g, "").replace(",", ".");
  } else if (/^\d+(?:,\d{1,2})?$/.test(raw)) {
    normalized = raw.replace(",", ".");
  } else if (/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    normalized = raw;
  } else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(raw)) {
    normalized = raw.replace(/,/g, "");
  } else {
    return null;
  }

  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function normalizeInvoice(pointOfSale, receiptNumber) {
  const point = String(Number(pointOfSale));
  const number = String(Number(receiptNumber));
  return `${point.padStart(5, "0")}${number.padStart(8, "0")}`;
}

function expenseFromDraft(draft, concept) {
  const date = draft.date.trim();
  const cuit = onlyDigits(draft.cuit);
  const pointOfSale = onlyDigits(draft.pointOfSale);
  const receiptNumber = onlyDigits(draft.receiptNumber);
  const amount = parseAmount(draft.amount);
  const cleanConcept = concept.trim();

  if (!isValidIsoDate(date)) return { error: "Ingresá la fecha con el formato AAAA-MM-DD." };
  if (amount === null) return { error: "Ingresá un importe mayor que cero, con hasta dos decimales." };
  if (!/^\d{11}$/.test(cuit)) return { error: "El CUIT debe tener exactamente 11 dígitos." };
  if (!/^\d{1,5}$/.test(pointOfSale) || Number(pointOfSale) <= 0) return { error: "El punto de venta debe tener entre 1 y 5 dígitos." };
  if (!/^\d{1,8}$/.test(receiptNumber) || Number(receiptNumber) <= 0) return { error: "El número de comprobante debe tener entre 1 y 8 dígitos." };
  if (!cleanConcept) return { error: "Indicá el concepto del gasto." };

  return {
    expense: {
      date,
      amount,
      cuit,
      invoice: normalizeInvoice(pointOfSale, receiptNumber),
      concept: cleanConcept,
    },
  };
}

export default function App() {
  const cameraRef = useRef(null);
  const scanLockRef = useRef(false);
  const captureAttemptRef = useRef(0);
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState("qr");
  const [scanLocked, setScanLocked] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [photoUri, setPhotoUri] = useState(null);
  const [photoExpanded, setPhotoExpanded] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [draftSource, setDraftSource] = useState(null);
  const [concept, setConcept] = useState(DEFAULT_CONCEPT);
  const [records, setRecords] = useState([]);
  const [serverUrl, setServerUrl] = useState("http://192.168.100.207:4173");
  const [sending, setSending] = useState(false);
  const total = useMemo(() => records.reduce((sum, record) => sum + record.amount, 0), [records]);
  const hasPending = records.some((record) => !record.sent);

  function resetToQr() {
    scanLockRef.current = false;
    captureAttemptRef.current += 1;
    setStage("qr");
    setScanLocked(false);
    setCameraReady(false);
    setCapturing(false);
    setPhotoUri(null);
    setPhotoExpanded(false);
    setDraft(emptyDraft());
    setDraftSource(null);
  }

  function startManualCapture(source = "manual") {
    captureAttemptRef.current += 1;
    setDraft(emptyDraft());
    setDraftSource(source);
    setPhotoUri(null);
    setPhotoExpanded(false);
    setCameraReady(false);
    setStage("photo");
  }

  function startManualWithoutPhoto(source = "manual") {
    captureAttemptRef.current += 1;
    setDraft(emptyDraft());
    setDraftSource(source);
    setPhotoUri(null);
    setPhotoExpanded(false);
    setStage("edit");
  }

  function continueWithoutCamera() {
    if (stage === "photo" && draftSource) {
      captureAttemptRef.current += 1;
      setCapturing(false);
      setStage("edit");
      return;
    }
    startManualWithoutPhoto("manual");
  }

  function photographCurrentDraft() {
    captureAttemptRef.current += 1;
    setCameraReady(false);
    setPhotoExpanded(false);
    setStage("photo");
  }

  function finishWithoutPhoto() {
    captureAttemptRef.current += 1;
    setCapturing(false);
    setStage("edit");
  }

  function cancelDraft() {
    const hasEnteredData = Boolean(
      photoUri
      || draft.amount
      || draft.cuit
      || draft.pointOfSale
      || draft.receiptNumber
      || draft.date !== todayIso()
    );
    if (!hasEnteredData) {
      resetToQr();
      return;
    }
    Alert.alert(
      "¿Descartar esta carga?",
      "La foto y los datos que todavía no agregaste se perderán.",
      [
        { text: "Seguir editando", style: "cancel" },
        { text: "Descartar", style: "destructive", onPress: resetToQr },
      ],
    );
  }

  function handleScan({ data }) {
    if (scanLockRef.current) return;
    scanLockRef.current = true;
    setScanLocked(true);
    const result = identifyFiscalQr(data);

    if (result.kind === "electronic") {
      setDraft(result.draft);
      setDraftSource("electronic");
      setPhotoUri(null);
      setStage("edit");
      return;
    }

    if (result.kind === "data-fiscal") {
      Alert.alert(
        "QR fiscal reconocido",
        "Este QR identifica al comercio, pero no contiene la fecha, el importe ni el número del ticket. Fotografialo para cargar esos datos.",
        [
          { text: "Escanear otro", style: "cancel", onPress: () => { scanLockRef.current = false; setScanLocked(false); } },
          { text: "Fotografiar ticket", onPress: () => startManualCapture("data-fiscal") },
        ],
        { cancelable: false },
      );
      return;
    }

    const message = result.kind === "invalid-electronic"
      ? "El QR parece fiscal, pero sus datos están incompletos o dañados. Podés cargar el ticket manualmente."
      : "Este QR no contiene datos de un comprobante electrónico reconocido. Podés reintentar o cargar el ticket manualmente.";
    Alert.alert(
      "No pude extraer el comprobante",
      message,
      [
        { text: "Reintentar", style: "cancel", onPress: () => { scanLockRef.current = false; setScanLocked(false); } },
        { text: "Cargar ticket", onPress: () => startManualCapture("manual") },
      ],
      { cancelable: false },
    );
  }

  async function captureTicket() {
    if (!cameraRef.current || !cameraReady || capturing) return;
    const captureAttempt = captureAttemptRef.current + 1;
    captureAttemptRef.current = captureAttempt;
    try {
      setCapturing(true);
      const picture = await cameraRef.current.takePictureAsync({ quality: 0.85, base64: true, exif: false });
      if (captureAttempt !== captureAttemptRef.current) return;
      if (!picture?.uri) throw new Error("La cámara no devolvió una imagen.");
      setPhotoUri(picture.uri);
      setPhotoExpanded(false);
      setStage("edit");
      if (picture.base64) await extractTicketData(picture.base64, captureAttempt);
    } catch (error) {
      if (captureAttempt !== captureAttemptRef.current) return;
      Alert.alert("No pude fotografiar el ticket", error.message);
    } finally {
      if (captureAttempt === captureAttemptRef.current) setCapturing(false);
    }
  }

  async function extractTicketData(base64, captureAttempt) {
    setDraftSource("ocr");
    try {
      const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64 }),
      });
      const payload = await response.json();
      if (captureAttempt !== captureAttemptRef.current) return;
      if (!response.ok) throw new Error(payload.error || "No se pudo analizar la foto.");
      setDraft((previous) => ({ ...previous, ...payload.draft }));
      setDraftSource("ocr");
    } catch (error) {
      if (captureAttempt !== captureAttemptRef.current) return;
      setDraftSource("ocr-failed");
      Alert.alert("No pude leer todos los datos", `${error.message}\nPodés completar o corregir los campos mirando la foto.`);
    }
  }

  function updateDraft(field, value) {
    setDraft((previous) => ({ ...previous, [field]: value }));
  }

  function confirmRemoveRecord(item) {
    Alert.alert(
      "¿Quitar este gasto?",
      item.sent
        ? "Se quitará de la lista del celular, pero seguirá cargado en la PC."
        : "Este gasto pendiente se eliminará y no podrá recuperarse.",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Quitar",
          style: "destructive",
          onPress: () => setRecords((previous) => previous.filter((record) => (
            record.cuit !== item.cuit || record.invoice !== item.invoice
          ))),
        },
      ],
    );
  }

  async function sendRecordToPc(item) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/mobile-record`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok && response.status !== 409) throw new Error(payload.error || "No se pudo enviar el gasto.");
    } catch (error) {
      if (error.name === "AbortError") throw new Error("La PC no respondió dentro de 8 segundos.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function addDraft() {
    const result = expenseFromDraft(draft, concept);
    if (!result.expense) {
      Alert.alert("Revisá los datos", result.error);
      return;
    }

    const item = result.expense;
    if (records.some((record) => record.cuit === item.cuit && record.invoice === item.invoice)) {
      Alert.alert("Comprobante repetido", "Ese ticket ya está registrado.");
      return;
    }

    setRecords((previous) => [{ ...item, sent: false }, ...previous]);
    resetToQr();
    try {
      setSending(true);
      await sendRecordToPc(item);
      setRecords((previous) => previous.map((record) => (
        record.cuit === item.cuit && record.invoice === item.invoice ? { ...record, sent: true } : record
      )));
    } catch (error) {
      Alert.alert("Ticket pendiente en esta sesión", `${error.message}\nTocá 'Enviar pendientes' antes de cerrar Expo Go.`);
    } finally {
      setSending(false);
    }
  }

  async function sendPendingToPc() {
    const pending = records.filter((record) => !record.sent);
    if (!pending.length) {
      Alert.alert("Todo sincronizado", "Los gastos ya aparecen en la página de la PC.");
      return;
    }
    try {
      setSending(true);
      for (const record of pending) await sendRecordToPc(record);
      setRecords((previous) => previous.map((record) => ({ ...record, sent: true })));
      Alert.alert("Listo", "Los gastos pendientes se cargaron en la página de la PC.");
    } catch (error) {
      Alert.alert("No se pudo conectar a la PC", `${error.message}\nVerificá que el celular y la PC estén en la misma red Wi-Fi y que la dirección sea correcta.`);
    } finally {
      setSending(false);
    }
  }

  if (!permission) return <View style={styles.page} />;

  if (!permission.granted && stage !== "edit") {
    return <SafeAreaView style={styles.page}>
      <View style={styles.permissionContent}>
        <Text style={styles.title}>Necesitamos usar la cámara</Text>
        <Text style={styles.help}>La cámara permite leer el QR y fotografiar el ticket.</Text>
        <Pressable style={styles.primaryButton} onPress={requestPermission}><Text style={styles.primaryText}>Permitir cámara</Text></Pressable>
        <Pressable style={styles.secondaryButton} onPress={continueWithoutCamera}><Text style={styles.secondaryText}>Continuar con carga manual</Text></Pressable>
      </View>
    </SafeAreaView>;
  }

  if (stage === "photo") {
    return <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>PASO 2 · TICKET</Text>
        <Text style={styles.title}>Fotografiá el comprobante</Text>
        <Text style={styles.help}>Encuadrá el ticket completo. Después de la foto voy a buscar los datos automáticamente para que solo los revises.</Text>
        <View style={[styles.cameraWrap, styles.ticketCameraWrap]}>
          <CameraView
            ref={cameraRef}
            style={styles.camera}
            facing="back"
            mode="picture"
            autofocus="on"
            onCameraReady={() => setCameraReady(true)}
          />
          <View pointerEvents="none" style={[styles.guide, styles.ticketGuide]} />
        </View>
        <Pressable
          style={[styles.primaryButton, (!cameraReady || capturing) && styles.disabled]}
          disabled={!cameraReady || capturing}
          onPress={captureTicket}
        >
          <Text style={styles.primaryText}>{capturing ? "Tomando foto…" : cameraReady ? "Tomar foto" : "Preparando cámara…"}</Text>
        </Pressable>
        <Pressable
          style={[styles.secondaryButton, capturing && styles.disabled]}
          disabled={capturing}
          onPress={finishWithoutPhoto}
        >
          <Text style={styles.secondaryText}>Completar sin foto</Text>
        </Pressable>
        <Pressable
          style={[styles.textButton, capturing && styles.disabled]}
          disabled={capturing}
          onPress={cancelDraft}
        >
          <Text style={styles.textButtonText}>Volver al lector QR</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>;
  }

  if (stage === "edit") {
    const sourceMessage = draftSource === "electronic"
      ? "El QR completó estos campos. Revisalos y corregí cualquier dato antes de guardar."
      : draftSource === "ocr"
        ? "Busqué los datos en la foto. Revisalos y corregí cualquier dato antes de guardar."
        : draftSource === "ocr-failed"
          ? "No pude identificar todos los datos de la foto. Completá o corregí los campos que falten."
      : draftSource === "data-fiscal"
        ? "El QR fiscal fue reconocido. Buscá los datos restantes en la foto y corregí lo que falte."
        : "Completá los datos impresos en el ticket. Ningún campo se guardará hasta que lo confirmes.";

    return <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.eyebrow}>{draftSource === "electronic" ? "QR LEÍDO" : draftSource === "ocr" ? "DATOS LEÍDOS" : "REVISIÓN"}</Text>
        <Text style={styles.title}>Revisá los datos</Text>
        <View style={styles.notice}><Text style={styles.noticeText}>{sourceMessage}</Text></View>
        {photoUri && <View style={styles.photoCard}>
          <Pressable accessibilityRole="button" accessibilityLabel="Ampliar foto del ticket" onPress={() => setPhotoExpanded(true)}>
            <Image source={{ uri: photoUri }} style={styles.ticketPhoto} resizeMode="contain" />
          </Pressable>
          <Text style={styles.photoHelp}>Tocá la foto para verla grande. Es temporal y no se envía a la PC.</Text>
        </View>}
        <Text style={styles.label}>Fecha</Text>
        <TextInput
          value={draft.date}
          onChangeText={(value) => updateDraft("date", value)}
          style={styles.input}
          placeholder="AAAA-MM-DD"
          autoCapitalize="none"
          maxLength={10}
        />
        <Text style={styles.label}>Importe</Text>
        <TextInput
          value={draft.amount}
          onChangeText={(value) => updateDraft("amount", value.replace(/[^\d,.]/g, ""))}
          style={styles.input}
          placeholder="Ej.: 1.250,50"
          keyboardType="decimal-pad"
        />
        <Text style={styles.label}>CUIT del emisor</Text>
        <TextInput
          value={draft.cuit}
          onChangeText={(value) => updateDraft("cuit", onlyDigits(value))}
          style={styles.input}
          placeholder="11 dígitos"
          keyboardType="number-pad"
          maxLength={11}
        />
        <View style={styles.fieldsRow}>
          <View style={styles.fieldLeft}>
            <Text style={styles.label}>Punto de venta</Text>
            <TextInput
              value={draft.pointOfSale}
              onChangeText={(value) => updateDraft("pointOfSale", onlyDigits(value))}
              style={styles.input}
              placeholder="Ej.: 12"
              keyboardType="number-pad"
              maxLength={5}
            />
          </View>
          <View style={styles.fieldRight}>
            <Text style={styles.label}>N.º comprobante</Text>
            <TextInput
              value={draft.receiptNumber}
              onChangeText={(value) => updateDraft("receiptNumber", onlyDigits(value))}
              style={styles.input}
              placeholder="Ej.: 3456"
              keyboardType="number-pad"
              maxLength={8}
            />
          </View>
        </View>
        <Text style={styles.label}>Concepto</Text>
        <TextInput value={concept} onChangeText={setConcept} style={styles.input} placeholder="Concepto" />
        <Pressable style={[styles.primaryButton, sending && styles.disabled]} disabled={sending} onPress={addDraft}>
          <Text style={styles.primaryText}>{sending ? "Enviando…" : "Agregar gasto"}</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={photographCurrentDraft}><Text style={styles.secondaryText}>{photoUri ? "Repetir foto" : "Fotografiar ticket"}</Text></Pressable>
        <Pressable style={styles.textButton} onPress={cancelDraft}><Text style={styles.textButtonText}>Cancelar y volver al QR</Text></Pressable>
      </ScrollView>
      {photoUri && <Modal
        animationType="fade"
        transparent
        visible={photoExpanded}
        onRequestClose={() => setPhotoExpanded(false)}
      >
        <View style={styles.modalBackdrop}>
          <Image source={{ uri: photoUri }} style={styles.expandedPhoto} resizeMode="contain" />
          <Pressable style={styles.modalCloseButton} onPress={() => setPhotoExpanded(false)}>
            <Text style={styles.primaryText}>Cerrar foto</Text>
          </Pressable>
        </View>
      </Modal>}
    </SafeAreaView>;
  }

  return <SafeAreaView style={styles.page}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.eyebrow}>PASO 1 · QR</Text>
      <Text style={styles.title}>Escaneá el QR fiscal</Text>
      <Text style={styles.help}>Si contiene los datos de la compra, se completarán automáticamente. Si no, podrás fotografiar el ticket y cargarlos vos.</Text>
      <View style={styles.cameraWrap}>
        <CameraView
          style={styles.camera}
          facing="back"
          autofocus="on"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={!scanLocked ? handleScan : undefined}
        />
        <View pointerEvents="none" style={styles.guide} />
      </View>
      <Pressable style={styles.secondaryButton} onPress={() => startManualCapture("manual")}><Text style={styles.secondaryText}>Fotografiar ticket y cargar datos</Text></Pressable>
      <View style={styles.connection}>
        <Text style={styles.sectionTitle}>Conexión con tu PC</Text>
        <Text style={styles.small}>Esta es la dirección de tu PC en la red actual. Cada ticket se envía al instante y aparece en la página.</Text>
        <TextInput value={serverUrl} onChangeText={setServerUrl} style={styles.input} autoCapitalize="none" keyboardType="url" />
        <Pressable
          style={[styles.primaryButton, (!hasPending || sending) && styles.disabled]}
          disabled={!hasPending || sending}
          onPress={sendPendingToPc}
        >
          <Text style={styles.primaryText}>{sending ? "Enviando…" : "Enviar pendientes a la PC"}</Text>
        </Pressable>
        {hasPending && <Text style={styles.pendingWarning}>Los pendientes todavía no están guardados en el teléfono. Enviálos antes de cerrar o recargar Expo Go.</Text>}
      </View>
      <Text style={styles.summary}>{records.length} gastos · ${total.toFixed(2)}</Text>
      {records.map((item) => <View
        key={`${item.cuit}-${item.invoice}`}
        style={styles.row}
      >
        <View style={styles.rowContent}>
          <Text style={styles.rowTitle}>{item.concept}</Text>
          <Text style={styles.small}>{item.date} · {item.invoice} · {item.sent ? "Enviado a la PC" : "Pendiente"}</Text>
        </View>
        <View style={styles.rowActions}>
          <Text style={styles.amount}>${item.amount.toFixed(2)}</Text>
          <Pressable
            style={[styles.removeButton, sending && styles.disabled]}
            disabled={sending}
            onPress={() => confirmRemoveRecord(item)}
          >
            <Text style={styles.removeButtonText}>Quitar</Text>
          </Pressable>
        </View>
      </View>)}
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#f4f7fb" },
  content: { padding: 18, paddingBottom: 36 },
  permissionContent: { flex: 1, justifyContent: "center", padding: 24 },
  eyebrow: { color: "#1769e0", fontWeight: "800", letterSpacing: 1, marginTop: 10 },
  title: { color: "#102a43", fontSize: 28, fontWeight: "800", marginTop: 6 },
  help: { color: "#617184", lineHeight: 20, marginVertical: 8 },
  cameraWrap: { height: 300, overflow: "hidden", borderRadius: 18, backgroundColor: "#071527", marginTop: 10 },
  ticketCameraWrap: { height: 410 },
  camera: { flex: 1 },
  guide: { position: "absolute", top: 45, bottom: 45, left: 38, right: 38, borderWidth: 2, borderRadius: 18, borderColor: "#fff" },
  ticketGuide: { top: 22, bottom: 22, left: 60, right: 60, borderRadius: 12 },
  primaryButton: { backgroundColor: "#1769e0", padding: 14, borderRadius: 11, alignItems: "center", marginTop: 10 },
  primaryText: { color: "#fff", fontWeight: "800" },
  secondaryButton: { backgroundColor: "#e5edf7", padding: 12, borderRadius: 11, alignItems: "center", marginTop: 10 },
  secondaryText: { color: "#28435d", fontWeight: "700", textAlign: "center" },
  textButton: { padding: 12, alignItems: "center", marginTop: 4 },
  textButtonText: { color: "#52677c", fontWeight: "700" },
  disabled: { opacity: 0.45 },
  notice: { backgroundColor: "#e6f1ff", borderRadius: 12, padding: 13, marginTop: 12 },
  noticeText: { color: "#28435d", lineHeight: 19 },
  photoCard: { backgroundColor: "#fff", borderRadius: 13, padding: 10, marginTop: 12 },
  ticketPhoto: { width: "100%", height: 320, backgroundColor: "#eef2f7", borderRadius: 9 },
  photoHelp: { color: "#617184", fontSize: 12, lineHeight: 17, marginTop: 7 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.92)", padding: 14, justifyContent: "center" },
  expandedPhoto: { flex: 1, width: "100%" },
  modalCloseButton: { backgroundColor: "#1769e0", padding: 14, borderRadius: 11, alignItems: "center", marginTop: 10, marginBottom: 18 },
  label: { color: "#28435d", fontWeight: "700", marginTop: 12 },
  input: { backgroundColor: "#fff", borderColor: "#cbd6e2", borderWidth: 1, borderRadius: 9, padding: 11, marginTop: 6 },
  fieldsRow: { flexDirection: "row" },
  fieldLeft: { flex: 1, marginRight: 6 },
  fieldRight: { flex: 1, marginLeft: 6 },
  connection: { backgroundColor: "#fff", borderRadius: 13, padding: 14, marginTop: 16 },
  pendingWarning: { color: "#8a4b08", fontSize: 12, lineHeight: 17, marginTop: 9 },
  sectionTitle: { color: "#102a43", fontWeight: "800", marginBottom: 6 },
  small: { color: "#617184", fontSize: 12, lineHeight: 17 },
  summary: { fontWeight: "800", color: "#102a43", marginTop: 14 },
  row: { backgroundColor: "#fff", borderBottomWidth: 1, borderColor: "#e1e8f0", padding: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowContent: { flex: 1, paddingRight: 10 },
  rowActions: { alignItems: "flex-end" },
  rowTitle: { fontWeight: "700", color: "#102a43" },
  amount: { fontWeight: "800", color: "#102a43" },
  removeButton: { paddingHorizontal: 8, paddingVertical: 6, marginTop: 4 },
  removeButtonText: { color: "#b42318", fontSize: 12, fontWeight: "700" },
});
