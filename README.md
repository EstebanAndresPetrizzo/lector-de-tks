# Lector de comprobantes para declaración jurada

Aplicación local para transformar muchos tickets, facturas, fotos o PDF en un único Excel con el formato:

| FECHA | IMPORTE | CUIT sin guiones | NRO FACTURA | CONCEPTO del GATOS |
|---|---:|---|---|---|

La versión 2 usa una sola aplicación Python. No requiere Expo, Node ni una cámara conectada a la PC.

## Qué resuelve

- Carga varias imágenes JPG, JPEG, JFIF, PNG, WEBP, TIFF o PDF juntas, incluso una carpeta completa.
- Se abre desde el celular para fotografiar tickets usando la cámara del teléfono.
- Lee primero el QR fiscal de ARCA/AFIP y usa OCR cuando el QR no contiene todos los datos.
- Marca únicamente los campos dudosos para revisión.
- Omite duplicados por CUIT + número de comprobante.
- Recuerda el concepto elegido para cada CUIT.
- Genera un Excel nuevo y limpio; CUIT y factura se muestran completos, sin perder ceros iniciales ni usar notación científica.
- Guarda registros y reglas en SQLite, sólo dentro de la PC.

## Instalación en Windows

1. Instalá **Python 3.11, 3.12, 3.13 o 3.14** y marcá `Add Python to PATH`.
2. Para leer tickets sin QR electrónico, instalá **Tesseract OCR**. Con `winget`:

   ```powershell
   winget install -e --id UB-Mannheim.TesseractOCR
   ```

3. Hacé doble clic en `INICIAR.cmd`.

La primera ejecución crea un entorno aislado e instala las dependencias. Después se abre el navegador automáticamente.

La instalación usa únicamente paquetes precompilados: no requiere Visual Studio, compiladores C ni herramientas de desarrollo adicionales.

Cuando Windows pregunte por el acceso de red, elegí **Permitir acceso** únicamente para redes privadas. Esto permite abrir el lector desde el celular conectado al mismo Wi-Fi.

Si Tesseract está en una ruta no habitual, definí `TESSERACT_CMD` con la ruta completa a `tesseract.exe`.

## Uso

### Desde la PC

1. Abrí `INICIAR.cmd`.
2. Elegí varias fotos/PDF o una carpeta completa.
3. Revisá sólo las filas amarillas.
4. Descargá el Excel.

### Desde el celular

1. Conectá el celular y la PC al mismo Wi-Fi privado.
2. Abrí en el teléfono la dirección `Celular:` que muestra la ventana del programa o copiala desde la sección **Usarlo desde el celular**.
3. Tocá **Fotografiar ticket** o seleccioná varias fotos existentes.
4. Los registros aparecen inmediatamente también en la PC.

Cada ejecución usa un PIN aleatorio incluido en el enlace para evitar que otra persona de la red vea los registros por accidente.

## Privacidad

No se usa ninguna API externa. Las imágenes se procesan en memoria y no se conservan. Sólo se guardan los datos extraídos en `data/registros.sqlite3`, carpeta excluida de Git.

## Pruebas

```bash
python -m unittest discover -s tests -v
```

## Estructura nueva

- `app.py`: servidor web local y API.
- `lector_tks/extractor.py`: lectura de QR, OCR y extracción de campos.
- `lector_tks/storage.py`: persistencia local y duplicados.
- `lector_tks/excel_export.py`: generación del Excel.
- `web/`: interfaz responsive para PC y celular.
- `tests/`: pruebas de extracción, persistencia y Excel.
