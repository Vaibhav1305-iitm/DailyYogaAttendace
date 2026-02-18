// ============================================
// YOGA ATTENDANCE — GOOGLE APPS SCRIPT
// Deploy as Web App to receive attendance data
// ============================================

// === CONFIGURATION ===
const SHEET_ID = '1Vq1cQgW4Cm7-cC3aKglFhRGwBJu6-ZMnKecrL1nVAxs';
const SHEET_NAME = 'Sheet1'; // Change if your tab has a different name

// === HEADERS (Row 1 in your sheet) ===
const HEADERS = ['Date', 'Batch', 'Batch Time', 'Student ID', 'Student Name', 'App Number', 'Status', 'Saved At'];

/**
 * GET handler — routes requests based on ?action= parameter
 */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  const callback = (e && e.parameter && e.parameter.callback) || '';

  try {
    let result;

    switch (action) {
      case 'getAttendance':
        result = handleGetAttendance(e.parameter.date || '');
        break;

      case 'getStudents':
        result = handleGetStudents();
        break;

      default:
        result = { success: true, message: 'Yoga Attendance API is running' };
    }

    // Support JSONP callback for cross-origin from file:// or old browsers
    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(result) + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    const errResult = { success: false, error: err.toString() };
    if (callback) {
      return ContentService
        .createTextOutput(callback + '(' + JSON.stringify(errResult) + ')')
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return ContentService
      .createTextOutput(JSON.stringify(errResult))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Get attendance records for a specific date
 * Returns: { success, batches: { batch_01: { records: [...], locked: true }, ... } }
 */
function handleGetAttendance(dateStr) {
  if (!dateStr) {
    return { success: false, error: 'Date parameter required' };
  }

  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.getSheets()[0];

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return { success: true, batches: {} };
  }

  // Build batch attendance from sheet rows
  const batches = {};

  for (let i = 1; i < data.length; i++) {
    const rowDate = String(data[i][0]).trim();
    if (rowDate !== dateStr) continue;

    const batchName = String(data[i][1]).trim();
    const batchTime = String(data[i][2]).trim();
    const studentId = String(data[i][3]).trim();
    const studentName = String(data[i][4]).trim();
    const appNumber = String(data[i][5]).trim();
    const status = String(data[i][6]).trim().toLowerCase();
    const savedAt = String(data[i][7]).trim();

    // Determine batch key from batch name
    let batchKey = 'batch_01';
    if (batchName.indexOf('02') !== -1 || batchName.indexOf('2') !== -1) {
      batchKey = 'batch_02';
    }

    if (!batches[batchKey]) {
      batches[batchKey] = { records: [], locked: true, batchName: batchName, batchTime: batchTime };
    }

    batches[batchKey].records.push({
      studentId: studentId,
      studentName: studentName,
      appNumber: appNumber,
      status: status,
      savedAt: savedAt
    });
  }

  return { success: true, date: dateStr, batches: batches };
}

/**
 * Get student list from the source sheet
 */
function handleGetStudents() {
  // Read from the source sheet (student master list)
  // The student data comes from a different sheet/GID than attendance
  // For now, return from the main spreadsheet's first sheet
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets();

  // Try to find a sheet that looks like student data (not attendance)
  // The attendance sheet has HEADERS like Date, Batch, etc.
  // Student sheet typically has Name, App Number, Student ID columns
  for (let s = 0; s < sheets.length; s++) {
    const firstRow = sheets[s].getRange(1, 1, 1, 3).getValues()[0];
    if (String(firstRow[0]).toLowerCase().includes('name') ||
        String(firstRow[0]).toLowerCase().includes('student')) {
      const data = sheets[s].getDataRange().getValues();
      const students = [];
      for (let i = 1; i < data.length; i++) {
        const name = String(data[i][0] || '').trim();
        const appNumber = String(data[i][1] || '').trim();
        const id = String(data[i][2] || '').trim();
        if (name && id) {
          students.push({ name: name, appNumber: appNumber, id: id });
        }
      }
      return { success: true, students: students };
    }
  }

  return { success: false, error: 'Student sheet not found' };
}

/**
 * POST handler — receives attendance data from the app
 * Handles both JSON body (fetch) and form-encoded data (hidden form submission)
 */
function doPost(e) {
  try {
    let body;

    // Form-based POST (bypasses CORS from file:// origin)
    if (e.parameter && e.parameter.payload) {
      body = JSON.parse(e.parameter.payload);
    }
    // Standard JSON POST (from fetch)
    else if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }

    if (!body) {
      return jsonResponse({ success: false, error: 'No data received' });
    }

    if (body.action === 'saveAttendance') {
      return handleSaveAttendance(body);
    }

    return jsonResponse({ success: false, error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ success: false, error: err.toString() });
  }
}

