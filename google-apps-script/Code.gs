// ============================================
// YOGA ATTENDANCE — Google Apps Script Backend
// ============================================
// 
// SETUP INSTRUCTIONS:
// 1. Open Google Sheet: https://docs.google.com/spreadsheets/d/1g8J61vJLWh_sP0by9biJVACR0EGtC8XGlft9mmHLkps
// 2. Go to Extensions → Apps Script
// 3. Paste this entire file into Code.gs
// 4. Create an "Attendance" tab in the Sheet with columns:
//    Date | Batch | Student_ID | Student_Name | App_Number | Status | Time | Photo_URL
// 5. Deploy → New Deployment → Web App
//    - Execute as: Me
//    - Who has access: Anyone
// 6. Copy the Web App URL and paste it in config.js → API_URL
//
// ============================================

const SHEET_ID = '1g8J61vJLWh_sP0by9biJVACR0EGtC8XGlft9mmHLkps';  // Students source
const ATTENDANCE_SHEET_ID = '1Vq1cQgW4Cm7-cC3aKglFhRGwBJu6-ZMnKecrL1nVAxs';  // Daily Yoga Attendance (save here)
const STUDENTS_GID = '1897721584';
const ATTENDANCE_SHEET_NAME = 'Attendance';
const PHOTO_FOLDER_NAME = 'Yoga_Attendance_Photos';

// ======= Web App Entry Points =======

function doGet(e) {
  const action = e.parameter.action;
  const callback = e.parameter.callback; // JSONP support
  let result;

  try {
    switch (action) {
      case 'getStudents':
        result = getStudents();
        break;
      case 'getAttendance':
        result = getAttendance(e.parameter.date, e.parameter.batch);
        break;
      case 'getAllAttendance':
        result = getAllAttendance(e.parameter.date);
        break;
      case 'checkLock':
        result = checkBatchLocked(e.parameter.date, e.parameter.batch);
        break;
      case 'getMergedData':
        result = getMergedData(e.parameter.date);
        break;
      case 'saveViaGet':
        result = saveAttendanceViaGet(e.parameter);
        break;
      case 'getPhotoUrl':
        result = getPhotoUrlForBatch(e.parameter.date, e.parameter.batch);
        break;
      default:
        result = { success: false, error: 'Unknown action' };
    }
  } catch (err) {
    result = { success: false, error: err.toString() };
  }

  const json = JSON.stringify(result);

  // JSONP: wrap in callback for file:// CORS bypass
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let result;

  try {
    let payload;

    // Method 1: Raw JSON body (from fetch POST with text/plain)
    if (e.postData && e.postData.contents) {
      try {
        payload = JSON.parse(e.postData.contents);
      } catch (parseErr) {
        // Not raw JSON — might be form-encoded, try next method
      }
    }

    // Method 2: Form-encoded POST (from hidden form+iframe)
    if (!payload && e.parameter && e.parameter.payload) {
      try {
        payload = JSON.parse(e.parameter.payload);
      } catch (parseErr2) {
        // Form payload parse failed
      }
    }

    // Method 3: Extract from URL-encoded body (fallback)
    if (!payload && e.postData && e.postData.contents && e.postData.contents.indexOf('payload=') === 0) {
      try {
        const decoded = decodeURIComponent(e.postData.contents.substring(8));
        payload = JSON.parse(decoded);
      } catch (parseErr3) {
        // All parse methods failed
      }
    }

    if (!payload) {
      return ContentService
        .createTextOutput(JSON.stringify({ success: false, error: 'No data received. postData type: ' + (e.postData ? e.postData.type : 'none') }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const action = payload.action;

    switch (action) {
      case 'saveAttendance':
        result = saveAttendance(payload.data, payload.photo);
        break;
      case 'uploadPhoto':
        result = uploadPhotoAndUpdateSheet(payload.date, payload.batch, payload.photo);
        break;
      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    result = { success: false, error: err.toString() };
  }

  // Return JSON (ContentService — works with fetch, no X-Frame-Options issues)
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ======= Student Functions =======

// Save attendance via GET (JSONP-compatible, CORS-proof)
function saveAttendanceViaGet(params) {
  const date = params.date;
  const batch = params.batch;
  const time = params.time || new Date().toLocaleTimeString('en-US', { hour12: false });

  if (!date || !batch || !params.records) {
    return { success: false, error: 'Missing date, batch, or records' };
  }

  const sheet = getAttendanceSheet();

  // Check if already saved (locked)
  const lockCheck = checkBatchLocked(date, batch);
  if (lockCheck.locked) {
    return { success: false, error: 'This batch is already saved and locked.' };
  }

  // Parse compact records: "id:status:name:appNum|id:status:name:appNum|..."
  const recordParts = params.records.split('|');
  const savedAt = new Date().toISOString();
  const rows = [];

  for (let i = 0; i < recordParts.length; i++) {
    const parts = recordParts[i].split(':');
    if (parts.length < 2) continue;

    const studentId = decodeURIComponent(parts[0]);
    const statusCode = parts[1];
    const studentName = parts.length > 2 ? decodeURIComponent(parts[2]) : '';
    const appNumber = parts.length > 3 ? decodeURIComponent(parts[3]) : '';

    // Expand status code: p=present, a=absent, l=leave
    let status;
    switch (statusCode) {
      case 'p': status = 'Present'; break;
      case 'a': status = 'Absent'; break;
      default: status = 'Leave';
    }

    rows.push([date, batch, studentId, studentName, appNumber, status, time, '', savedAt]);
  }

  if (rows.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, 9).setValues(rows);
  }

  return {
    success: true,
    message: 'Saved ' + rows.length + ' records',
    saved: rows.length
  };
}

function getStudents() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheets = ss.getSheets();
  
  // Find the students sheet by GID
  let sheet = null;
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId().toString() === STUDENTS_GID) {
      sheet = sheets[i];
      break;
    }
  }

  if (!sheet) {
    return { success: false, error: 'Students sheet not found' };
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const students = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0] && row[0].toString().trim()) {
      students.push({
        name: row[0].toString().trim(),
        appNumber: row[1] ? row[1].toString().trim() : '',
        id: row[2] ? row[2].toString().trim() : '',
        active: true
      });
    }
  }

  return {
    success: true,
    students: students,
    count: students.length
  };
}

