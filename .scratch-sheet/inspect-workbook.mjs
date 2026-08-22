import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const file = "../Registro Deducciones Diciembre 2025.xlsx";
const input = await FileBlob.load(file);
const workbook = await SpreadsheetFile.importXlsx(input);

const summary = await workbook.inspect({
  kind: "workbook,sheet,table,region",
  maxChars: 12000,
  tableMaxRows: 20,
  tableMaxCols: 20,
  tableMaxCellChars: 100,
});
console.log(summary.ndjson);

const preview = await workbook.render({ sheetName: "Hoja1", autoCrop: "all", scale: 0.8, format: "png" });
console.log(`PREVIEW:${Buffer.from(await preview.arrayBuffer()).toString("base64")}`);