/**
 * Save attendance records to the sheet
 */
function handleSaveAttendance(body) {
  const records = body.data;
  if (!records || !Array.isArray(records) || records.length === 0) {
    return jsonResponse({ success: false, error: 'No records provided' });
  }

  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.getSheets()[0]; // fallback to first sheet
  }

  // Ensure headers exist in Row 1
  ensureHeaders(sheet);

  // Get existing data for duplicate prevention
  const existingData = sheet.getDataRange().getValues();
  const existingKeys = new Set();
  for (let i = 1; i < existingData.length; i++) {
    // Key = "Date|Batch|StudentID"
    const key = `${existingData[i][0]}|${existingData[i][1]}|${existingData[i][3]}`;
    existingKeys.add(key);
  }

  // Build rows to append (skip duplicates)
  const savedAt = new Date().toISOString();
  const newRows = [];
  let skipped = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const key = `${r.date}|${r.batch}|${r.studentId}`;

    if (existingKeys.has(key)) {
      skipped++;
      continue;
    }

    newRows.push([
      r.date,
      r.batch,
      r.batchTime,
      r.studentId,
      r.studentName,
      r.appNumber,
      r.status,
      savedAt
    ]);
  }

  // Append all new rows at once (batch write — efficient)
  if (newRows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, HEADERS.length).setValues(newRows);
  }

  // Save photo to Google Drive (optional — as a backup)
  let photoUrl = null;
  if (body.photo) {
    try {
      photoUrl = savePhotoToDrive(body.photo, records[0].date, records[0].batch);
    } catch (photoErr) {
      // Photo save failed, but attendance data is saved — don't fail the whole request
      Logger.log('Photo save error: ' + photoErr.toString());
    }
  }

  return jsonResponse({
    success: true,
    saved: newRows.length,
    skipped: skipped,
    total: records.length,
    photoUrl: photoUrl
  });
}

/**
 * Ensure headers exist in Row 1
 */
function ensureHeaders(sheet) {
  const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  const isEmpty = firstRow.every(cell => cell === '' || cell === null);

  if (isEmpty) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    // Bold + freeze header row
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}

/**
 * Save proof photo to Google Drive
 */
function savePhotoToDrive(base64Data, date, batch) {
  // Remove data URL prefix if present
  const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const blob = Utilities.newBlob(Utilities.base64Decode(base64Clean), 'image/jpeg', `yoga_${date}_${batch}.jpg`);

  // Create or find folder
  const folders = DriveApp.getFoldersByName('Yoga Attendance Photos');
  let folder;
  if (folders.hasNext()) {
    folder = folders.next();
  } else {
    folder = DriveApp.createFolder('Yoga Attendance Photos');
  }

  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

/**
 * Helper: Create HTML response (works with form+iframe submissions)
 */
function htmlResponse(obj) {
  const html = '<html><body><script>var r=' + JSON.stringify(obj) + ';</script></body></html>';
  return HtmlService.createHtmlOutput(html);
}

/**
 * Helper: Create JSON response (for direct API calls)
 */
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Test function — run this from Apps Script editor to verify setup
 */
function testSetup() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  ensureHeaders(sheet);
  Logger.log('✅ Setup verified! Sheet: ' + sheet.getName() + ', Headers OK');
}