// ======= Attendance Functions =======

function getAttendanceSheet() {
  const ss = SpreadsheetApp.openById(ATTENDANCE_SHEET_ID);  // Use attendance spreadsheet
  let sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);

  // Create if not exists
  if (!sheet) {
    sheet = ss.insertSheet(ATTENDANCE_SHEET_NAME);
    sheet.appendRow([
      'Date', 'Batch', 'Student_ID', 'Student_Name', 'App_Number',
      'Status', 'Time', 'Photo_URL', 'Saved_At'
    ]);
    
    // Format header
    const headerRange = sheet.getRange(1, 1, 1, 9);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#4F46E5');
    headerRange.setFontColor('#FFFFFF');
  }

  return sheet;
}

function saveAttendance(records, photoBase64) {
  const sheet = getAttendanceSheet();

  // Check if already saved (locked)
  if (records.length > 0) {
    const firstRecord = records[0];
    const lockCheck = checkBatchLocked(firstRecord.date, firstRecord.batch);
    if (lockCheck.locked) {
      return { success: false, error: 'This batch is already saved and locked.' };
    }
  }

  // Upload photo to Drive
  let photoUrl = '';
  if (photoBase64) {
    photoUrl = uploadPhoto(photoBase64, records[0].date, records[0].batch);
  }

  const savedAt = new Date().toISOString();

  // Append all records
  const rows = records.map(r => [
    r.date,
    r.batch,
    r.studentId,
    r.studentName,
    r.appNumber || '',
    capitalizeFirst(r.status),
    r.time,
    photoUrl,
    savedAt
  ]);

  if (rows.length > 0) {
    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, 9).setValues(rows);
  }

  return {
    success: true,
    message: `Saved ${records.length} records`,
    photoUrl: photoUrl
  };
}

function getAttendance(date, batch) {
  const sheet = getAttendanceSheet();
  const data = sheet.getDataRange().getValues();
  const records = [];

  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === date && data[i][1].toString() === batch) {
      records.push({
        date: data[i][0].toString(),
        batch: data[i][1].toString(),
        studentId: data[i][2].toString(),
        studentName: data[i][3].toString(),
        status: data[i][5].toString().toLowerCase(),
        time: data[i][6].toString(),
        photoUrl: data[i][7].toString()
      });
    }
  }

  return {
    success: true,
    records: records,
    locked: records.length > 0
  };
}

