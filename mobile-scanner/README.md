# Lector de tickets para Expo Go

1. En la PC, abrí `scanner-app\INICIAR LECTOR.cmd`. La consola mostrará una dirección similar a `http://192.168.100.x:4173`. Si cambia, reemplazala en el campo de conexión de la app móvil.
2. Ejecutá `INSTALAR Y ABRIR.cmd` en esta carpeta. Al terminar verás un QR de Expo en la consola.
3. Instalá Expo Go en tu celular y escaneá ese QR. La PC y el celular deben usar la misma red Wi-Fi.
4. Dentro de la app, escribí la dirección de la PC mostrada en el paso 1 y escaneá el QR fiscal:
   - Si es un QR de factura electrónica, la app completa los datos para que los revises y edites.
   - Si es un QR de Data Fiscal o no contiene los datos de la compra, tocá **Fotografiar ticket**. La PC analizará la foto y completará automáticamente fecha, importe, CUIT, punto de venta y número de comprobante.
5. Tocá **Agregar gasto**. Cada gasto se carga automáticamente en la página abierta en la PC.

La foto se envía temporalmente a la PC para realizar OCR en español. Los datos detectados aparecen en el formulario para que los revises y corrijas antes de guardar; la foto no se guarda con el gasto.

Cuando termines, descargá el Excel desde la página de la PC. La aplicación usa la cámara trasera del teléfono con autofocus nativo.
