import { CameraView, useCameraPermissions } from "expo-camera";
import { useMemo, useState } from "react";
import { Alert, FlatList, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from "react-native";

const DEFAULT_CONCEPT = "GASTOS DE RESPRESENTACION";

function decodeBase64(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
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

function parseAfipQr(rawValue) {
  try {
    const url = new URL(rawValue);
    const payload = url.searchParams.get("p");
    if (!payload || !/afip\.gob\.ar$/i.test(url.hostname)) return null;
    const data = JSON.parse(decodeBase64(payload));
    if (!data.fecha || !data.cuit || data.importe === undefined || data.ptoVta === undefined || data.nroCmp === undefined) return null;
    return {
      date: data.fecha,
      amount: Number(data.importe),
      cuit: String(data.cuit),
      invoice: `${String(data.ptoVta).padStart(4, "0")}${String(data.nroCmp).padStart(8, "0")}`,
    };
  } catch { return null; }
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(true);
  const [current, setCurrent] = useState(null);
  const [concept, setConcept] = useState(DEFAULT_CONCEPT);
  const [records, setRecords] = useState([]);
  const [serverUrl, setServerUrl] = useState("http://192.168.100.247:4173");
  const [sending, setSending] = useState(false);
  const total = useMemo(() => records.reduce((sum, record) => sum + record.amount, 0), [records]);

  if (!permission) return <View style={styles.page} />;
  if (!permission.granted) return <SafeAreaView style={styles.page}><Text style={styles.title}>Necesitamos usar la cámara</Text><Text style={styles.help}>La cámara trasera del teléfono enfoca automáticamente el QR del ticket.</Text><Pressable style={styles.primaryButton} onPress={requestPermission}><Text style={styles.primaryText}>Permitir cámara</Text></Pressable></SafeAreaView>;

  function handleScan({ data }) {
    if (!scanning) return;
    const expense = parseAfipQr(data);
    if (!expense) { Alert.alert("No es un QR fiscal", "Enfocá el QR de AFIP impreso en el ticket."); return; }
    setCurrent(expense); setScanning(false);
  }

  async function sendRecordToPc(item) {
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/mobile-record`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item) });
    const payload = await response.json();
    if (!response.ok && response.status !== 409) throw new Error(payload.error || "No se pudo enviar el gasto.");
  }

  async function addCurrent() {
    if (!current) return;
    const item = { ...current, concept: concept.trim() || DEFAULT_CONCEPT };
    if (records.some((record) => record.cuit === item.cuit && record.invoice === item.invoice)) { Alert.alert("Comprobante repetido", "Ese ticket ya está registrado."); return; }
    setRecords((previous) => [{ ...item, sent: false }, ...previous]); setCurrent(null); setScanning(true);
    try {
      setSending(true); await sendRecordToPc(item);
      setRecords((previous) => previous.map((record) => record.cuit === item.cuit && record.invoice === item.invoice ? { ...record, sent: true } : record));
    } catch (error) { Alert.alert("Ticket guardado en el celular", `${error.message}\nTocá 'Enviar pendientes' cuando la PC y el celular estén en la misma red.`); }
    finally { setSending(false); }
  }

  async function sendPendingToPc() {
    const pending = records.filter((record) => !record.sent);
    if (!pending.length) { Alert.alert("Todo sincronizado", "Los gastos ya aparecen en la página de la PC."); return; }
    try {
      setSending(true);
      for (const record of pending) await sendRecordToPc(record);
      setRecords((previous) => previous.map((record) => ({ ...record, sent: true })));
      Alert.alert("Listo", "Los gastos pendientes se cargaron en la página de la PC.");
    } catch (error) { Alert.alert("No se pudo conectar a la PC", `${error.message}\nVerificá que el celular y la PC estén en la misma red Wi-Fi y que la dirección sea correcta.`); }
    finally { setSending(false); }
  }

  return <SafeAreaView style={styles.page}>
    <Text style={styles.eyebrow}>LECTOR DE TICKETS</Text><Text style={styles.title}>Escaneá el QR de AFIP</Text><Text style={styles.help}>Usá la cámara trasera: el foco se ajusta automáticamente.</Text>
    <View style={styles.cameraWrap}><CameraView style={styles.camera} facing="back" autofocus="on" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanning ? handleScan : undefined} /><View pointerEvents="none" style={styles.guide} /></View>
    <Pressable style={styles.secondaryButton} onPress={() => setScanning(true)}><Text style={styles.secondaryText}>Escanear siguiente ticket</Text></Pressable>
    {current && <View style={styles.detected}><Text style={styles.sectionTitle}>Ticket detectado</Text><Text>{current.date} · ${current.amount.toFixed(2)}</Text><Text>CUIT {current.cuit} · Factura {current.invoice}</Text><TextInput value={concept} onChangeText={setConcept} style={styles.input} placeholder="Concepto" /><Pressable style={styles.primaryButton} onPress={addCurrent}><Text style={styles.primaryText}>Agregar gasto</Text></Pressable></View>}
    <View style={styles.connection}><Text style={styles.sectionTitle}>Conexión con tu PC</Text><Text style={styles.small}>Esta es la dirección de tu PC en la red actual. Cada ticket se envía al instante y aparece en la página.</Text><TextInput value={serverUrl} onChangeText={setServerUrl} style={styles.input} autoCapitalize="none" keyboardType="url" /><Pressable style={[styles.primaryButton, !records.some((record) => !record.sent) && styles.disabled]} disabled={sending} onPress={sendPendingToPc}><Text style={styles.primaryText}>{sending ? "Enviando…" : "Enviar pendientes a la PC"}</Text></Pressable></View>
    <Text style={styles.summary}>{records.length} gastos · ${total.toFixed(2)}</Text>
    <FlatList data={records} keyExtractor={(item) => `${item.cuit}-${item.invoice}`} style={styles.list} renderItem={({ item, index }) => <Pressable onPress={() => setRecords((previous) => previous.filter((_, position) => position !== index))} style={styles.row}><View><Text style={styles.rowTitle}>{item.concept}</Text><Text style={styles.small}>{item.date} · {item.invoice} · {item.sent ? "Enviado a la PC" : "Pendiente"}</Text></View><Text style={styles.amount}>${item.amount.toFixed(2)}</Text></Pressable>} />
  </SafeAreaView>;
}

const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: "#f4f7fb", padding: 18 }, eyebrow: { color: "#1769e0", fontWeight: "800", letterSpacing: 1, marginTop: 10 }, title: { color: "#102a43", fontSize: 28, fontWeight: "800", marginTop: 6 }, help: { color: "#617184", lineHeight: 20, marginVertical: 8 }, cameraWrap: { height: 300, overflow: "hidden", borderRadius: 18, backgroundColor: "#071527", marginTop: 10 }, camera: { flex: 1 }, guide: { position: "absolute", top: 45, bottom: 45, left: 38, right: 38, borderWidth: 2, borderRadius: 18, borderColor: "#fff" }, primaryButton: { backgroundColor: "#1769e0", padding: 14, borderRadius: 11, alignItems: "center", marginTop: 10 }, primaryText: { color: "#fff", fontWeight: "800" }, secondaryButton: { backgroundColor: "#e5edf7", padding: 12, borderRadius: 11, alignItems: "center", marginTop: 10 }, secondaryText: { color: "#28435d", fontWeight: "700" }, detected: { backgroundColor: "#e6f7ef", borderRadius: 13, padding: 14, marginTop: 12 }, connection: { backgroundColor: "#fff", borderRadius: 13, padding: 14, marginTop: 12 }, sectionTitle: { color: "#102a43", fontWeight: "800", marginBottom: 6 }, input: { backgroundColor: "#fff", borderColor: "#cbd6e2", borderWidth: 1, borderRadius: 9, padding: 11, marginTop: 10 }, small: { color: "#617184", fontSize: 12, lineHeight: 17 }, summary: { fontWeight: "800", color: "#102a43", marginTop: 14 }, list: { marginTop: 6 }, row: { backgroundColor: "#fff", borderBottomWidth: 1, borderColor: "#e1e8f0", padding: 12, flexDirection: "row", justifyContent: "space-between" }, rowTitle: { fontWeight: "700", color: "#102a43" }, amount: { fontWeight: "800", color: "#102a43" }, disabled: { opacity: .45 } });