// Get ALL attendance for a date, grouped by batch
function getAllAttendance(date) {
  const sheet = getAttendanceSheet();
  const data = sheet.getDataRange().getValues();
  const batches = {};

  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === date) {
      const batchName = data[i][1].toString();
      // Map batch name to batch key
      let batchKey;
      if (batchName.includes('01') || batchName.includes('5:30')) {
        batchKey = 'batch_01';
      } else {
        batchKey = 'batch_02';
      }

      if (!batches[batchKey]) {
        batches[batchKey] = { records: [], locked: false };
      }

      batches[batchKey].records.push({
        studentId: data[i][2].toString(),
        studentName: data[i][3].toString(),
        status: data[i][5].toString().toLowerCase(),
        time: data[i][6].toString(),
        photoUrl: data[i][7].toString()
      });
      batches[batchKey].locked = true;
    }
  }

  return {
    success: true,
    batches: batches,
    date: date
  };
}

function checkBatchLocked(date, batch) {
  const sheet = getAttendanceSheet();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === date && data[i][1].toString() === batch) {
      return { success: true, locked: true };
    }
  }

  return { success: true, locked: false };
}

function getMergedData(date) {
  const sheet = getAttendanceSheet();
  const data = sheet.getDataRange().getValues();
  const merged = {};

  for (let i = 1; i < data.length; i++) {
    if (data[i][0].toString() === date) {
      const studentId = data[i][2].toString();
      const batch = data[i][1].toString();
      const status = data[i][5].toString().toLowerCase();

      if (!merged[studentId]) {
        merged[studentId] = {
          studentId: studentId,
          studentName: data[i][3].toString(),
          appNumber: data[i][4].toString(),
          batch1Status: '—',
          batch2Status: '—'
        };
      }

      if (batch.includes('01') || batch.includes('5:30')) {
        merged[studentId].batch1Status = status;
      } else {
        merged[studentId].batch2Status = status;
      }
    }
  }

  const result = Object.values(merged).sort((a, b) => 
    a.studentName.localeCompare(b.studentName)
  );

  return {
    success: true,
    data: result,
    date: date
  };
}

// ======= Photo Upload =======

function uploadPhoto(base64Data, date, batch) {
  try {
    // Get or create folder
    let folders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
    let folder;
    if (folders.hasNext()) {
      folder = folders.next();
    } else {
      folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
    }

    // Convert base64 to blob
    const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, '');
    const blob = Utilities.newBlob(
      Utilities.base64Decode(base64Content),
      'image/jpeg',
      `yoga_${date}_${batch.replace(/\s+/g, '_')}_${Date.now()}.jpg`
    );

    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE, DriveApp.Permission.VIEW);

    return file.getUrl();
  } catch (err) {
    console.error('Photo upload error:', err);
    return '';
  }
}

// ======= Upload Photo & Update Sheet =======

function uploadPhotoAndUpdateSheet(date, batch, photoBase64) {
  if (!date || !batch || !photoBase64) {
    return { success: false, error: 'Missing date, batch, or photo data' };
  }

  try {
    // Upload photo to Drive
    var photoUrl = uploadPhoto(photoBase64, date, batch);
    if (!photoUrl) {
      return { success: false, error: 'Photo upload failed' };
    }

    // Update Photo_URL column (column 8) in existing attendance rows for this date+batch
    var sheet = getAttendanceSheet();
    var data = sheet.getDataRange().getValues();
    var updated = 0;

    for (var i = 1; i < data.length; i++) {
      var rowDate = data[i][0].toString();
      var rowBatch = data[i][1].toString();
      if (rowDate === date && rowBatch === batch) {
        sheet.getRange(i + 1, 8).setValue(photoUrl);  // Column 8 = Photo_URL
        updated++;
      }
    }

    return {
      success: true,
      photoUrl: photoUrl,
      updated: updated,
      message: 'Photo uploaded and ' + updated + ' rows updated'
    };
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function getPhotoUrlForBatch(date, batch) {
  if (!date || !batch) {
    return { success: false, error: 'Missing date or batch' };
  }

  var sheet = getAttendanceSheet();
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0].toString() === date && data[i][1].toString() === batch) {
      var url = data[i][7] ? data[i][7].toString() : '';
      if (url) {
        return { success: true, photoUrl: url };
      }
    }
  }

  return { success: true, photoUrl: '' };
}

// ======= Helpers =======

function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
