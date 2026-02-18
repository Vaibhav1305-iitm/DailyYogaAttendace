// ============================================
// YOGA ATTENDANCE APP — CONFIGURATION
// ============================================

const CONFIG = {
  // === Google Apps Script Web App URL ===
  // After deploying your Apps Script, paste the URL here
  API_URL: 'https://script.google.com/macros/s/AKfycbxdtc7wOwGPBrFDs89CDZI-3wVAN1BqYkkTNxYrQW60oU9nW0HF9UUX8Bqvu82p0bkK/exec',

  // === Google Sheet Details ===
  // Source sheet (student list)
  SHEET_ID: '1g8J61vJLWh_sP0by9biJVACR0EGtC8XGlft9mmHLkps',
  SHEET_GID: '1897721584',

  // Destination sheet (attendance data storage)
  SAVE_SHEET_ID: '1Vq1cQgW4Cm7-cC3aKglFhRGwBJu6-ZMnKecrL1nVAxs',

  // === Column Mapping (from Google Sheet) ===
  COLUMNS: {
    FULL_NAME: 'Full Name',
    APP_NUMBER: 'Application: Application Number',
    APP_ID: 'Application: ID'
  },

  // === Batch Definitions ===
  BATCHES: [
    { id: 'batch_01', name: 'Batch 01', time: '5:30 AM', shortName: 'B1 (5:30)' },
    { id: 'batch_02', name: 'Batch 02', time: '6:00 AM', shortName: 'B2 (6:00)' }
  ],

  // === Status Definitions ===
  STATUSES: {
    LEAVE: 'leave',
    PRESENT: 'present',
    ABSENT: 'absent'
  },

  // === Photo Compression ===
  PHOTO: {
    MAX_WIDTH: 1024,
    MAX_HEIGHT: 1024,
    QUALITY: 0.7
  },

  // === LocalStorage Keys ===
  STORAGE_KEYS: {
    ATTENDANCE: 'yoga_attendance_data',
    SETTINGS: 'yoga_settings'
  }
};
