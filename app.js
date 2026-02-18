// ============================================
// YOGA ATTENDANCE APP — PROFESSIONAL ARCHITECTURE
// EventBus → Store → Renderer → Handlers → API → Storage → Utils
// ============================================

(function () {
    'use strict';

    // =============================================
    // MODULE 1: EVENT BUS — Pub/Sub Communication
    // =============================================
    const EventBus = {
        _handlers: new Map(),

        on(event, fn) {
            if (!this._handlers.has(event)) this._handlers.set(event, new Set());
            this._handlers.get(event).add(fn);
            return () => this.off(event, fn); // return unsubscribe fn
        },

        off(event, fn) {
            const set = this._handlers.get(event);
            if (set) set.delete(fn);
        },

        emit(event, data) {
            const set = this._handlers.get(event);
            if (set) set.forEach(fn => fn(data));
        }
    };

    // =============================================
    // MODULE 2: STORE — Centralized State + DSA
    // =============================================
    const Store = {
        // --- Primary Data (Map-based for O(1)) ---
        studentMap: new Map(),         // Map<id, {id, name, appNumber, active}>
        studentOrder: [],              // Sorted array of IDs for display order

        // attendance[dateKey][batchKey] = Map<studentId, status>
        attendance: {},

        // locked = Set of "dateKey|batchKey" strings for O(1) lock check
        lockedBatches: new Set(),

        // Photo URLs: Map of "dateKey|batchKey" → Google Drive URL
        photoUrls: new Map(),

        // --- UI State ---
        currentDate: '',
        currentBatch: 'batch_01',
        searchQuery: '',
        photo: null,
        photoBase64: null,
        isLoading: false,
        collapsedPiles: {},

        // --- Computed Cache ---
        _cache: { valid: false, visible: [], present: [], absent: [], leave: [] },

        // --- Student Methods ---
        setStudents(students) {
            this.studentMap.clear();
            students.forEach(s => this.studentMap.set(s.id, s));
            this.studentOrder = students.map(s => s.id);
            this._invalidateCache();
            EventBus.emit('students:loaded', { count: students.length });
        },

        getStudent(id) {
            return this.studentMap.get(id) || null;
        },

        getAllStudents() {
            return this.studentOrder.map(id => this.studentMap.get(id));
        },

        // --- Attendance Methods ---
        initDateBatch(dateKey, batchKey) {
            if (!this.attendance[dateKey]) this.attendance[dateKey] = {};
            if (!this.attendance[dateKey][batchKey]) {
                const batchMap = new Map();
                this.studentMap.forEach((s, id) => {
                    batchMap.set(id, CONFIG.STATUSES.LEAVE);
                });
                this.attendance[dateKey][batchKey] = batchMap;
            }
        },

        getStatus(studentId) {
            const dateKey = this.currentDate;
            const batchKey = this.currentBatch;
            const batchData = this.attendance[dateKey]?.[batchKey];
            if (batchData instanceof Map) return batchData.get(studentId) || CONFIG.STATUSES.LEAVE;
            if (batchData) return batchData[studentId] || CONFIG.STATUSES.LEAVE;
            return CONFIG.STATUSES.LEAVE;
        },

        setStatus(studentId, status) {
            const dateKey = this.currentDate;
            const batchKey = this.currentBatch;
            if (!this.attendance[dateKey]) this.attendance[dateKey] = {};
            if (!this.attendance[dateKey][batchKey]) this.attendance[dateKey][batchKey] = new Map();
            const batchData = this.attendance[dateKey][batchKey];
            const oldStatus = (batchData instanceof Map) ? (batchData.get(studentId) || CONFIG.STATUSES.LEAVE) : (batchData[studentId] || CONFIG.STATUSES.LEAVE);
            if (batchData instanceof Map) batchData.set(studentId, status);
            else batchData[studentId] = status;
            this._invalidateCache();
            StorageManager.saveState();
            EventBus.emit('status:changed', { studentId, oldStatus, newStatus: status });
        },

        // --- Batch Lock Methods ---
        lockKey(dateKey, batchKey) { return `${dateKey}|${batchKey}`; },

        isLocked() {
            return this.lockedBatches.has(this.lockKey(this.currentDate, this.currentBatch));
        },

        lockCurrentBatch(photoUrl) {
            const key = this.lockKey(this.currentDate, this.currentBatch);
            this.lockedBatches.add(key);
            if (photoUrl) this.photoUrls.set(key, photoUrl);
            StorageManager.saveState();
            EventBus.emit('batch:locked');
        },

        isDateBatchLocked(dateKey, batchKey) {
            return this.lockedBatches.has(this.lockKey(dateKey, batchKey));
        },

        // --- Cross-Batch Logic (Set for O(1)) ---
        getBatch1PresentSet() {
            if (this.currentBatch !== 'batch_02') return new Set();
            const batchData = this.attendance[this.currentDate]?.['batch_01'];
            if (!batchData) return new Set();
            const presentSet = new Set();
            if (batchData instanceof Map) {
                batchData.forEach((status, id) => { if (status === CONFIG.STATUSES.PRESENT) presentSet.add(id); });
            } else {
                for (const id in batchData) { if (batchData[id] === CONFIG.STATUSES.PRESENT) presentSet.add(id); }
            }
            return presentSet;
        },

        // --- Computed: Visible Students + Piles (cached) ---
        _invalidateCache() { this._cache.valid = false; },

        getComputed() {
            if (this._cache.valid) return this._cache;

            const batch1Present = this.getBatch1PresentSet();
            const q = this.searchQuery.trim().toLowerCase();

            const visible = [];
            const present = [];
            const absent = [];
            const leave = [];

            for (let i = 0; i < this.studentOrder.length; i++) {
                const id = this.studentOrder[i];
                const s = this.studentMap.get(id);
                if (!s || !s.active) continue;

                // Cross-batch filter: skip Batch 1 present students in Batch 2
                if (batch1Present.size > 0 && batch1Present.has(id)) continue;

                // Search filter
                if (q && !s.name.toLowerCase().includes(q) &&
                    !s.appNumber.toLowerCase().includes(q) &&
                    !s.id.toLowerCase().includes(q)) continue;

                visible.push(s);
                const status = this.getStatus(id);
                if (status === CONFIG.STATUSES.PRESENT) present.push(s);
                else if (status === CONFIG.STATUSES.ABSENT) absent.push(s);
                else leave.push(s);
            }

            this._cache = { valid: true, visible, present, absent, leave };
            return this._cache;
        },

        // --- Final Status Logic ---
        getFinalStatus(b1, b2) {
            if (b1 === 'present' || b2 === 'present') return 'present';
            if (b1 === 'absent' || b2 === 'absent') return 'absent';
            return 'leave';
        }
    };

    // =============================================
    // MODULE 3: DOM CACHE
    // =============================================
    const $ = (id) => document.getElementById(id);
    const dom = {};

    function cacheDom() {
        dom.searchInput = $('searchInput');
        dom.refreshBtn = $('refreshBtn');
        dom.menuBtn = $('menuBtn');
        dom.sidebar = $('sidebar');
        dom.sidebarOverlay = $('sidebarOverlay');
        dom.datePicker = $('datePicker');
        dom.batchSelect = $('batchSelect');
        dom.summaryCard = $('summaryCard');
        dom.batchLabel = $('batchLabel');
        dom.presentCount = $('presentCount');
        dom.absentCount = $('absentCount');
        dom.leaveCount = $('leaveCount');
        dom.dateDisplay = $('dateDisplay');
        dom.totalCount = $('totalCount');
        dom.presentList = $('presentList');
        dom.absentList = $('absentList');
        dom.leaveList = $('leaveList');
        dom.presentPileCount = $('presentPileCount');
        dom.absentPileCount = $('absentPileCount');
        dom.leavePileCount = $('leavePileCount');
        dom.loadingState = $('loadingState');
        dom.emptyState = $('emptyState');
        dom.pilesContainer = $('pilesContainer');
        dom.saveBtn = $('saveBtn');
        dom.saveModal = $('saveModal');
        dom.photoUpload = $('photoUpload');
        dom.photoInput = $('photoInput');
        dom.photoPreview = $('photoPreview');
        dom.photoIcon = $('photoIcon');
        dom.photoText = $('photoText');
        dom.photoSubtext = $('photoSubtext');
        dom.confirmSaveBtn = $('confirmSaveBtn');
        dom.saveSummary = $('saveSummary');
        dom.saveModalInfo = $('saveModalInfo');
        dom.toast = $('toast');
        dom.lockedBadge = $('lockedBadge');
        dom.statusPopover = $('statusPopover');
        dom.mergeOverlay = $('mergeOverlay');
        dom.mergeBody = $('mergeBody');
        dom.mergeBackBtn = $('mergeBackBtn');
        dom.mergeTitle = $('mergeTitle');
        dom.exportExcelBtn = $('exportExcelBtn');
        dom.exportPdfBtn = $('exportPdfBtn');
        dom.sidebarMerge = $('sidebarMerge');
        dom.listRefreshBtn = $('listRefreshBtn');
        dom.bottomNav = $('bottomNav');
        dom.saveBar = $('saveBar');
        // Settings
        dom.settingsOverlay = $('settingsOverlay');
        dom.settingsBackBtn = $('settingsBackBtn');
        dom.settingSheetId = $('settingSheetId');
        dom.settingSheetGid = $('settingSheetGid');
        dom.settingApiUrl = $('settingApiUrl');
        dom.saveSettingsBtn = $('saveSettingsBtn');
        dom.clearTodayBtn = $('clearTodayBtn');
        dom.clearAllBtn = $('clearAllBtn');
        dom.sidebarSettings = $('sidebarSettings');
        dom.sidebarAbout = $('sidebarAbout');
        // About
        dom.aboutOverlay = $('aboutOverlay');
        dom.aboutBackBtn = $('aboutBackBtn');
        // Password Modal
        dom.passwordModal = $('passwordModal');
        dom.adminPasswordInput = $('adminPasswordInput');
        dom.passwordError = $('passwordError');
        dom.cancelPasswordBtn = $('cancelPasswordBtn');
        dom.unlockSettingsBtn = $('unlockSettingsBtn');
        // Section
        dom.sectionOverlay = $('sectionOverlay');
        dom.sectionBackBtn = $('sectionBackBtn');
        dom.sectionBody = $('sectionBody');
    }

    // =============================================
    // MODULE 4: UTILS
    // =============================================
    const Utils = {
        formatDateISO(date) {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, '0');
            const d = String(date.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        },

        formatDateDisplay(isoStr) {
            const d = new Date(isoStr + 'T00:00:00');
            return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
        },

        escapeHtml(text) {
            return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        },

        capitalizeStatus(s) {
            if (s === '—') return s;
            return s.charAt(0).toUpperCase() + s.slice(1);
        },

        debounce(fn, delay) {
            let timer;
            return function (...args) {
                clearTimeout(timer);
                timer = setTimeout(() => fn.apply(this, args), delay);
            };
        },

        getInitials(name) {
            const parts = name.trim().split(/\s+/);
            if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
            return name.substring(0, 2).toUpperCase();
        },

        getStatusIcon(status) {
            switch (status) {
                case CONFIG.STATUSES.PRESENT:
                    return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>';
                case CONFIG.STATUSES.ABSENT:
                    return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
                default:
                    return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10" opacity="0.3"/><line x1="8" y1="12" x2="16" y2="12" opacity="0.3"/></svg>';
            }
        }
    };

    // =============================================
    // MODULE 5: STORAGE MANAGER
    // =============================================
    const StorageManager = {
        saveState() {
            try {
                // Convert Maps to plain objects for JSON serialization
                const attObj = {};
                for (const dateKey in Store.attendance) {
                    attObj[dateKey] = {};
                    for (const batchKey in Store.attendance[dateKey]) {
                        const batchData = Store.attendance[dateKey][batchKey];
                        if (batchData instanceof Map) {
                            attObj[dateKey][batchKey] = Object.fromEntries(batchData);
                        } else {
                            attObj[dateKey][batchKey] = batchData;
                        }
                    }
                }
                const data = {
                    attendance: attObj,
                    savedBatches: Array.from(Store.lockedBatches),
                    photoUrls: Object.fromEntries(Store.photoUrls)
                };
                localStorage.setItem(CONFIG.STORAGE_KEYS.ATTENDANCE, JSON.stringify(data));
            } catch (err) {
                console.error('Failed to save state:', err);
            }
        },

        loadState() {
            try {
                const raw = localStorage.getItem(CONFIG.STORAGE_KEYS.ATTENDANCE);
                if (raw) {
                    const data = JSON.parse(raw);
                    // Restore attendance (keep as plain objects, Store.getStatus handles both)
                    Store.attendance = data.attendance || {};
                    // Restore locked batches
                    if (Array.isArray(data.savedBatches)) {
                        Store.lockedBatches = new Set(data.savedBatches);
                    } else if (data.savedBatches && typeof data.savedBatches === 'object') {
                        // Migrate from old format { dateKey: { batchKey: true } }
                        Store.lockedBatches = new Set();
                        for (const dateKey in data.savedBatches) {
                            for (const batchKey in data.savedBatches[dateKey]) {
                                if (data.savedBatches[dateKey][batchKey]) {
                                    Store.lockedBatches.add(Store.lockKey(dateKey, batchKey));
                                }
                            }
                        }
                    }
                    // Restore photo URLs
                    Store.photoUrls = new Map(Object.entries(data.photoUrls || {}));
                }
            } catch (err) {
                console.error('Failed to load state:', err);
            }
        },

        saveRecords(records) {
            try {
                const key = `yoga_records_${Store.currentDate}_${Store.currentBatch}`;
                localStorage.setItem(key, JSON.stringify({
                    records,
                    savedAt: new Date().toISOString(),
                    photoIncluded: !!Store.photoBase64
                }));
            } catch (err) {
                console.error('Failed to save records:', err);
            }
        },

        loadSettings() {
            try {
                const raw = localStorage.getItem('yoga_settings');
                if (raw) {
                    const s = JSON.parse(raw);
                    if (s.sheetId) CONFIG.SHEET_ID = s.sheetId;
                    if (s.sheetGid) CONFIG.SHEET_GID = s.sheetGid;
                    if (s.apiUrl !== undefined) CONFIG.API_URL = s.apiUrl;
                }
            } catch (e) { /* ignore */ }
        },

        saveSettings() {
            localStorage.setItem('yoga_settings', JSON.stringify({
                sheetId: CONFIG.SHEET_ID,
                sheetGid: CONFIG.SHEET_GID,
                apiUrl: CONFIG.API_URL
            }));
        }
    };

    // =============================================
    // MODULE 6: API LAYER
    // =============================================
    const API = {
        fetchStudents() {
            Store.isLoading = true;
            UI.showLoading();

            if (CONFIG.API_URL) {
                this._fetchViaAppsScript();
            } else {
                this._fetchViaJSONP();
            }
        },

        _fetchViaAppsScript() {
            const script = document.createElement('script');
            const callbackName = '_gasCallback_' + Date.now();

            window[callbackName] = (data) => {
                delete window[callbackName];
                document.body.removeChild(script);
                if (data && data.success && data.students) {
                    const students = data.students.map(s => ({
                        id: s.id || '', appNumber: s.appNumber || '', name: s.name || '', active: true
                    }));
                    this._onStudentsLoaded(students);
                } else {
                    this._fetchViaJSONP();
                }
            };

            script.onerror = () => {
                delete window[callbackName];
                document.body.removeChild(script);
                this._fetchViaJSONP();
            };

            script.src = `${CONFIG.API_URL}?action=getStudents&callback=${callbackName}`;
            document.body.appendChild(script);
        },

        _fetchViaJSONP() {
            const callbackName = '_gvizCallback_' + Date.now();
            const script = document.createElement('script');

            window[callbackName] = (response) => {
                delete window[callbackName];
                if (script.parentNode) script.parentNode.removeChild(script);

                try {
                    if (response && response.table && response.table.rows) {
                        const rows = response.table.rows;
                        const students = [];
                        for (let i = 0; i < rows.length; i++) {
                            const cells = rows[i].c;
                            const name = cells[0] && cells[0].v ? String(cells[0].v).trim() : '';
                            const appNumber = cells[1] && cells[1].v ? String(cells[1].v).trim() : '';
                            const id = cells[2] && cells[2].v ? String(cells[2].v).trim() : '';
                            if (name && id) students.push({ name, appNumber, id, active: true });
                        }
                        students.sort((a, b) => a.name.localeCompare(b.name));
                        this._onStudentsLoaded(students);
                    } else {
                        throw new Error('Invalid response format');
                    }
                } catch (err) {
                    console.error('JSONP parse error:', err);
                    UI.showToast('Failed to parse student data', 'error');
                    Store.isLoading = false;
                    UI.hideLoading();
                }
            };

            script.onerror = () => {
                delete window[callbackName];
                if (script.parentNode) script.parentNode.removeChild(script);
                UI.showToast('Failed to load students. Check connection.', 'error');
                Store.isLoading = false;
                UI.hideLoading();
            };

            const url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=responseHandler:${callbackName}&gid=${CONFIG.SHEET_GID}`;
            script.src = url;
            document.body.appendChild(script);
        },

        _onStudentsLoaded(students) {
            Store.isLoading = false;
            UI.hideLoading();
            Store.setStudents(students);
            Store.initDateBatch(Store.currentDate, Store.currentBatch);
            Renderer.renderAll();
            UI.showToast(`${students.length} students loaded`, 'success');
        },

        // --- Cloud Attendance Sync (Google Visualization API JSONP — reliable from file://) ---
        fetchAttendance(date) {
            if (!CONFIG.SHEET_ID) return Promise.resolve(false);

            return new Promise((resolve) => {
                const callbackName = '_attCallback_' + Date.now();
                const script = document.createElement('script');

                const cleanup = () => {
                    delete window[callbackName];
                    if (script.parentNode) script.parentNode.removeChild(script);
                };

                window[callbackName] = (response) => {
                    cleanup();
                    try {
                        if (response && response.table && response.table.rows) {
                            const rows = response.table.rows;
                            if (rows.length === 0) { resolve(false); return; }

                            const dateKey = date;
                            if (!Store.attendance[dateKey]) Store.attendance[dateKey] = {};

                            // Group records by batch
                            const batches = {};
                            for (let i = 0; i < rows.length; i++) {
                                const cells = rows[i].c;
                                const rowDate = cells[0] && cells[0].v ? String(cells[0].v).trim() : '';
                                const batchName = cells[1] && cells[1].v ? String(cells[1].v).trim() : '';
                                const studentId = cells[2] && cells[2].v ? String(cells[2].v).trim() : '';
                                const status = cells[5] && cells[5].v ? String(cells[5].v).trim().toLowerCase() : 'leave';

                                if (!studentId || rowDate !== date) continue;

                                // Map batch name to batch key
                                let batchKey;
                                if (batchName.includes('01') || batchName.includes('5:30')) {
                                    batchKey = 'batch_01';
                                } else {
                                    batchKey = 'batch_02';
                                }

                                if (!batches[batchKey]) batches[batchKey] = [];
                                batches[batchKey].push({ studentId, status });
                            }

                            // Merge into Store
                            for (const batchKey in batches) {
                                const batchMap = new Map();

                                // Set all students to leave first
                                Store.studentMap.forEach((s, id) => {
                                    batchMap.set(id, CONFIG.STATUSES.LEAVE);
                                });

                                // Override with cloud data
                                for (const rec of batches[batchKey]) {
                                    batchMap.set(rec.studentId, rec.status || CONFIG.STATUSES.LEAVE);
                                }

                                Store.attendance[dateKey][batchKey] = batchMap;

                                // Mark batch as locked (cloud has data)
                                const lockKey = Store.lockKey(dateKey, batchKey);
                                Store.lockedBatches.add(lockKey);
                            }

                            Store._invalidateCache();
                            StorageManager.saveState();
                            Renderer.renderAll();
                            resolve(true);
                        } else {
                            resolve(false);
                        }
                    } catch (err) {
                        console.error('Fetch attendance parse error:', err);
                        resolve(false);
                    }
                };

                script.onerror = () => {
                    cleanup();
                    console.error('Fetch attendance error');
                    resolve(false);
                };

                // Timeout after 15 seconds
                setTimeout(() => {
                    if (window[callbackName]) {
                        cleanup();
                        resolve(false);
                    }
                }, 15000);

                // Use Google Visualization API JSONP — reads Attendance sheet directly
                // Reads from Daily Yoga Attendance spreadsheet
                const ATTENDANCE_SHEET_ID = '1Vq1cQgW4Cm7-cC3aKglFhRGwBJu6-ZMnKecrL1nVAxs';
                const tq = encodeURIComponent(`select * where A='${date}'`);
                script.src = `https://docs.google.com/spreadsheets/d/${ATTENDANCE_SHEET_ID}/gviz/tq?tqx=responseHandler:${callbackName}&sheet=Attendance&tq=${tq}`;
                document.body.appendChild(script);
            });
        }
    };

    // =============================================
    // MODULE 7: RENDERER — Targeted DOM Updates
    // =============================================
    const Renderer = {
        _rafId: null,

        // Schedule render on next animation frame (batched)
        scheduleRender() {
            if (this._rafId) return;
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this.renderAll();
            });
        },

        renderAll() {
            const { visible, present, absent, leave } = Store.getComputed();
            const locked = Store.isLocked();

            // Update summary card
            const batchConfig = CONFIG.BATCHES.find(b => b.id === Store.currentBatch);
            dom.batchLabel.textContent = batchConfig.name + ' - ' + batchConfig.time;
            dom.presentCount.textContent = present.length;
            dom.absentCount.textContent = absent.length;
            dom.leaveCount.textContent = `Leave: ${leave.length}`;
            dom.totalCount.textContent = `${visible.length} TOTAL`;
            dom.dateDisplay.textContent = Utils.formatDateDisplay(Store.currentDate);

            // Locked badge
            if (locked) {
                dom.lockedBadge.classList.add('visible');
                dom.saveBtn.textContent = '🔒 Attendance Saved';
                dom.saveBtn.classList.add('save-btn--locked');
                dom.saveBtn.disabled = true;
            } else {
                dom.lockedBadge.classList.remove('visible');
                dom.saveBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save Attendance`;
                dom.saveBtn.classList.remove('save-btn--locked');
                dom.saveBtn.disabled = false;
            }

            // Render piles
            this._renderPile(dom.presentList, present, CONFIG.STATUSES.PRESENT, locked);
            this._renderPile(dom.absentList, absent, CONFIG.STATUSES.ABSENT, locked);
            this._renderPile(dom.leaveList, leave, CONFIG.STATUSES.LEAVE, locked);

            // Pile counts
            dom.presentPileCount.textContent = present.length;
            dom.absentPileCount.textContent = absent.length;
            dom.leavePileCount.textContent = leave.length;

            // Show/hide piles
            $('presentPile').style.display = present.length ? '' : 'none';
            $('absentPile').style.display = absent.length ? '' : 'none';
            $('leavePile').style.display = leave.length ? '' : 'none';

            // Show/hide piles container vs empty state
            if (Store.studentMap.size === 0 && !Store.isLoading) {
                dom.pilesContainer.style.display = 'none';
                dom.emptyState.style.display = '';
            } else {
                dom.pilesContainer.style.display = '';
                dom.emptyState.style.display = 'none';
            }
        },

        _renderPile(container, students, pileStatus, locked) {
            const fragment = document.createDocumentFragment();
            const lockedClass = locked ? ' student-card--locked' : '';

            for (let i = 0; i < students.length; i++) {
                const s = students[i];
                const div = document.createElement('div');
                div.className = `student-card student-card--${pileStatus}${lockedClass} fade-in`;
                div.dataset.studentId = s.id;
                div.dataset.status = pileStatus;
                div.innerHTML = `
                    <div class="student-card__avatar student-card__avatar--${pileStatus}">${Utils.getInitials(s.name)}</div>
                    <div class="student-card__info">
                        <div class="student-card__name">${Utils.escapeHtml(s.name)}</div>
                        <div class="student-card__id">${Utils.escapeHtml(s.appNumber || s.id)}</div>
                    </div>
                    <div class="student-card__status student-card__status--${pileStatus}">
                        ${Utils.getStatusIcon(pileStatus)}
                    </div>
                `;
                fragment.appendChild(div);
            }

            container.innerHTML = '';
            container.appendChild(fragment);
        }
    };

    // =============================================
    // MODULE 8: UI HELPERS
    // =============================================
    const UI = {
        _toastTimer: null,
        _toastHideTimer: null,

        showLoading() {
            dom.loadingState.style.display = '';
            dom.pilesContainer.style.display = 'none';
            dom.emptyState.style.display = 'none';
        },

        hideLoading() {
            dom.loadingState.style.display = 'none';
        },

        showToast(msg, type = 'info') {
            clearTimeout(this._toastTimer);
            clearTimeout(this._toastHideTimer);
            dom.toast.className = 'toast';
            dom.toast.textContent = msg;
            void dom.toast.offsetWidth;
            dom.toast.className = `toast toast--${type} visible`;
            this._toastTimer = setTimeout(() => {
                dom.toast.classList.add('hiding');
                dom.toast.classList.remove('visible');
                this._toastHideTimer = setTimeout(() => {
                    dom.toast.className = 'toast';
                }, 450);
            }, 1800);
        }
    };

    // =============================================
    // MODULE 9: EVENT HANDLERS
    // =============================================
    const Handlers = {
        // Double-tap state
        _lastTapTime: 0,
        _lastTapStudentId: null,
        _singleTapTimer: null,

        onDateChange() {
            Store.currentDate = dom.datePicker.value;
            Store.initDateBatch(Store.currentDate, Store.currentBatch);
            Store._invalidateCache();
            Renderer.renderAll();
            // Fetch cloud data for the selected date
            API.fetchAttendance(Store.currentDate);
        },

        onBatchChange() {
            Store.currentBatch = dom.batchSelect.value;
            Store.initDateBatch(Store.currentDate, Store.currentBatch);
            Store._invalidateCache();
            Renderer.renderAll();
        },

        onSearch: Utils.debounce(() => {
            Store.searchQuery = dom.searchInput.value;
            Store._invalidateCache();
            Renderer.scheduleRender();
        }, 150),

        onRefresh() {
            dom.refreshBtn.classList.add('spin');
            setTimeout(() => dom.refreshBtn.classList.remove('spin'), 600);
            API.fetchStudents();
            API.fetchAttendance(Store.currentDate).then(ok => {
                if (ok) UI.showToast('Attendance synced from cloud ☁️', 'success');
            });
        },

        onStudentClick(e) {
            const card = e.target.closest('.student-card');
            if (!card || Store.isLocked()) return;

            const studentId = card.dataset.studentId;
            const currentStatus = card.dataset.status;
            const now = Date.now();

            // Double-tap detection (within 250ms on same student)
            if (Handlers._lastTapStudentId === studentId && (now - Handlers._lastTapTime) < 250) {
                clearTimeout(Handlers._singleTapTimer);
                Handlers._lastTapStudentId = null;
                Handlers._lastTapTime = 0;

                if (navigator.vibrate) navigator.vibrate(30);

                if (currentStatus === CONFIG.STATUSES.ABSENT) {
                    Store.setStatus(studentId, CONFIG.STATUSES.LEAVE);
                    UI.showToast('Moved to Leave', 'info');
                } else {
                    Store.setStatus(studentId, CONFIG.STATUSES.ABSENT);
                    UI.showToast('Marked Absent', 'error');
                }
                Renderer.renderAll();
                return;
            }

            Handlers._lastTapStudentId = studentId;
            Handlers._lastTapTime = now;

            clearTimeout(Handlers._singleTapTimer);
            Handlers._singleTapTimer = setTimeout(() => {
                Handlers._lastTapStudentId = null;
                Handlers._lastTapTime = 0;

                if (currentStatus === CONFIG.STATUSES.LEAVE) {
                    Store.setStatus(studentId, CONFIG.STATUSES.PRESENT);
                    UI.showToast('Marked Present', 'success');
                } else if (currentStatus === CONFIG.STATUSES.PRESENT) {
                    Store.setStatus(studentId, CONFIG.STATUSES.LEAVE);
                    UI.showToast('Moved to Leave', 'info');
                } else if (currentStatus === CONFIG.STATUSES.ABSENT) {
                    Store.setStatus(studentId, CONFIG.STATUSES.LEAVE);
                    UI.showToast('Moved to Leave', 'info');
                }
                Renderer.renderAll();
            }, 250);
        },

        onPileToggle(e) {
            const chevron = e.currentTarget.querySelector('.pile-header__chevron');
            const list = e.currentTarget.nextElementSibling;
            if (list.classList.contains('collapsed')) {
                list.classList.remove('collapsed');
                list.style.maxHeight = list.scrollHeight + 'px';
                chevron.classList.remove('collapsed');
            } else {
                list.classList.add('collapsed');
                chevron.classList.add('collapsed');
            }
        },

        // --- Save Flow ---
        onSaveClick() {
            if (Store.isLocked()) return;
            Store.photo = null;
            Store.photoBase64 = null;
            dom.photoPreview.style.display = 'none';
            dom.photoIcon.style.display = '';
            dom.photoText.textContent = 'Tap to capture or upload photo';
            dom.photoSubtext.textContent = 'Photo is compulsory for saving';
            dom.photoUpload.classList.remove('has-photo');
            dom.confirmSaveBtn.disabled = true;

            const { visible, present, absent, leave } = Store.getComputed();
            const batchConfig = CONFIG.BATCHES.find(b => b.id === Store.currentBatch);

            dom.saveModalInfo.textContent = `Upload a photo as proof before saving attendance for ${batchConfig.name}.`;
            dom.saveSummary.innerHTML = `
                <strong>📅 ${Utils.formatDateDisplay(Store.currentDate)}</strong><br>
                <strong>🧘 ${batchConfig.name} — ${batchConfig.time}</strong><br><br>
                ✅ Present: <strong>${present.length}</strong><br>
                ❌ Absent: <strong>${absent.length}</strong><br>
                🔘 Leave: <strong>${leave.length}</strong><br>
                📊 Total: <strong>${visible.length}</strong>
            `;
            dom.saveModal.classList.add('active');
        },

        onPhotoSelected(e) {
            const file = e.target.files[0];
            if (!file) return;
            Store.photo = file;
            ImageUtils.compress(file, (base64) => {
                Store.photoBase64 = base64;
                dom.photoPreview.src = base64;
                dom.photoPreview.style.display = '';
                dom.photoIcon.style.display = 'none';
                dom.photoText.textContent = 'Photo captured ✓';
                dom.photoSubtext.textContent = 'Tap to change';
                dom.photoUpload.classList.add('has-photo');
                dom.confirmSaveBtn.disabled = false;
            });
        },

        async onConfirmSave() {
            if (!Store.photoBase64) {
                UI.showToast('Photo is required!', 'error');
                return;
            }
            dom.confirmSaveBtn.disabled = true;
            dom.confirmSaveBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0;"></div> Saving...';

            const { visible } = Store.getComputed();
            const batchConfig = CONFIG.BATCHES.find(b => b.id === Store.currentBatch);
            const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

            const records = visible.map(s => ({
                date: Store.currentDate,
                batch: batchConfig.name,
                batchTime: batchConfig.time,
                studentId: s.id,
                studentName: s.name,
                appNumber: s.appNumber,
                status: Store.getStatus(s.id),
                time: timeStr
            }));

            let photoUrl = null;
            let cloudSaved = false;

            if (CONFIG.API_URL) {
                try {
                    UI.showToast('📤 Saving to Google Sheet...', 'info');

                    // Build compact records string: id:status:name:appNum|...
                    const statusMap = { present: 'p', absent: 'a', leave: 'l' };
                    const compactRecords = records.map(r => {
                        const id = encodeURIComponent(r.studentId);
                        const s = statusMap[r.status] || 'l';
                        const name = encodeURIComponent(r.studentName);
                        const app = encodeURIComponent(r.appNumber || '');
                        return `${id}:${s}:${name}:${app}`;
                    }).join('|');

                    const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });

                    // Use JSONP (script tag) — 100% CORS-proof, same as student loading
                    const result = await new Promise((resolve, reject) => {
                        const cbName = '_saveCallback_' + Date.now();
                        const script = document.createElement('script');

                        const cleanup = () => {
                            delete window[cbName];
                            if (script.parentNode) script.parentNode.removeChild(script);
                        };

                        window[cbName] = (data) => {
                            cleanup();
                            resolve(data);
                        };

                        script.onerror = () => {
                            cleanup();
                            reject(new Error('Save request failed'));
                        };

                        // Timeout after 30 seconds
                        setTimeout(() => {
                            if (window[cbName]) {
                                cleanup();
                                reject(new Error('Save timeout'));
                            }
                        }, 30000);

                        const params = [
                            `action=saveViaGet`,
                            `date=${encodeURIComponent(Store.currentDate)}`,
                            `batch=${encodeURIComponent(batchConfig.name)}`,
                            `time=${encodeURIComponent(timeStr)}`,
                            `records=${encodeURIComponent(compactRecords)}`,
                            `callback=${cbName}`
                        ].join('&');

                        script.src = `${CONFIG.API_URL}?${params}`;
                        document.body.appendChild(script);
                    });

                    if (result.success) {
                        cloudSaved = true;
                        UI.showToast(`✅ Saved to Google Sheet! (${result.saved || ''} records)`, 'success');
                    } else {
                        UI.showToast('❌ Sheet error: ' + (result.error || 'Unknown'), 'error');
                    }

                    // Try to upload photo separately via no-cors POST (best effort)
                    if (cloudSaved && Store.photoBase64) {
                        try {
                            await fetch(CONFIG.API_URL, {
                                method: 'POST',
                                body: JSON.stringify({
                                    action: 'uploadPhoto',
                                    date: Store.currentDate,
                                    batch: batchConfig.name,
                                    photo: Store.photoBase64
                                }),
                                headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                                mode: 'no-cors'
                            });
                        } catch (photoErr) {
                            console.log('Photo upload skipped (CORS)', photoErr.message);
                        }
                    }
                } catch (err) {
                    console.error('Cloud save error:', err);
                    UI.showToast('❌ Cloud save failed! ' + err.message, 'error');
                }
            }

            if (cloudSaved || !CONFIG.API_URL) {
                // Lock batch only if cloud saved OR no cloud configured
                Store.lockCurrentBatch(photoUrl);
                StorageManager.saveRecords(records);
                dom.saveModal.classList.remove('active');
                Renderer.renderAll();
                if (!CONFIG.API_URL) {
                    UI.showToast('Attendance saved locally! ✅', 'success');
                }
            } else {
                // Cloud failed — save locally but DON'T lock (allow retry)
                StorageManager.saveRecords(records);
                dom.saveModal.classList.remove('active');
                Renderer.renderAll();
                UI.showToast('⚠️ Data saved locally. Cloud save failed — try again.', 'error');
            }

            dom.confirmSaveBtn.disabled = false;
            dom.confirmSaveBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg> Confirm & Save';
        },

        // --- Popover ---
        _popoverStudentId: null,

        onPopoverAction(e) {
            const action = e.currentTarget.dataset.action;
            if (Handlers._popoverStudentId && !Store.isLocked()) {
                Store.setStatus(Handlers._popoverStudentId, action);
                dom.statusPopover.classList.remove('active');
                Handlers._popoverStudentId = null;
                Renderer.renderAll();
            }
        },

        // --- Bottom Nav ---
        onBottomNavClick(e) {
            const item = e.currentTarget;
            const tab = item.dataset.tab;
            dom.bottomNav.querySelectorAll('.bottom-nav__item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            switch (tab) {
                case 'home': MergeView.close(); break;
                case 'report': MergeView.open(); break;
                case 'section': SectionView.open(); break;
                case 'sync':
                    Handlers.onRefresh();
                    UI.showToast('Syncing students + attendance...', 'info');
                    break;
            }
        },

        // --- Settings (Password Protected) ---
        _ADMIN_PASS: 'Vaibhav@#2613',
        _isAdminAuthenticated: false,

        openSettings() {
            if (!this._isAdminAuthenticated) {
                // Show password modal
                dom.adminPasswordInput.value = '';
                dom.passwordError.textContent = '';
                dom.passwordModal.style.display = 'flex';
                setTimeout(() => dom.adminPasswordInput.focus(), 300);
                return;
            }
            this._showSettings();
        },

        _showSettings() {
            dom.settingSheetId.value = CONFIG.SHEET_ID || '';
            dom.settingSheetGid.value = CONFIG.SHEET_GID || '';
            dom.settingApiUrl.value = CONFIG.API_URL || '';
            dom.settingsOverlay.classList.add('active');
        },

        _onUnlockSettings() {
            const pass = dom.adminPasswordInput.value;
            if (pass === Handlers._ADMIN_PASS) {
                Handlers._isAdminAuthenticated = true;
                dom.passwordModal.style.display = 'none';
                Handlers._showSettings();
            } else {
                dom.passwordError.textContent = '❌ Incorrect password!';
                dom.adminPasswordInput.style.borderColor = '#EF4444';
                dom.adminPasswordInput.style.animation = 'shake 0.4s ease';
                setTimeout(() => {
                    dom.adminPasswordInput.style.animation = '';
                    dom.adminPasswordInput.style.borderColor = 'var(--border)';
                }, 500);
            }
        },

        openAbout() {
            dom.aboutOverlay.classList.add('active');
        },

        onSaveSettings() {
            const newSheetId = dom.settingSheetId.value.trim();
            const newGid = dom.settingSheetGid.value.trim();
            const newApiUrl = dom.settingApiUrl.value.trim();
            if (newSheetId) CONFIG.SHEET_ID = newSheetId;
            if (newGid) CONFIG.SHEET_GID = newGid;
            CONFIG.API_URL = newApiUrl;
            StorageManager.saveSettings();
            UI.showToast('Settings saved ✓', 'success');
            dom.settingsOverlay.classList.remove('active');
            API.fetchStudents();
        },

        onClearToday() {
            if (!confirm('Clear today\'s attendance data? This cannot be undone.')) return;
            const dateKey = Store.currentDate;
            delete Store.attendance[dateKey];
            Store.lockedBatches.forEach(k => { if (k.startsWith(dateKey + '|')) Store.lockedBatches.delete(k); });
            StorageManager.saveState();
            Store.initDateBatch(Store.currentDate, Store.currentBatch);
            Store._invalidateCache();
            Renderer.renderAll();
            UI.showToast('Today\'s data cleared', 'info');
        },

        onClearAll() {
            if (!confirm('Clear ALL local attendance data? This cannot be undone!')) return;
            Store.attendance = {};
            Store.lockedBatches.clear();
            localStorage.removeItem(CONFIG.STORAGE_KEYS.ATTENDANCE);
            Store.initDateBatch(Store.currentDate, Store.currentBatch);
            Store._invalidateCache();
            Renderer.renderAll();
            UI.showToast('All local data cleared', 'info');
        }
    };

    // =============================================
    // MODULE 10: IMAGE UTILS
    // =============================================
    const ImageUtils = {
        compress(file, callback) {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let w = img.width, h = img.height;
                    if (w > CONFIG.PHOTO.MAX_WIDTH) { h = (CONFIG.PHOTO.MAX_WIDTH / w) * h; w = CONFIG.PHOTO.MAX_WIDTH; }
                    if (h > CONFIG.PHOTO.MAX_HEIGHT) { w = (CONFIG.PHOTO.MAX_HEIGHT / h) * w; h = CONFIG.PHOTO.MAX_HEIGHT; }
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    const base64 = canvas.toDataURL('image/jpeg', CONFIG.PHOTO.QUALITY);
                    callback(base64);
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        }
    };

    // =============================================
    // MODULE 11: MERGE VIEW
    // =============================================
    const MergeView = {
        open() {
            const dateKey = Store.currentDate;
            const batch1Data = Store.attendance[dateKey]?.['batch_01'];
            const batch2Data = Store.attendance[dateKey]?.['batch_02'];

            if (!batch1Data && !batch2Data) {
                UI.showToast('No attendance data for today', 'error');
                return;
            }

            dom.mergeTitle.textContent = `Merged — ${Utils.formatDateDisplay(Store.currentDate)}`;

            // Build merged data with single-pass counting
            const students = Store.getAllStudents();
            const merged = [];
            let b1Present = 0, b1Absent = 0, b2Present = 0, b2Absent = 0;
            let finalPresent = 0, finalAbsent = 0, finalLeave = 0;

            const getVal = (data, id) => {
                if (!data) return '—';
                if (data instanceof Map) return data.get(id) || 'leave';
                return data[id] || 'leave';
            };

            for (let i = 0; i < students.length; i++) {
                const s = students[i];
                const b1 = getVal(batch1Data, s.id);
                const b2 = getVal(batch2Data, s.id);
                const finalStatus = (b1 !== '—' || b2 !== '—')
                    ? Store.getFinalStatus(b1 === '—' ? 'leave' : b1, b2 === '—' ? 'leave' : b2)
                    : '—';

                // Single-pass counting
                if (b1 === 'present') b1Present++;
                else if (b1 === 'absent') b1Absent++;
                if (b2 === 'present') b2Present++;
                else if (b2 === 'absent') b2Absent++;
                if (finalStatus === 'present') finalPresent++;
                else if (finalStatus === 'absent') finalAbsent++;
                else if (finalStatus === 'leave') finalLeave++;

                merged.push({ name: s.name, appNumber: s.appNumber, id: s.id, batch1Status: b1, batch2Status: b2, finalStatus });
            }

            merged.sort((a, b) => a.name.localeCompare(b.name));

            // Build table
            let tableHTML = '<table class="merge-table"><thead><tr><th>#</th><th>Student Name</th><th>B1 (5:30)</th><th>B2 (6:00)</th><th>Final</th></tr></thead><tbody>';
            for (let i = 0; i < merged.length; i++) {
                const s = merged[i];
                tableHTML += `<tr><td>${i + 1}</td><td><div style="font-weight:600;font-size:0.8rem;">${Utils.escapeHtml(s.name)}</div><div style="font-size:0.68rem;color:var(--text-muted);">${Utils.escapeHtml(s.appNumber)}</div></td><td><span class="status-pill status-pill--${s.batch1Status}">${Utils.capitalizeStatus(s.batch1Status)}</span></td><td><span class="status-pill status-pill--${s.batch2Status}">${Utils.capitalizeStatus(s.batch2Status)}</span></td><td><span class="status-pill status-pill--${s.finalStatus}" style="font-weight:700;">${Utils.capitalizeStatus(s.finalStatus)}</span></td></tr>`;
            }
            tableHTML += '</tbody></table>';

            dom.mergeBody.innerHTML = `
                <div style="display:flex;gap:8px;margin-bottom:12px;">
                    <div style="flex:1;background:var(--present-bg);border-radius:12px;padding:10px;text-align:center;"><div style="font-size:0.65rem;color:var(--present);font-weight:600;text-transform:uppercase;">B1 Present</div><div style="font-size:1.3rem;font-weight:800;color:var(--present);">${b1Present}</div></div>
                    <div style="flex:1;background:var(--absent-bg);border-radius:12px;padding:10px;text-align:center;"><div style="font-size:0.65rem;color:var(--absent);font-weight:600;text-transform:uppercase;">B1 Absent</div><div style="font-size:1.3rem;font-weight:800;color:var(--absent);">${b1Absent}</div></div>
                    <div style="flex:1;background:var(--present-bg);border-radius:12px;padding:10px;text-align:center;"><div style="font-size:0.65rem;color:var(--present);font-weight:600;text-transform:uppercase;">B2 Present</div><div style="font-size:1.3rem;font-weight:800;color:var(--present);">${b2Present}</div></div>
                    <div style="flex:1;background:var(--absent-bg);border-radius:12px;padding:10px;text-align:center;"><div style="font-size:0.65rem;color:var(--absent);font-weight:600;text-transform:uppercase;">B2 Absent</div><div style="font-size:1.3rem;font-weight:800;color:var(--absent);">${b2Absent}</div></div>
                </div>
                <div style="display:flex;gap:8px;margin-bottom:16px;padding:12px;background:linear-gradient(135deg,#4F46E5,#7C3AED);border-radius:12px;color:white;">
                    <div style="flex:1;text-align:center;"><div style="font-size:0.65rem;font-weight:600;text-transform:uppercase;opacity:0.85;">Final Present</div><div style="font-size:1.5rem;font-weight:800;">${finalPresent}</div></div>
                    <div style="flex:1;text-align:center;"><div style="font-size:0.65rem;font-weight:600;text-transform:uppercase;opacity:0.85;">Final Absent</div><div style="font-size:1.5rem;font-weight:800;">${finalAbsent}</div></div>
                    <div style="flex:1;text-align:center;"><div style="font-size:0.65rem;font-weight:600;text-transform:uppercase;opacity:0.85;">Final Leave</div><div style="font-size:1.5rem;font-weight:800;">${finalLeave}</div></div>
                </div>
                ${tableHTML}
            `;
            dom.mergeOverlay.classList.add('active');
        },

        close() {
            dom.mergeOverlay.classList.remove('active');
        },

        getMergedExportData() {
            const dateKey = Store.currentDate;
            const batch1Data = Store.attendance[dateKey]?.['batch_01'];
            const batch2Data = Store.attendance[dateKey]?.['batch_02'];

            const getVal = (data, id) => {
                if (!data) return '—';
                if (data instanceof Map) return data.get(id) || 'leave';
                return data[id] || 'leave';
            };

            return Store.getAllStudents()
                .map(s => {
                    const b1 = getVal(batch1Data, s.id);
                    const b2 = getVal(batch2Data, s.id);
                    const final = (b1 !== '—' || b2 !== '—') ? Store.getFinalStatus(b1 === '—' ? 'leave' : b1, b2 === '—' ? 'leave' : b2) : '—';
                    return {
                        'Sr. No.': 0, 'Student Name': s.name, 'App Number': s.appNumber,
                        'Student ID': s.id, 'Batch 1 (5:30 AM)': Utils.capitalizeStatus(b1),
                        'Batch 2 (6:00 AM)': Utils.capitalizeStatus(b2),
                        'Final Status': Utils.capitalizeStatus(final), 'Date': Store.currentDate
                    };
                })
                .sort((a, b) => a['Student Name'].localeCompare(b['Student Name']))
                .map((row, i) => ({ ...row, 'Sr. No.': i + 1 }));
        },

        exportExcel() {
            try {
                const data = this.getMergedExportData();
                const dateKey = Store.currentDate;
                const b1PhotoUrl = Store.photoUrls.get(`${dateKey}|batch_01`) || '';
                const b2PhotoUrl = Store.photoUrls.get(`${dateKey}|batch_02`) || '';

                const ws = XLSX.utils.json_to_sheet(data);
                ws['!cols'] = [{ wch: 6 }, { wch: 30 }, { wch: 15 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 15 }, { wch: 12 }];
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'Attendance');

                // Add Photo Links sheet
                const photoData = [];
                if (b1PhotoUrl) photoData.push({ 'Batch': 'Batch 01 (5:30 AM)', 'Photo Proof Link': b1PhotoUrl });
                if (b2PhotoUrl) photoData.push({ 'Batch': 'Batch 02 (6:00 AM)', 'Photo Proof Link': b2PhotoUrl });
                if (photoData.length > 0) {
                    const psWs = XLSX.utils.json_to_sheet(photoData);
                    psWs['!cols'] = [{ wch: 22 }, { wch: 60 }];
                    // Add hyperlink formatting
                    photoData.forEach((_, i) => {
                        const cell = psWs[XLSX.utils.encode_cell({ r: i + 1, c: 1 })];
                        if (cell) cell.l = { Target: cell.v, Tooltip: 'Click to view photo proof' };
                    });
                    XLSX.utils.book_append_sheet(wb, psWs, 'Photo Proofs');
                }

                XLSX.writeFile(wb, `Yoga_Attendance_${Store.currentDate}.xlsx`);
                UI.showToast('Excel downloaded ✓', 'success');
            } catch (err) {
                console.error('Excel export error:', err);
                UI.showToast('Excel export failed', 'error');
            }
        },

        exportPdf() {
            try {
                const { jsPDF } = window.jspdf;
                const doc = new jsPDF('l', 'mm', 'a4');
                doc.setFontSize(16);
                doc.setFont(undefined, 'bold');
                doc.text('Yoga Attendance Report', 14, 15);
                doc.setFontSize(10);
                doc.setFont(undefined, 'normal');
                doc.text(`Date: ${Utils.formatDateDisplay(Store.currentDate)}`, 14, 22);

                // Photo proof links below the title — styled with border, bold font, and number
                const dateKey = Store.currentDate;
                const b1PhotoUrl = Store.photoUrls.get(`${dateKey}|batch_01`) || '';
                const b2PhotoUrl = Store.photoUrls.get(`${dateKey}|batch_02`) || '';
                let photoY = 22;
                if (b1PhotoUrl || b2PhotoUrl) {
                    photoY += 4;
                    let photoNum = 1;

                    const drawPhotoBox = (label, url) => {
                        // Draw bordered box
                        doc.setDrawColor(79, 70, 229);
                        doc.setLineWidth(0.5);
                        doc.roundedRect(14, photoY - 4, 120, 8, 1.5, 1.5, 'S');

                        // Number badge (filled circle with number)
                        doc.setFillColor(79, 70, 229);
                        doc.circle(19, photoY, 2.5, 'F');
                        doc.setFontSize(7);
                        doc.setFont(undefined, 'bold');
                        doc.setTextColor(255, 255, 255);
                        doc.text(String(photoNum), 19, photoY + 0.8, { align: 'center' });

                        // Link text
                        doc.setFontSize(9);
                        doc.setFont(undefined, 'bold');
                        doc.setTextColor(79, 70, 229);
                        doc.textWithLink(label + ' - Photo Proof (click to view)', 24, photoY + 0.5, { url });

                        photoNum++;
                        photoY += 10;
                    };

                    if (b1PhotoUrl) drawPhotoBox('Batch 1 (5:30 AM)', b1PhotoUrl);
                    if (b2PhotoUrl) drawPhotoBox('Batch 2 (6:00 AM)', b2PhotoUrl);

                    doc.setTextColor(0, 0, 0);
                    doc.setFont(undefined, 'normal');
                }

                const data = this.getMergedExportData();
                const tableData = data.map(row => [row['Sr. No.'], row['Student Name'], row['App Number'], row['Batch 1 (5:30 AM)'], row['Batch 2 (6:00 AM)'], row['Final Status']]);

                doc.autoTable({
                    startY: photoY + 4,
                    head: [['#', 'Student Name', 'App Number', 'Batch 1 (5:30)', 'Batch 2 (6:00)', 'Final Status']],
                    body: tableData,
                    theme: 'grid',
                    styles: { fontSize: 8, cellPadding: 3 },
                    headStyles: { fillColor: [79, 70, 229], textColor: 255, fontStyle: 'bold' },
                    alternateRowStyles: { fillColor: [248, 250, 252] },
                    columnStyles: {
                        0: { halign: 'center', cellWidth: 10 }, 1: { cellWidth: 55 }, 2: { cellWidth: 30 },
                        3: { halign: 'center', cellWidth: 25 }, 4: { halign: 'center', cellWidth: 25 },
                        5: { halign: 'center', cellWidth: 25, fontStyle: 'bold' }
                    }
                });

                doc.save(`Yoga_Attendance_${Store.currentDate}.pdf`);
                UI.showToast('PDF downloaded ✓', 'success');
            } catch (err) {
                console.error('PDF export error:', err);
                UI.showToast('PDF export failed', 'error');
            }
        }
    };

    // =============================================
    // MODULE 12: SECTION VIEW
    // =============================================
    const SectionView = {
        open() {
            const dateKey = Store.currentDate;
            const batch1Data = Store.attendance[dateKey]?.['batch_01'];
            const batch2Data = Store.attendance[dateKey]?.['batch_02'];
            const b1Locked = Store.isDateBatchLocked(dateKey, 'batch_01');
            const b2Locked = Store.isDateBatchLocked(dateKey, 'batch_02');

            const getStats = (data) => {
                if (!data) return { present: 0, absent: 0, leave: 0 };
                let p = 0, a = 0, l = 0;
                const iter = (data instanceof Map) ? data.values() : Object.values(data);
                for (const status of iter) {
                    if (status === 'present') p++;
                    else if (status === 'absent') a++;
                    else l++;
                }
                return { present: p, absent: a, leave: l };
            };

            const b1 = getStats(batch1Data);
            const b2 = getStats(batch2Data);

            dom.sectionBody.innerHTML = `
                <div style="margin-bottom:8px;font-size:0.78rem;color:var(--text-secondary);font-weight:600;">📅 ${Utils.formatDateDisplay(Store.currentDate)}</div>
                <div style="background:linear-gradient(135deg,#4F46E5,#6366F1);border-radius:16px;padding:20px;margin-bottom:16px;color:white;box-shadow:0 4px 15px rgba(79,70,229,0.3);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                        <div style="font-weight:700;font-size:1rem;">🧘 Batch 01 — 5:30 AM</div>
                        <div style="background:${b1Locked ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.15)'};padding:4px 10px;border-radius:8px;font-size:0.7rem;font-weight:600;">${b1Locked ? '🔒 Locked' : '🔓 Open'}</div>
                    </div>
                    <div style="display:flex;gap:10px;">
                        <div style="flex:1;background:rgba(255,255,255,0.15);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:0.65rem;opacity:0.8;text-transform:uppercase;font-weight:600;">Present</div><div style="font-size:1.5rem;font-weight:800;">${b1.present}</div></div>
                        <div style="flex:1;background:rgba(255,255,255,0.15);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:0.65rem;opacity:0.8;text-transform:uppercase;font-weight:600;">Absent</div><div style="font-size:1.5rem;font-weight:800;">${b1.absent}</div></div>
                        <div style="flex:1;background:rgba(255,255,255,0.15);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:0.65rem;opacity:0.8;text-transform:uppercase;font-weight:600;">Leave</div><div style="font-size:1.5rem;font-weight:800;">${b1.leave}</div></div>
                    </div>
                </div>
                <div style="background:linear-gradient(135deg,#7C3AED,#A78BFA);border-radius:16px;padding:20px;margin-bottom:16px;color:white;box-shadow:0 4px 15px rgba(124,58,237,0.3);">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                        <div style="font-weight:700;font-size:1rem;">🧘 Batch 02 — 6:00 AM</div>
                        <div style="background:${b2Locked ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.15)'};padding:4px 10px;border-radius:8px;font-size:0.7rem;font-weight:600;">${b2Locked ? '🔒 Locked' : '🔓 Open'}</div>
                    </div>
                    <div style="display:flex;gap:10px;">
                        <div style="flex:1;background:rgba(255,255,255,0.15);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:0.65rem;opacity:0.8;text-transform:uppercase;font-weight:600;">Present</div><div style="font-size:1.5rem;font-weight:800;">${b2.present}</div></div>
                        <div style="flex:1;background:rgba(255,255,255,0.15);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:0.65rem;opacity:0.8;text-transform:uppercase;font-weight:600;">Absent</div><div style="font-size:1.5rem;font-weight:800;">${b2.absent}</div></div>
                        <div style="flex:1;background:rgba(255,255,255,0.15);border-radius:10px;padding:10px;text-align:center;"><div style="font-size:0.65rem;opacity:0.8;text-transform:uppercase;font-weight:600;">Leave</div><div style="font-size:1.5rem;font-weight:800;">${b2.leave}</div></div>
                    </div>
                </div>
                <div style="background:var(--surface);border-radius:16px;padding:16px;box-shadow:var(--shadow-sm);">
                    <div style="font-weight:700;font-size:0.9rem;margin-bottom:12px;color:var(--text);">⚡ Quick Actions</div>
                    <div style="display:flex;gap:8px;">
                        <button onclick="document.getElementById('batchSelect').value='batch_01';document.getElementById('batchSelect').dispatchEvent(new Event('change'));document.getElementById('sectionOverlay').classList.remove('active');" style="flex:1;padding:12px;background:var(--primary-light);color:var(--primary);border:none;border-radius:12px;font-weight:700;font-size:0.8rem;cursor:pointer;">Go to Batch 1</button>
                        <button onclick="document.getElementById('batchSelect').value='batch_02';document.getElementById('batchSelect').dispatchEvent(new Event('change'));document.getElementById('sectionOverlay').classList.remove('active');" style="flex:1;padding:12px;background:#EDE9FE;color:#7C3AED;border:none;border-radius:12px;font-weight:700;font-size:0.8rem;cursor:pointer;">Go to Batch 2</button>
                    </div>
                </div>
            `;
            dom.sectionOverlay.classList.add('active');
        },

        close() {
            dom.sectionOverlay.classList.remove('active');
        }
    };

    // =============================================
    // MODULE 13: SIDEBAR
    // =============================================
    window.openSidebar = function () {
        dom.sidebar.classList.add('open');
        dom.sidebarOverlay.classList.add('active');
    };

    window.closeSidebar = function () {
        dom.sidebar.classList.remove('open');
        dom.sidebarOverlay.classList.remove('active');
    };

    // =============================================
    // MODULE 14: EVENT BINDING
    // =============================================
    function bindEvents() {
        dom.datePicker.addEventListener('change', Handlers.onDateChange);
        dom.batchSelect.addEventListener('change', Handlers.onBatchChange);
        dom.searchInput.addEventListener('input', Handlers.onSearch);
        dom.refreshBtn.addEventListener('click', Handlers.onRefresh);
        dom.listRefreshBtn.addEventListener('click', Handlers.onRefresh);

        // Student clicks (delegated)
        dom.presentList.addEventListener('click', Handlers.onStudentClick);
        dom.absentList.addEventListener('click', Handlers.onStudentClick);
        dom.leaveList.addEventListener('click', Handlers.onStudentClick);

        // Piles
        document.querySelectorAll('.pile-header').forEach(el => el.addEventListener('click', Handlers.onPileToggle));

        // Save
        dom.saveBtn.addEventListener('click', Handlers.onSaveClick);
        dom.photoUpload.addEventListener('click', () => dom.photoInput.click());
        dom.photoInput.addEventListener('change', Handlers.onPhotoSelected);
        dom.confirmSaveBtn.addEventListener('click', Handlers.onConfirmSave);
        dom.saveModal.addEventListener('click', (e) => { if (e.target === dom.saveModal) dom.saveModal.classList.remove('active'); });

        // Popover
        dom.statusPopover.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', Handlers.onPopoverAction));
        document.addEventListener('click', (e) => { if (!dom.statusPopover.contains(e.target)) dom.statusPopover.classList.remove('active'); });

        // Sidebar
        dom.menuBtn.addEventListener('click', openSidebar);
        dom.sidebarOverlay.addEventListener('click', closeSidebar);
        dom.sidebarMerge.addEventListener('click', () => { closeSidebar(); MergeView.open(); });

        // Settings
        dom.sidebarSettings.addEventListener('click', () => { closeSidebar(); Handlers.openSettings(); });
        dom.sidebarAbout.addEventListener('click', () => { closeSidebar(); Handlers.openAbout(); });
        dom.settingsBackBtn.addEventListener('click', () => dom.settingsOverlay.classList.remove('active'));
        dom.aboutBackBtn.addEventListener('click', () => dom.aboutOverlay.classList.remove('active'));

        // Password Modal
        dom.unlockSettingsBtn.addEventListener('click', Handlers._onUnlockSettings);
        dom.cancelPasswordBtn.addEventListener('click', () => dom.passwordModal.style.display = 'none');
        dom.adminPasswordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') Handlers._onUnlockSettings(); });
        dom.saveSettingsBtn.addEventListener('click', Handlers.onSaveSettings);
        dom.clearTodayBtn.addEventListener('click', Handlers.onClearToday);
        dom.clearAllBtn.addEventListener('click', Handlers.onClearAll);

        // Section
        dom.sectionBackBtn.addEventListener('click', SectionView.close);

        // Merge exports
        dom.mergeBackBtn.addEventListener('click', MergeView.close);
        dom.exportExcelBtn.addEventListener('click', () => MergeView.exportExcel());
        dom.exportPdfBtn.addEventListener('click', () => MergeView.exportPdf());

        // Bottom nav
        dom.bottomNav.querySelectorAll('.bottom-nav__item').forEach(item => item.addEventListener('click', Handlers.onBottomNavClick));
    }

    // =============================================
    // MODULE 15: BOOT
    // =============================================
    function init() {
        cacheDom();
        StorageManager.loadSettings();
        StorageManager.loadState();
        Store.currentDate = Utils.formatDateISO(new Date());
        dom.datePicker.value = Store.currentDate;
        bindEvents();
        API.fetchStudents();

        // Auto-sync attendance from cloud on load (multi-device support)
        UI.showToast('☁️ Syncing attendance...', 'info');
        API.fetchAttendance(Store.currentDate).then(ok => {
            if (ok) {
                UI.showToast('✅ Attendance synced from cloud!', 'success');
            } else {
                UI.showToast('📋 Ready — no cloud data for today', 'info');
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }


})();
