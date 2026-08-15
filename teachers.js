// ============================================================
//  teachers.js  —  نظام حسابات المدرسين
//  Teacher Account Management System
//
//  يُدير:
//    - بيانات المدرسين (الاسم، المادة، الصفوف، المجموعات)
//    - جداول الحصص الأسبوعية
//    - تسجيل حضور المدرسين يومياً
//    - حساب المستحقات تلقائياً
//    - سجل المدفوعات
//
//  التخزين: IndexedDB عبر StorageEngine
//    - teachers       : بيانات المدرسين
//    - teacherSessions: جلسات/حصص المدرسين الأسبوعية
//    - teacherLogs    : سجل حضور المدرس (تسجيل كل حصة)
//    - teacherPayouts : سجل المدفوعات للمدرسين
// ============================================================

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────
  let _teachers     = [];
  let _sessions     = [];  // الحصص الأسبوعية المجدولة
  let _logs         = [];  // سجل الحضور الفعلي
  let _payouts      = [];  // سجل المدفوعات
  let _activeTeacherId = null;
  let _dateFilter   = 'week'; // 'today' | 'week' | 'month' | 'custom'
  let _customFrom   = null;
  let _customTo     = null;

  const ARABIC_DAYS = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const DAY_KEYS    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // ─── Storage helpers ──────────────────────────────────────

  async function loadAll() {
    if (typeof StorageEngine === 'undefined') return;
    _teachers = await _safeGetAll('teachers');
    _sessions  = await _safeGetAll('teacherSessions');
    _logs      = await _safeGetAll('teacherLogs');
    _payouts   = await _safeGetAll('teacherPayouts');
  }

  async function _safeGetAll(store) {
    try {
      // Ensure the store exists (older DBs may not have it)
      if (!StorageEngine.db || !StorageEngine.db.objectStoreNames.contains(store)) {
        await _ensureTeacherStores();
      }
      return await StorageEngine.getAll(store);
    } catch (e) {
      console.warn('[teachers.js] getAll failed for', store, e);
      return [];
    }
  }

  async function _ensureTeacherStores() {
    return new Promise((resolve) => {
      if (!StorageEngine.db) return resolve();
      const needed = ['teachers','teacherSessions','teacherLogs','teacherPayouts'];
      const existing = Array.from(StorageEngine.db.objectStoreNames);
      const missing = needed.filter(n => !existing.includes(n));
      if (missing.length === 0) return resolve();

      const version = StorageEngine.db.version + 1;
      StorageEngine.db.close();
      const req = indexedDB.open('EduMasterLargeDB', version);
      req.onupgradeneeded = (e) => {
        const db2 = e.target.result;
        missing.forEach(n => {
          if (!db2.objectStoreNames.contains(n))
            db2.createObjectStore(n, { keyPath: 'id' });
        });
      };
      req.onsuccess = (e) => {
        StorageEngine.db = e.target.result;
        resolve();
      };
      req.onerror = () => resolve();
    });
  }

  async function saveStore(store, data) {
    await _ensureTeacherStores();
    if (!Array.isArray(data)) data = [data];
    if (data.length === 0) return;
    await StorageEngine.save(store, data);
  }

  async function deleteFromStore(store, id) {
    await _ensureTeacherStores();
    await StorageEngine.delete(store, id);
  }

  // ─── Section initializer (called from showSection) ────────

  async function initTeachersSection() {
    await loadAll();
    renderTeachersGrid();
    _activeTeacherId = null;
  }

  // ══════════════════════════════════════════════════════════
  //  RENDER — قائمة المدرسين
  // ══════════════════════════════════════════════════════════

  function renderTeachersGrid() {
    const container = document.getElementById('teachers-grid');
    if (!container) return;

    const search = (document.getElementById('teachers-search')?.value || '').toLowerCase().trim();
    let list = _teachers.filter(t =>
      !search || t.name.toLowerCase().includes(search)
    );

    if (list.length === 0) {
      container.innerHTML = `
        <div style="grid-column:1/-1; text-align:center; padding:3rem; color:var(--text-muted);">
          <i class="fas fa-chalkboard-teacher" style="font-size:3rem;opacity:0.3;display:block;margin-bottom:1rem;"></i>
          <p style="font-size:1.1rem;">لا يوجد مدرسون مضافون حتى الآن.</p>
          <button class="btn btn-primary" onclick="TeachersModule.showAddTeacherModal()"
            style="margin-top:1rem; border-radius:12px; padding:0.7rem 2rem;">
            <i class="fas fa-plus"></i> أضف مدرسًا الآن
          </button>
        </div>`;
      return;
    }

    container.innerHTML = list.map(t => {
      const todayLogs = _getTodayLogs(t.id);
      const attendedToday = todayLogs.filter(l => l.status === 'attended').length;
      const pendingToday  = todayLogs.filter(l => l.status === 'pending').length;
      const totalDue = _calcDue(t.id);
      const totalPaid = _payouts.filter(p => p.teacherId === t.id).reduce((s, p) => s + (p.amount || 0), 0);
      const remaining = Math.max(0, totalDue - totalPaid);

      // Grade tags
      const gradeTags = (t.assignments || []).map(a => {
        const gl = typeof gradeLabel === 'function' ? gradeLabel(a.grade) : a.grade;
        return `<span style="background:var(--bg-light);border-radius:8px;padding:2px 8px;font-size:0.72rem;font-weight:600;color:var(--primary);">${gl}</span>`;
      }).join(' ');

      return `
        <div class="teacher-card" onclick="TeachersModule.openTeacherAccount(${t.id})" style="
          background:var(--bg-white); border-radius:18px; padding:1.4rem;
          box-shadow:0 2px 12px rgba(0,0,0,0.07); cursor:pointer; transition:all 0.2s;
          border:1.5px solid transparent; position:relative; overflow:hidden;">
          <div style="position:absolute;top:0;right:0;width:4px;height:100%;background:linear-gradient(180deg,#4f46e5,#7c3aed);border-radius:0 18px 18px 0;"></div>
          <div style="display:flex;align-items:center;gap:0.8rem;margin-bottom:1rem;">
            <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#7c3aed);
              display:flex;align-items:center;justify-content:center;color:white;font-weight:800;font-size:1.2rem;flex-shrink:0;">
              ${t.name.charAt(0)}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:800;font-size:1rem;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(t.name)}</div>
              <div style="font-size:0.82rem;color:var(--text-muted);">${_esc(t.subject || 'لا توجد مادة')}</div>
            </div>
            <div style="display:flex;gap:6px;">
              <button onclick="event.stopPropagation();TeachersModule.showEditTeacherModal(${t.id})"
                style="width:30px;height:30px;border:none;border-radius:8px;background:var(--bg-light);cursor:pointer;color:var(--primary);">
                <i class="fas fa-edit" style="font-size:0.75rem;"></i>
              </button>
              <button onclick="event.stopPropagation();TeachersModule.deleteTeacher(${t.id})"
                style="width:30px;height:30px;border:none;border-radius:8px;background:#fef2f2;cursor:pointer;color:#ef4444;">
                <i class="fas fa-trash" style="font-size:0.75rem;"></i>
              </button>
            </div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:0.9rem;">${gradeTags || '<span style="font-size:0.75rem;color:var(--text-muted);">لا توجد صفوف</span>'}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.5rem;text-align:center;">
            <div style="background:var(--bg-light);border-radius:10px;padding:0.5rem;">
              <div style="font-size:1.1rem;font-weight:800;color:#16a34a;">${attendedToday}</div>
              <div style="font-size:0.68rem;color:var(--text-muted);">حضر اليوم</div>
            </div>
            <div style="background:var(--bg-light);border-radius:10px;padding:0.5rem;">
              <div style="font-size:1.1rem;font-weight:800;color:#f59e0b;">${pendingToday}</div>
              <div style="font-size:0.68rem;color:var(--text-muted);">معلّق</div>
            </div>
            <div style="background:var(--bg-light);border-radius:10px;padding:0.5rem;">
              <div style="font-size:1.1rem;font-weight:800;color:${remaining > 0 ? '#ef4444' : '#16a34a'};">${remaining.toLocaleString('ar-EG')}</div>
              <div style="font-size:0.68rem;color:var(--text-muted);">متبقي (ج)</div>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ══════════════════════════════════════════════════════════
  //  MODAL — إضافة / تعديل مدرس
  // ══════════════════════════════════════════════════════════

  function showAddTeacherModal(editId = null) {
    const teacher = editId ? _teachers.find(t => t.id === editId) : null;
    const assignments = teacher?.assignments || [{ grade: '', groupId: '', pricePerSession: '' }];
    const scheduleItems = teacher ? _sessions.filter(s => s.teacherId === editId) : [];

    const modal = _createModal('teacher-form-modal', `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem;">
        <h2 style="margin:0;color:var(--primary);font-size:1.2rem;font-weight:800;">
          <i class="fas fa-chalkboard-teacher" style="margin-left:8px;"></i>
          ${editId ? 'تعديل بيانات المدرس' : 'إضافة مدرس جديد'}
        </h2>
        <button onclick="_closeModal('teacher-form-modal')" style="background:var(--bg-light);border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;"><i class="fas fa-times"></i></button>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.2rem;">
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">اسم المدرس *</label>
          <input id="t-name" type="text" class="form-input" value="${_esc(teacher?.name || '')}" placeholder="مثال: أحمد محمد">
        </div>
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">المادة *</label>
          <input id="t-subject" type="text" class="form-input" value="${_esc(teacher?.subject || '')}" placeholder="مثال: الفيزياء">
        </div>
      </div>

      <!-- الصفوف والمجموعات وسعر الحصة -->
      <div style="margin-bottom:1.2rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.7rem;">
          <label style="font-weight:700;font-size:0.9rem;">الصفوف والمجموعات وسعر الحصة</label>
          <button onclick="TeachersModule._addAssignmentRow()" style="background:var(--primary);color:white;border:none;border-radius:8px;padding:4px 12px;cursor:pointer;font-size:0.8rem;">
            <i class="fas fa-plus"></i> إضافة صف/مجموعة
          </button>
        </div>
        <div id="t-assignments-list">
          ${assignments.map((a, i) => _assignmentRowHTML(a, i)).join('')}
        </div>
      </div>

      <!-- الجدول الأسبوعي -->
      <div style="margin-bottom:1.5rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.7rem;">
          <label style="font-weight:700;font-size:0.9rem;">الجدول الأسبوعي</label>
          <button onclick="TeachersModule._addScheduleRow()" style="background:var(--primary);color:white;border:none;border-radius:8px;padding:4px 12px;cursor:pointer;font-size:0.8rem;">
            <i class="fas fa-plus"></i> إضافة حصة
          </button>
        </div>
        <div id="t-schedule-list">
          ${scheduleItems.length ? scheduleItems.map((s, i) => _scheduleRowHTML(s, i)).join('') : _scheduleRowHTML(null, 0)}
        </div>
      </div>

      <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
        <button onclick="_closeModal('teacher-form-modal')" class="btn" style="background:var(--bg-light);border:1px solid var(--border);">إلغاء</button>
        <button onclick="TeachersModule._saveTeacher(${editId || 'null'})" class="btn btn-primary" style="border-radius:10px;padding:0.6rem 2rem;">
          <i class="fas fa-save"></i> حفظ
        </button>
      </div>
    `);

    document.body.appendChild(modal);
    // Update group dropdowns when grade changes
    _bindAssignmentGradeListeners();
  }

  function showEditTeacherModal(id) {
    showAddTeacherModal(id);
  }

  function _assignmentRowHTML(a = {}, i = 0) {
    const gradeOptions = _buildGradeOptions(a.grade || '');
    const groupOptions = _buildGroupOptions(a.grade || '', a.groupId || '');
    return `
      <div class="t-assignment-row" data-index="${i}" style="display:grid;grid-template-columns:1fr 1fr 1fr 36px;gap:0.5rem;margin-bottom:0.5rem;align-items:center;">
        <select class="form-input t-grade-sel" style="font-size:0.85rem;" onchange="TeachersModule._onGradeChange(this,${i})">
          <option value="">اختر الصف</option>
          ${gradeOptions}
        </select>
        <select class="form-input t-group-sel" style="font-size:0.85rem;" data-rowindex="${i}">
          <option value="">اختر المجموعة</option>
          ${groupOptions}
        </select>
        <input type="number" class="form-input t-price-inp" min="0" placeholder="سعر الحصة (ج)" style="font-size:0.85rem;" value="${a.pricePerSession || ''}">
        <button onclick="this.closest('.t-assignment-row').remove()" style="background:#fef2f2;border:none;border-radius:8px;height:38px;width:36px;cursor:pointer;color:#ef4444;">
          <i class="fas fa-minus"></i>
        </button>
      </div>`;
  }

  function _scheduleRowHTML(s = null, i = 0) {
    const dayOptions = DAY_KEYS.map((k, idx) =>
      `<option value="${k}" ${s?.day === k ? 'selected' : ''}>${ARABIC_DAYS[idx]}</option>`
    ).join('');
    const gradeOptions = _buildGradeOptions(s?.grade || '');
    const groupOptions = _buildGroupOptions(s?.grade || '', s?.groupId || '');
    return `
      <div class="t-schedule-row" style="display:grid;grid-template-columns:1fr 100px 100px 1fr 1fr 36px;gap:0.5rem;margin-bottom:0.5rem;align-items:center;">
        <select class="form-input" style="font-size:0.82rem;">
          ${dayOptions}
        </select>
        <input type="time" class="form-input" style="font-size:0.82rem;" value="${s?.timeFrom || '16:00'}">
        <input type="time" class="form-input" style="font-size:0.82rem;" value="${s?.timeTo || '17:30'}">
        <select class="form-input t-sched-grade" style="font-size:0.82rem;" onchange="TeachersModule._onSchedGradeChange(this)">
          <option value="">الصف</option>
          ${gradeOptions}
        </select>
        <select class="form-input t-sched-group" style="font-size:0.82rem;">
          <option value="">المجموعة</option>
          ${groupOptions}
        </select>
        <button onclick="this.closest('.t-schedule-row').remove()" style="background:#fef2f2;border:none;border-radius:8px;height:38px;width:36px;cursor:pointer;color:#ef4444;">
          <i class="fas fa-minus"></i>
        </button>
      </div>`;
  }

  function _addAssignmentRow() {
    const list = document.getElementById('t-assignments-list');
    if (!list) return;
    const i = list.querySelectorAll('.t-assignment-row').length;
    list.insertAdjacentHTML('beforeend', _assignmentRowHTML({}, i));
    _bindAssignmentGradeListeners();
  }

  function _addScheduleRow() {
    const list = document.getElementById('t-schedule-list');
    if (!list) return;
    const i = list.querySelectorAll('.t-schedule-row').length;
    list.insertAdjacentHTML('beforeend', _scheduleRowHTML(null, i));
  }

  function _onGradeChange(sel, rowIndex) {
    const row = sel.closest('.t-assignment-row');
    if (!row) return;
    const grpSel = row.querySelector('.t-group-sel');
    if (!grpSel) return;
    grpSel.innerHTML = '<option value="">اختر المجموعة</option>' + _buildGroupOptions(sel.value, '');
  }

  function _onSchedGradeChange(sel) {
    const row = sel.closest('.t-schedule-row');
    if (!row) return;
    const grpSel = row.querySelector('.t-sched-group');
    if (!grpSel) return;
    grpSel.innerHTML = '<option value="">المجموعة</option>' + _buildGroupOptions(sel.value, '');
  }

  function _bindAssignmentGradeListeners() {
    document.querySelectorAll('.t-grade-sel').forEach((sel, i) => {
      sel.onchange = function() { _onGradeChange(this, i); };
    });
  }

  async function _saveTeacher(editId) {
    const name    = document.getElementById('t-name')?.value.trim();
    const subject = document.getElementById('t-subject')?.value.trim();

    if (!name) return showNotification('يرجى إدخال اسم المدرس', 'error');
    if (!subject) return showNotification('يرجى إدخال المادة', 'error');

    // جمع الصفوف والمجموعات
    const assignments = [];
    document.querySelectorAll('.t-assignment-row').forEach(row => {
      const grade = row.querySelector('.t-grade-sel')?.value;
      const groupId = row.querySelector('.t-group-sel')?.value;
      const pricePerSession = parseFloat(row.querySelector('.t-price-inp')?.value) || 0;
      if (grade) assignments.push({ grade, groupId: groupId || null, pricePerSession });
    });

    // جمع الجدول الأسبوعي
    const scheduleRows = [];
    document.querySelectorAll('.t-schedule-row').forEach(row => {
      const cells = row.querySelectorAll('select, input[type="time"]');
      if (cells.length < 5) return;
      const day      = cells[0].value;
      const timeFrom = cells[1].value;
      const timeTo   = cells[2].value;
      const grade    = cells[3].value;
      const groupId  = cells[4].value;
      if (day) scheduleRows.push({ day, timeFrom, timeTo, grade, groupId: groupId || null });
    });

    const teacherId = editId || Date.now();

    // حذف الجلسات القديمة إذا كان تعديلاً
    if (editId) {
      _sessions = _sessions.filter(s => s.teacherId !== editId);
      // delete old sessions from DB
      const oldKeys = (await _safeGetAll('teacherSessions'))
        .filter(s => s.teacherId === editId)
        .map(s => s.id);
      for (const k of oldKeys) await deleteFromStore('teacherSessions', k);
    }

    // حفظ الجلسات الجديدة
    const newSessions = scheduleRows.map(s => ({
      id: Date.now() + Math.random(),
      teacherId,
      ...s
    }));
    _sessions = [..._sessions, ...newSessions];
    if (newSessions.length > 0) await saveStore('teacherSessions', newSessions);

    if (editId) {
      const idx = _teachers.findIndex(t => t.id === editId);
      if (idx !== -1) _teachers[idx] = { ..._teachers[idx], name, subject, assignments };
    } else {
      _teachers.push({ id: teacherId, name, subject, assignments, createdAt: new Date().toISOString() });
    }
    await saveStore('teachers', _teachers);

    _closeModal('teacher-form-modal');
    renderTeachersGrid();
    showNotification(editId ? '✅ تم تعديل بيانات المدرس' : '✅ تم إضافة المدرس بنجاح', 'success');
    if (typeof RBAC !== 'undefined') RBAC.log('teacher_save', name);
  }

  async function deleteTeacher(id) {
    if (!confirm('هل أنت متأكد من حذف هذا المدرس وكل بياناته؟')) return;
    _teachers = _teachers.filter(t => t.id !== id);
    await deleteFromStore('teachers', id);
    _sessions = _sessions.filter(s => s.teacherId !== id);
    const sessIds = (await _safeGetAll('teacherSessions')).filter(s => s.teacherId === id).map(s => s.id);
    for (const k of sessIds) await deleteFromStore('teacherSessions', k);
    renderTeachersGrid();
    showNotification('✅ تم حذف المدرس', 'success');
  }

  // ══════════════════════════════════════════════════════════
  //  حساب المدرس — Teacher Account View
  // ══════════════════════════════════════════════════════════

  function openTeacherAccount(teacherId) {
    _activeTeacherId = teacherId;
    const teacher = _teachers.find(t => t.id === teacherId);
    if (!teacher) return;

    const accountEl = document.getElementById('teacher-account-view');
    const gridEl    = document.getElementById('teachers-grid-view');
    if (accountEl) accountEl.style.display = 'block';
    if (gridEl)    gridEl.style.display = 'none';

    renderTeacherAccount(teacher);
  }

  function backToTeachersList() {
    _activeTeacherId = null;
    const accountEl = document.getElementById('teacher-account-view');
    const gridEl    = document.getElementById('teachers-grid-view');
    if (accountEl) accountEl.style.display = 'none';
    if (gridEl)    gridEl.style.display = 'block';
    renderTeachersGrid();
  }

  function renderTeacherAccount(teacher) {
    const el = document.getElementById('teacher-account-content');
    if (!el) return;

    const { from, to } = _getDateRange(_dateFilter, _customFrom, _customTo);
    const filteredLogs = _logs.filter(l => l.teacherId === teacher.id && _inRange(l.date, from, to));

    const attendedLogs  = filteredLogs.filter(l => l.status === 'attended');
    const absentLogs    = filteredLogs.filter(l => l.status === 'absent');
    const postponedLogs = filteredLogs.filter(l => l.status === 'postponed');

    const totalDue   = _calcDue(teacher.id, from, to);
    const totalPaid  = _payouts.filter(p => p.teacherId === teacher.id && _inRange(p.date, from, to))
                               .reduce((s, p) => s + (p.amount || 0), 0);
    const remaining  = Math.max(0, totalDue - totalPaid);

    // Today's scheduled sessions
    const todayKey = DAY_KEYS[new Date().getDay()];
    const todaySessions = _sessions.filter(s => s.teacherId === teacher.id && s.day === todayKey);
    const today = new Date().toISOString().split('T')[0];
    const todayLogsAll = _logs.filter(l => l.teacherId === teacher.id && l.date?.startsWith(today));

    // Breakdown by assignment
    const breakdown = (teacher.assignments || []).map(a => {
      const price = a.pricePerSession || 0;
      const gl = typeof gradeLabel === 'function' ? gradeLabel(a.grade) : a.grade;
      const grp = a.groupId ? (db?.groups?.find(g => String(g.id) === String(a.groupId))?.name || 'مجموعة') : 'كل المجموعات';
      const count = attendedLogs.filter(l => l.grade === a.grade && (String(l.groupId) === String(a.groupId) || (!l.groupId && !a.groupId))).length;
      return { label: `${gl} — ${grp}`, price, count, subtotal: count * price };
    });

    el.innerHTML = `
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap;">
        <button onclick="TeachersModule.backToTeachersList()" style="background:var(--bg-light);border:1px solid var(--border);border-radius:10px;padding:0.5rem 1rem;cursor:pointer;font-weight:700;">
          <i class="fas fa-arrow-right"></i> رجوع
        </button>
        <div style="flex:1;">
          <h2 style="margin:0;font-size:1.3rem;font-weight:800;color:var(--primary);">${_esc(teacher.name)}</h2>
          <span style="color:var(--text-muted);font-size:0.88rem;">${_esc(teacher.subject || '')}</span>
        </div>
        <button onclick="TeachersModule.showAddTeacherModal(${teacher.id})" style="background:var(--bg-light);border:1px solid var(--border);border-radius:10px;padding:0.5rem 1rem;cursor:pointer;">
          <i class="fas fa-edit"></i> تعديل
        </button>
        <button onclick="TeachersModule.showPayoutModal(${teacher.id})" style="background:linear-gradient(135deg,#16a34a,#15803d);color:white;border:none;border-radius:10px;padding:0.5rem 1.2rem;cursor:pointer;font-weight:700;">
          <i class="fas fa-hand-holding-usd"></i> صرف مستحقات
        </button>
      </div>

      <!-- فلتر الفترة -->
      <div style="display:flex;gap:0.5rem;margin-bottom:1.5rem;flex-wrap:wrap;align-items:center;">
        ${['today','week','month','custom'].map(k => `
          <button onclick="TeachersModule.setFilter('${k}')" style="
            padding:0.4rem 0.9rem;border-radius:20px;border:1.5px solid var(--border);cursor:pointer;font-size:0.82rem;font-weight:700;
            background:${_dateFilter===k?'var(--primary)':'var(--bg-white)'};
            color:${_dateFilter===k?'white':'var(--text-muted)'};">
            ${{'today':'اليوم','week':'الأسبوع','month':'الشهر','custom':'مخصص'}[k]}
          </button>`).join('')}
        ${_dateFilter === 'custom' ? `
          <input type="date" id="custom-from" value="${_customFrom||''}" onchange="TeachersModule.setCustomRange()" style="border-radius:8px;border:1px solid var(--border);padding:4px 8px;font-size:0.82rem;">
          <span>→</span>
          <input type="date" id="custom-to" value="${_customTo||''}" onchange="TeachersModule.setCustomRange()" style="border-radius:8px;border:1px solid var(--border);padding:4px 8px;font-size:0.82rem;">
        ` : ''}
      </div>

      <!-- إحصائيات رئيسية -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.8rem;margin-bottom:1.5rem;">
        ${[
          { label:'حصص حضر', val: attendedLogs.length, color:'#16a34a', icon:'fas fa-check-circle' },
          { label:'غائب', val: absentLogs.length, color:'#ef4444', icon:'fas fa-times-circle' },
          { label:'مؤجّل', val: postponedLogs.length, color:'#f59e0b', icon:'fas fa-clock' },
          { label:'إجمالي المستحقات', val: totalDue.toLocaleString('ar-EG') + ' ج', color:'#4f46e5', icon:'fas fa-coins' },
          { label:'المدفوع', val: totalPaid.toLocaleString('ar-EG') + ' ج', color:'#0ea5e9', icon:'fas fa-hand-holding-usd' },
          { label:'المتبقي', val: remaining.toLocaleString('ar-EG') + ' ج', color: remaining > 0 ? '#ef4444' : '#16a34a', icon:'fas fa-wallet' },
        ].map(s => `
          <div style="background:var(--bg-white);border-radius:14px;padding:1rem;text-align:center;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
            <i class="${s.icon}" style="color:${s.color};font-size:1.3rem;display:block;margin-bottom:6px;"></i>
            <div style="font-size:1.2rem;font-weight:800;color:${s.color};">${s.val}</div>
            <div style="font-size:0.72rem;color:var(--text-muted);">${s.label}</div>
          </div>`).join('')}
      </div>

      <!-- حصص اليوم -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.5rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calendar-day" style="margin-left:6px;"></i> حصص اليوم
        </h3>
        ${todaySessions.length === 0 ? '<p style="color:var(--text-muted);font-size:0.85rem;">لا توجد حصص مجدولة اليوم.</p>' :
          todaySessions.map(s => {
            const log = todayLogsAll.find(l => l.sessionId === s.id);
            const gl  = typeof gradeLabel === 'function' ? gradeLabel(s.grade) : s.grade;
            const grp = s.groupId ? (db?.groups?.find(g => String(g.id) === String(s.groupId))?.name || 'مجموعة') : 'عام';
            const statusLabels = { attended: '<span style="color:#16a34a;font-weight:700;">✓ حضر</span>', absent: '<span style="color:#ef4444;font-weight:700;">✕ غائب</span>', postponed: '<span style="color:#f59e0b;font-weight:700;">⏸ مؤجّل</span>', cancelled: '<span style="color:#6b7280;font-weight:700;">✕ ملغي</span>' };
            return `
              <div style="display:flex;align-items:center;gap:0.8rem;padding:0.8rem;border:1.5px solid var(--border);border-radius:12px;margin-bottom:0.5rem;flex-wrap:wrap;">
                <div style="flex:1;min-width:150px;">
                  <span style="font-weight:700;font-size:0.88rem;">${ARABIC_DAYS[DAY_KEYS.indexOf(s.day)]} ${s.timeFrom}–${s.timeTo}</span>
                  <br><span style="font-size:0.78rem;color:var(--text-muted);">${gl} — ${grp}</span>
                </div>
                <div style="flex:1;text-align:center;">${log ? (statusLabels[log.status] || '') : '<span style="color:var(--text-muted);font-size:0.8rem;">لم يُسجَّل</span>'}</div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button onclick="TeachersModule.logSession(${teacher.id},'${s.id}','attended','${s.grade}','${s.groupId||''}')" style="padding:4px 10px;border:none;border-radius:8px;background:#dcfce7;color:#16a34a;cursor:pointer;font-weight:700;font-size:0.78rem;">✓ حضر</button>
                  <button onclick="TeachersModule.logSession(${teacher.id},'${s.id}','absent','${s.grade}','${s.groupId||''}')" style="padding:4px 10px;border:none;border-radius:8px;background:#fef2f2;color:#ef4444;cursor:pointer;font-weight:700;font-size:0.78rem;">✕ غياب</button>
                  <button onclick="TeachersModule.logSession(${teacher.id},'${s.id}','postponed','${s.grade}','${s.groupId||''}')" style="padding:4px 10px;border:none;border-radius:8px;background:#fefce8;color:#f59e0b;cursor:pointer;font-weight:700;font-size:0.78rem;">تأجيل</button>
                  <button onclick="TeachersModule.logSession(${teacher.id},'${s.id}','cancelled','${s.grade}','${s.groupId||''}')" style="padding:4px 10px;border:none;border-radius:8px;background:#f8fafc;color:#6b7280;cursor:pointer;font-weight:700;font-size:0.78rem;">إلغاء</button>
                </div>
              </div>`;
          }).join('')}
      </div>

      <!-- تفصيل المستحقات -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.5rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calculator" style="margin-left:6px;"></i> تفصيل المستحقات
        </h3>
        <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
          <thead>
            <tr style="background:var(--bg-light);">
              <th style="padding:8px 12px;text-align:right;border-radius:8px 0 0 8px;">الصف / المجموعة</th>
              <th style="padding:8px 12px;text-align:center;">سعر الحصة</th>
              <th style="padding:8px 12px;text-align:center;">عدد الحصص</th>
              <th style="padding:8px 12px;text-align:left;border-radius:0 8px 8px 0;">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            ${breakdown.map(b => `
              <tr style="border-bottom:1px solid var(--bg-light);">
                <td style="padding:8px 12px;font-weight:600;">${_esc(b.label)}</td>
                <td style="padding:8px 12px;text-align:center;">${b.price.toLocaleString('ar-EG')} ج</td>
                <td style="padding:8px 12px;text-align:center;font-weight:700;">${b.count}</td>
                <td style="padding:8px 12px;text-align:left;font-weight:800;color:var(--primary);">${b.subtotal.toLocaleString('ar-EG')} ج</td>
              </tr>`).join('')}
            <tr style="background:var(--bg-light);font-weight:800;">
              <td colspan="3" style="padding:10px 12px;border-radius:8px 0 0 8px;">الإجمالي</td>
              <td style="padding:10px 12px;text-align:left;color:var(--primary);border-radius:0 8px 8px 0;font-size:1rem;">${totalDue.toLocaleString('ar-EG')} ج</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- الجدول الأسبوعي -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;margin-bottom:1.5rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calendar-week" style="margin-left:6px;"></i> الجدول الأسبوعي
        </h3>
        ${_renderWeeklySchedule(teacher.id)}
      </div>

      <!-- سجل المدفوعات -->
      <div style="background:var(--bg-white);border-radius:16px;padding:1.2rem;box-shadow:0 1px 6px rgba(0,0,0,0.06);">
        <h3 style="margin:0 0 1rem;font-size:0.95rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-receipt" style="margin-left:6px;"></i> سجل المدفوعات
        </h3>
        ${_renderPayoutsTable(teacher.id)}
      </div>
    `;
  }

  function _renderWeeklySchedule(teacherId) {
    const teacherSessions = _sessions.filter(s => s.teacherId === teacherId);
    if (!teacherSessions.length) return '<p style="color:var(--text-muted);font-size:0.85rem;">لا يوجد جدول أسبوعي مضاف.</p>';
    return `
      <div style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:0.83rem;min-width:500px;">
          <thead>
            <tr style="background:var(--bg-light);">
              <th style="padding:8px;text-align:right;">اليوم</th>
              <th style="padding:8px;text-align:center;">الوقت</th>
              <th style="padding:8px;text-align:center;">الصف</th>
              <th style="padding:8px;text-align:center;">المجموعة</th>
            </tr>
          </thead>
          <tbody>
            ${teacherSessions.sort((a,b) => DAY_KEYS.indexOf(a.day) - DAY_KEYS.indexOf(b.day)).map(s => {
              const gl  = typeof gradeLabel === 'function' ? gradeLabel(s.grade) : s.grade;
              const grp = s.groupId ? (db?.groups?.find(g => String(g.id) === String(s.groupId))?.name || s.groupId) : 'عام';
              return `
                <tr style="border-bottom:1px solid var(--bg-light);">
                  <td style="padding:8px;font-weight:700;">${ARABIC_DAYS[DAY_KEYS.indexOf(s.day)] || s.day}</td>
                  <td style="padding:8px;text-align:center;">${s.timeFrom} – ${s.timeTo}</td>
                  <td style="padding:8px;text-align:center;">${_esc(gl)}</td>
                  <td style="padding:8px;text-align:center;">${_esc(grp)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function _renderPayoutsTable(teacherId) {
    const payouts = _payouts.filter(p => p.teacherId === teacherId).sort((a,b) => new Date(b.date) - new Date(a.date));
    if (!payouts.length) return '<p style="color:var(--text-muted);font-size:0.85rem;">لا توجد مدفوعات مسجّلة بعد.</p>';
    return `
      <table style="width:100%;border-collapse:collapse;font-size:0.83rem;">
        <thead>
          <tr style="background:var(--bg-light);">
            <th style="padding:8px;text-align:right;">التاريخ</th>
            <th style="padding:8px;text-align:center;">المبلغ (ج)</th>
            <th style="padding:8px;text-align:right;">ملاحظات</th>
            <th style="padding:8px;"></th>
          </tr>
        </thead>
        <tbody>
          ${payouts.map(p => `
            <tr style="border-bottom:1px solid var(--bg-light);">
              <td style="padding:8px;">${new Date(p.date).toLocaleDateString('ar-EG')}</td>
              <td style="padding:8px;text-align:center;font-weight:800;color:#16a34a;">${(p.amount||0).toLocaleString('ar-EG')}</td>
              <td style="padding:8px;color:var(--text-muted);">${_esc(p.notes || '—')}</td>
              <td style="padding:8px;">
                <button onclick="TeachersModule.deletePayout(${p.id})" style="background:#fef2f2;border:none;border-radius:6px;padding:3px 8px;cursor:pointer;color:#ef4444;font-size:0.75rem;">
                  <i class="fas fa-trash"></i>
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ──────────── تسجيل الحضور ────────────────────────────────

  async function logSession(teacherId, sessionId, status, grade, groupId) {
    const today = new Date().toISOString().split('T')[0];
    // إزالة أي تسجيل سابق لنفس الحصة في نفس اليوم
    const oldLog = _logs.find(l => l.teacherId === teacherId && l.sessionId === sessionId && l.date?.startsWith(today));
    if (oldLog) {
      _logs = _logs.filter(l => l.id !== oldLog.id);
      await deleteFromStore('teacherLogs', oldLog.id);
    }

    if (status === 'postponed') {
      // طلب تاريخ جديد للتأجيل
      const newDate = prompt('أدخل تاريخ التأجيل (YYYY-MM-DD):');
      if (!newDate) return;
      const newTime = prompt('أدخل وقت الحصة الجديدة (HH:MM):');
      const newLog = {
        id: Date.now(), teacherId, sessionId, status: 'postponed',
        date: new Date().toISOString(), grade, groupId: groupId || null,
        postponedTo: newDate, postponedTime: newTime || ''
      };
      _logs.push(newLog);
      await saveStore('teacherLogs', [newLog]);
      showNotification('⏸ تم تسجيل تأجيل الحصة', 'warning');
    } else {
      const newLog = {
        id: Date.now(), teacherId, sessionId, status,
        date: new Date().toISOString(), grade, groupId: groupId || null
      };
      _logs.push(newLog);
      await saveStore('teacherLogs', [newLog]);
      const labels = { attended: '✓ تم تسجيل الحضور', absent: '✕ تم تسجيل الغياب', cancelled: '✕ تم إلغاء الحصة' };
      showNotification(labels[status] || 'تم التسجيل', 'success');
    }

    const teacher = _teachers.find(t => t.id === teacherId);
    if (teacher) renderTeacherAccount(teacher);
  }

  // ──────────── صرف المستحقات ───────────────────────────────

  function showPayoutModal(teacherId) {
    const teacher = _teachers.find(t => t.id === teacherId);
    if (!teacher) return;

    const totalDue  = _calcDue(teacherId);
    const totalPaid = _payouts.filter(p => p.teacherId === teacherId).reduce((s, p) => s + (p.amount || 0), 0);
    const remaining = Math.max(0, totalDue - totalPaid);

    const modal = _createModal('payout-modal', `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.2rem;">
        <h2 style="margin:0;color:var(--primary);font-size:1.1rem;font-weight:800;">
          <i class="fas fa-hand-holding-usd" style="margin-left:8px;"></i>
          صرف مستحقات: ${_esc(teacher.name)}
        </h2>
        <button onclick="_closeModal('payout-modal')" style="background:var(--bg-light);border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;"><i class="fas fa-times"></i></button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0.7rem;margin-bottom:1.2rem;text-align:center;">
        <div style="background:#f0fdf4;border-radius:12px;padding:0.8rem;">
          <div style="font-size:1.1rem;font-weight:800;color:#16a34a;">${totalDue.toLocaleString('ar-EG')} ج</div>
          <div style="font-size:0.72rem;color:var(--text-muted);">إجمالي المستحقات</div>
        </div>
        <div style="background:#eff6ff;border-radius:12px;padding:0.8rem;">
          <div style="font-size:1.1rem;font-weight:800;color:#0ea5e9;">${totalPaid.toLocaleString('ar-EG')} ج</div>
          <div style="font-size:0.72rem;color:var(--text-muted);">المدفوع</div>
        </div>
        <div style="background:${remaining>0?'#fef2f2':'#f0fdf4'};border-radius:12px;padding:0.8rem;">
          <div style="font-size:1.1rem;font-weight:800;color:${remaining>0?'#ef4444':'#16a34a'};">${remaining.toLocaleString('ar-EG')} ج</div>
          <div style="font-size:0.72rem;color:var(--text-muted);">المتبقي</div>
        </div>
      </div>
      <div style="display:grid;gap:0.8rem;margin-bottom:1.2rem;">
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">المبلغ المدفوع (ج) *</label>
          <input id="payout-amount" type="number" min="0" class="form-input" placeholder="أدخل المبلغ" value="${remaining > 0 ? remaining : ''}">
        </div>
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">تاريخ الدفع</label>
          <input id="payout-date" type="date" class="form-input" value="${new Date().toISOString().split('T')[0]}">
        </div>
        <div>
          <label style="font-weight:700;font-size:0.85rem;display:block;margin-bottom:4px;">ملاحظات (اختياري)</label>
          <input id="payout-notes" type="text" class="form-input" placeholder="مثال: دفع نهاية الشهر">
        </div>
      </div>
      <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
        <button onclick="_closeModal('payout-modal')" class="btn" style="background:var(--bg-light);border:1px solid var(--border);">إلغاء</button>
        <button onclick="TeachersModule._confirmPayout(${teacherId})" class="btn btn-primary" style="border-radius:10px;padding:0.6rem 2rem;">
          <i class="fas fa-check"></i> تأكيد الصرف
        </button>
      </div>
    `);
    document.body.appendChild(modal);
  }

  async function _confirmPayout(teacherId) {
    const amount = parseFloat(document.getElementById('payout-amount')?.value);
    const date   = document.getElementById('payout-date')?.value;
    const notes  = document.getElementById('payout-notes')?.value.trim();

    if (!amount || amount <= 0) return showNotification('يرجى إدخال مبلغ صحيح', 'error');
    if (!date) return showNotification('يرجى اختيار تاريخ الدفع', 'error');

    const payout = { id: Date.now(), teacherId, amount, date, notes };
    _payouts.push(payout);
    await saveStore('teacherPayouts', [payout]);

    _closeModal('payout-modal');
    showNotification(`✅ تم تسجيل دفعة ${amount.toLocaleString('ar-EG')} ج`, 'success');
    if (typeof RBAC !== 'undefined') RBAC.log('teacher_payout', `${amount} ج للمدرس ${teacherId}`);

    const teacher = _teachers.find(t => t.id === teacherId);
    if (teacher) renderTeacherAccount(teacher);
  }

  async function deletePayout(payoutId) {
    if (!confirm('هل تريد حذف هذه الدفعة؟')) return;
    _payouts = _payouts.filter(p => p.id !== payoutId);
    await deleteFromStore('teacherPayouts', payoutId);
    showNotification('تم حذف الدفعة', 'success');
    if (_activeTeacherId) {
      const teacher = _teachers.find(t => t.id === _activeTeacherId);
      if (teacher) renderTeacherAccount(teacher);
    }
  }

  // ──────────── فلتر الفترة ────────────────────────────────

  function setFilter(f) {
    _dateFilter = f;
    if (_activeTeacherId) {
      const teacher = _teachers.find(t => t.id === _activeTeacherId);
      if (teacher) renderTeacherAccount(teacher);
    }
  }

  function setCustomRange() {
    _customFrom = document.getElementById('custom-from')?.value || null;
    _customTo   = document.getElementById('custom-to')?.value   || null;
    if (_activeTeacherId) {
      const teacher = _teachers.find(t => t.id === _activeTeacherId);
      if (teacher) renderTeacherAccount(teacher);
    }
  }

  // ──────────── helpers ─────────────────────────────────────

  function _calcDue(teacherId, from = null, to = null) {
    const teacher = _teachers.find(t => t.id === teacherId);
    if (!teacher) return 0;
    const logs = from ? _logs.filter(l => l.teacherId === teacherId && _inRange(l.date, from, to) && l.status === 'attended')
                      : _logs.filter(l => l.teacherId === teacherId && l.status === 'attended');
    return logs.reduce((sum, l) => {
      const a = (teacher.assignments || []).find(a =>
        a.grade === l.grade && (String(a.groupId) === String(l.groupId) || (!a.groupId && !l.groupId))
      );
      return sum + (a?.pricePerSession || 0);
    }, 0);
  }

  function _getTodayLogs(teacherId) {
    const today = new Date().toISOString().split('T')[0];
    return _logs.filter(l => l.teacherId === teacherId && l.date?.startsWith(today));
  }

  function _getDateRange(filter, customFrom, customTo) {
    const now = new Date();
    const toStr = (d) => d.toISOString().split('T')[0];
    if (filter === 'today')  return { from: toStr(now), to: toStr(now) };
    if (filter === 'week')   { const s = new Date(now); s.setDate(now.getDate() - 6); return { from: toStr(s), to: toStr(now) }; }
    if (filter === 'month')  { const s = new Date(now); s.setDate(1); return { from: toStr(s), to: toStr(now) }; }
    if (filter === 'custom') return { from: customFrom || '2000-01-01', to: customTo || toStr(now) };
    return { from: '2000-01-01', to: toStr(now) };
  }

  function _inRange(dateStr, from, to) {
    if (!dateStr) return false;
    const d = dateStr.substring(0, 10);
    return d >= from && d <= to;
  }

  function _buildGradeOptions(selected = '') {
    if (typeof GRADE_MAP === 'undefined') return '';
    return GRADE_MAP.map(g =>
      `<option value="${g.systemCode}" ${g.systemCode === selected ? 'selected' : ''}>${g.label}</option>`
    ).join('');
  }

  function _buildGroupOptions(grade = '', selectedGroupId = '') {
    if (typeof db === 'undefined') return '';
    const groups = grade ? db.groups.filter(g => String(g.grade) === String(grade)) : db.groups;
    return groups.map(g =>
      `<option value="${g.id}" ${String(g.id) === String(selectedGroupId) ? 'selected' : ''}>${_esc(g.name)}</option>`
    ).join('');
  }

  function _esc(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function _createModal(id, content) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = id;
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);backdrop-filter:blur(3px);';
    modal.innerHTML = `
      <div style="background:var(--bg-white,#fff);border-radius:20px;padding:2rem;max-width:680px;width:95%;max-height:90vh;overflow-y:auto;box-shadow:0 25px 60px rgba(0,0,0,0.3);direction:rtl;font-family:inherit;">
        ${content}
      </div>`;
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    return modal;
  }

  // ─── Global close helper ─────────────────────────────────
  window._closeModal = function(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  };

  // ─── Public API ───────────────────────────────────────────
  window.TeachersModule = {
    initTeachersSection,
    renderTeachersGrid,
    showAddTeacherModal,
    showEditTeacherModal,
    deleteTeacher,
    openTeacherAccount,
    backToTeachersList,
    logSession,
    showPayoutModal,
    deletePayout,
    setFilter,
    setCustomRange,
    _addAssignmentRow,
    _addScheduleRow,
    _onGradeChange,
    _onSchedGradeChange,
    _saveTeacher,
    _confirmPayout,
  };

  console.log('[teachers.js] ✅ نظام حسابات المدرسين جاهز');
})();
