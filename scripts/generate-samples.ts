/**
 * Generates synthetic sample import files into ./samples:
 *  - vip-recipients-ar.xlsx   Arabic headers, a title row above the header, realistic data problems
 *  - vip-recipients-en.xlsx   English headers, clean
 *  - vip-recipients-large.csv 3,000 rows to exercise background processing
 */
import { mkdirSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { generateRecipients } from "../src/lib/synthetic";

async function main() {
  mkdirSync("samples", { recursive: true });
  const people = generateRecipients(60, 11);
  // deliberate problems for the review step
  people[5].mobile = "05123"; // invalid
  people[9].address = "";
  people[9].mapsUrl = ""; // no location
  people[14] = { ...people[3], ref: "G-9999" }; // duplicate of row 3 (same mobile & name)
  people[20].mobile = "0112345678"; // landline
  people[27].mapsUrl = "javascript:alert(1)"; // unsafe link → dropped with warning
  people[33].nameAr = ""; // only English name
  people[41].mobile = "=HYPERLINK(\"http://evil\")"; // formula-like content

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("قائمة المدعوين", { views: [{ rightToLeft: true }] });
  ws.addRow(["قائمة كبار المدعوين — مؤتمر تجريبي 2026 (بيانات وهمية)"]);
  ws.addRow([]);
  ws.addRow(["الرقم المرجعي", "اللقب", "الاسم", "الاسم بالانجليزي", "المسمى الوظيفي", "الجهة", "الفئة", "رقم الجوال", "المدينة", "الحي", "العنوان", "رابط الموقع", "الوقت المفضل", "الأولوية", "ملاحظات"]);
  for (const p of people) ws.addRow([p.ref, p.honorific, p.nameAr, p.nameEn, p.jobTitle, p.organization, p.tier, p.mobile, p.city, p.district, p.address, p.mapsUrl, p.window, p.priority, ""]);
  ws.getRow(3).font = { bold: true };
  ws.columns.forEach((c) => (c.width = 22));
  const other = wb.addWorksheet("ملاحظات");
  other.addRow(["هذه ورقة إضافية لاختبار اختيار الورقة"]);
  await wb.xlsx.writeFile("samples/vip-recipients-ar.xlsx");

  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet("Guests");
  ws2.addRow(["Guest ID", "Salutation", "Full Name", "Arabic Name", "Position", "Company", "VIP Tier", "Mobile Number", "City", "District", "Delivery Address", "Google Maps", "Preferred Time", "Priority"]);
  for (const p of generateRecipients(25, 99)) ws2.addRow([p.ref, p.honorific, p.nameEn, p.nameAr, p.jobTitle, p.organization, p.tier, p.mobile, p.city, p.district, p.address, p.mapsUrl, p.window, "High"]);
  await wb2.xlsx.writeFile("samples/vip-recipients-en.xlsx");

  const large = generateRecipients(3000, 2026);
  const lines = ["ref,name,name_en,organization,mobile,city,district,address,maps"];
  for (const p of large) lines.push([p.ref, p.nameAr, p.nameEn, p.organization, p.mobile, p.city, p.district, p.address, p.mapsUrl].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  writeFileSync("samples/vip-recipients-large.csv", "﻿" + lines.join("\n"));
  console.log("samples written: vip-recipients-ar.xlsx (60), vip-recipients-en.xlsx (25), vip-recipients-large.csv (3000)");
}

main();
