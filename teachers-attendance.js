// ============================================================
//  teachers-attendance.js  —  تحضير المدرسين (من برا)
//
//  واجهة سريعة تظهر حصص اليوم لكل المدرسين مع أزرار
//  حضر / غياب / تأجيل / إلغاء بدون ما تدخل جوا حساب المدرس.
//
//  الاستخدام:
//    يُفتح من showSection('teachers-attendance', this)
//    أو من زرار "تحضير المدرسين" في الـ Dashboard
// ============================================================

(function () {
  'use strict';

  const ARABIC_DAYS = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const DAY_KEYS    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  // ─── init (يُستدعى من showSection) ──────────────────────
  async function initTeachersAttendance() {
    await _ensureLoaded();
    renderTodayAttendance();
  }

  // جلب البيانات من StorageEngine لو مش محمّلة
  async function _ensureLoaded() {
    if (typeof StorageEngine === 'undefined') return;
    if (!window._taTeachers)  window._taTeachers  = await _safeGetAll('teachers');
    if (!window._taSessions)  window._taSessions  = await _safeGetAll('teacherSessions');
    if (!window._taLogs)      window._taLogs      = await _safeGetAll('teacherLogs');
  }

  async function _safeGetAll(store) {
    try { return await StorageEngine.getAll(store); }
    catch (e) { return []; }
  }

  // ─── الواجهة الرئيسية ────────────────────────────────────
  function renderTodayAttendance() {
    const container = document.getElementById('teachers-attendance-content');
    if (!container) return;

    const todayKey   = DAY_KEYS[new Date().getDay()];
    const todayLabel = ARABIC_DAYS[new Date().getDay()];
    const todayISO   = new Date().toISOString().split('T')[0];
    const teachers   = window._taTeachers  || [];
    const sessions   = window._taSessions  || [];
    const logs       = window._taLogs      || [];

    // فلتر: حصص اليوم فقط
    const todaySessions = sessions.filter(s => s.day === todayKey);

    if (todaySessions.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:4rem 2rem;color:var(--text-muted);">
          <i class="fas fa-calendar-check" style="font-size:3.5rem;opacity:0.2;display:block;margin-bottom:1.2rem;"></i>
          <p style="font-size:1.1rem;font-weight:700;">لا توجد حصص مجدولة اليوم (${todayLabel})</p>
          <p style="font-size:0.85rem;margin-top:0.5rem;">أضف جدولاً أسبوعياً من قسم حسابات المدرسين</p>
        </div>`;
      return;
    }

    // تجميع الحصص بالمدرس
    const byTeacher = {};
    todaySessions.forEach(s => {
      if (!byTeacher[s.teacherId]) byTeacher[s.teacherId] = [];
      byTeacher[s.teacherId].push(s);
    });

    let html = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:0.5rem;">
        <h3 style="margin:0;font-size:1rem;font-weight:800;color:var(--primary);">
          <i class="fas fa-calendar-day" style="margin-left:8px;"></i>
          حصص اليوم — ${todayLabel}
          <span style="background:var(--primary);color:white;border-radius:20px;padding:2px 10px;font-size:0.78rem;margin-right:8px;">${todaySessions.length} حصة</span>
        </h3>
        <button onclick="TeachersAttendance.refresh()" style="background:var(--bg-light);border:1px solid var(--border);border-radius:10px;padding:0.4rem 1rem;cursor:pointer;font-size:0.82rem;">
          <i class="fas fa-sync-alt"></i> تحديث
        </button>
      </div>`;

    Object.entries(byTeacher).forEach(([teacherId, tSessions]) => {
      const teacher = teachers.find(t => String(t.id) === String(teacherId));
      const tName   = teacher?.name || 'مدرس محذوف';
      const tSubj   = teacher?.subject || '';

      html += `
        <div style="background:var(--bg-white);border-radius:18px;padding:1.2rem 1.4rem;margin-bottom:1.2rem;box-shadow:0 2px 12px rgba(0,0,0,0.06);border:1.5px solid var(--border);">
          <div style="display:flex;align-items:center;gap:0.8rem;margin-bottom:1rem;padding-bottom:0.8rem;border-bottom:1px solid var(--bg-light);">
            <div style="width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:center;color:white;font-weight:800;font-size:1.1rem;flex-shrink:0;">
              ${tName.charAt(0)}
            </div>
            <div>
              <div style="font-weight:800;font-size:0.95rem;">${_esc(tName)}</div>
              ${tSubj ? `<div style="font-size:0.78rem;color:var(--text-muted);">${_esc(tSubj)}</div>` : ''}
            </div>
            <div style="margin-right:auto;display:flex;gap:6px;">
              ${_teacherDaySummary(teacherId, tSessions, logs, todayISO)}
            </div>
          </div>
          ${tSessions.sort((a,b) => (a.timeFrom||'').localeCompare(b.timeFrom||'')).map(s => {
            const log = logs.find(l =>
              l.teacherId == teacherId &&
              l.sessionId == s.id &&
              (l.date||'').startsWith(todayISO)
            );
            const gl  = typeof gradeLabel === 'function' ? gradeLabel(s.grade) : (s.grade || '');
            const grp = s.groupId && typeof db !== 'undefined'
              ? (db.groups?.find(g => String(g.id) === String(s.groupId))?.name || 'مجموعة')
              : (s.groupId ? 'مجموعة' : 'عام');
            return _sessionRow(s, log, gl, grp, teacherId);
          }).join('')}
        </div>`;
    });

    container.innerHTML = html;
  }

  function _teacherDaySummary(teacherId, sessions, logs, todayISO) {
    const attended  = sessions.filter(s => logs.find(l => l.teacherId == teacherId && l.sessionId == s.id && l.status === 'attended' && (l.date||'').startsWith(todayISO))).length;
    const absent    = sessions.filter(s => logs.find(l => l.teacherId == teacherId && l.sessionId == s.id && l.status === 'absent'   && (l.date||'').startsWith(todayISO))).length;
    const pending   = sessions.length - attended - absent - sessions.filter(s => logs.find(l => l.teacherId == teacherId && l.sessionId == s.id && (l.status === 'postponed'||l.status === 'cancelled') && (l.date||'').startsWith(todayISO))).length;
    return `
      <span style="background:#dcfce7;color:#16a34a;border-radius:20px;padding:3px 10px;font-size:0.75rem;font-weight:700;">${attended} حضر</span>
      ${absent  ? `<span style="background:#fef2f2;color:#ef4444;border-radius:20px;padding:3px 10px;font-size:0.75rem;font-weight:700;">${absent} غائب</span>` : ''}
      ${pending ? `<span style="background:#fefce8;color:#a16207;border-radius:20px;padding:3px 10px;font-size:0.75rem;font-weight:700;">${pending} معلق</span>` : ''}`;
  }

  function _sessionRow(s, log, gl, grp, teacherId) {
    const statusConfig = {
      attended:  { bg:'#dcfce7', color:'#16a34a', icon:'fas fa-check-circle', label:'حضر' },
      absent:    { bg:'#fef2f2', color:'#ef4444', icon:'fas fa-times-circle', label:'غائب' },
      postponed: { bg:'#fefce8', color:'#a16207', icon:'fas fa-clock',        label:'مؤجّل' },
      cancelled: { bg:'#f1f5f9', color:'#64748b', icon:'fas fa-ban',          label:'ملغي' },
    };
    const cfg = log ? statusConfig[log.status] : null;

    return `
      <div style="display:flex;align-items:center;gap:0.8rem;padding:0.75rem 0.5rem;border-bottom:1px dashed var(--bg-light);flex-wrap:wrap;" id="srow-${s.id}">
        <!-- وقت ومعلومات الحصة -->
        <div style="min-width:100px;">
          <div style="font-weight:800;font-size:0.9rem;color:var(--primary);">${s.timeFrom||'--'} <span style="color:var(--text-muted);font-weight:400;">→</span> ${s.timeTo||'--'}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">${_esc(gl)} — ${_esc(grp)}</div>
        </div>

        <!-- حالة الحصة الحالية -->
        <div style="flex:1;">
          ${cfg
            ? `<span style="background:${cfg.bg};color:${cfg.color};border-radius:20px;padding:4px 12px;font-size:0.8rem;font-weight:700;">
                <i class="${cfg.icon}"></i> ${cfg.label}
               </span>`
            : `<span style="background:var(--bg-light);color:var(--text-muted);border-radius:20px;padding:4px 12px;font-size:0.8rem;">لم يُسجَّل بعد</span>`
          }
        </div>

        <!-- أزرار التسجيل -->
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button
            onclick="TeachersAttendance.log(${teacherId},'${s.id}','attended','${s.grade||''}','${s.groupId||''}')"
            title="حضر"
            style="padding:6px 12px;border:none;border-radius:9px;background:${log?.status==='attended'?'#16a34a':'#dcfce7'};color:${log?.status==='attended'?'white':'#16a34a'};cursor:pointer;font-weight:700;font-size:0.8rem;transition:all 0.15s;">
            <i class="fas fa-check"></i> حضر
          </button>
          <button
            onclick="TeachersAttendance.log(${teacherId},'${s.id}','absent','${s.grade||''}','${s.groupId||''}')"
            title="غائب"
            style="padding:6px 12px;border:none;border-radius:9px;background:${log?.status==='absent'?'#ef4444':'#fef2f2'};color:${log?.status==='absent'?'white':'#ef4444'};cursor:pointer;font-weight:700;font-size:0.8rem;transition:all 0.15s;">
            <i class="fas fa-times"></i> غياب
          </button>
          <button
            onclick="TeachersAttendance.log(${teacherId},'${s.id}','postponed','${s.grade||''}','${s.groupId||''}')"
            title="تأجيل"
            style="padding:6px 10px;border:none;border-radius:9px;background:${log?.status==='postponed'?'#f59e0b':'#fefce8'};color:${log?.status==='postponed'?'white':'#a16207'};cursor:pointer;font-weight:700;font-size:0.8rem;">
            <i class="fas fa-clock"></i> تأجيل
          </button>
          <button
            onclick="TeachersAttendance.log(${teacherId},'${s.id}','cancelled','${s.grade||''}','${s.groupId||''}')"
            title="إلغاء"
            style="padding:6px 10px;border:none;border-radius:9px;background:${log?.status==='cancelled'?'#64748b':'#f1f5f9'};color:${log?.status==='cancelled'?'white':'#64748b'};cursor:pointer;font-weight:700;font-size:0.8rem;">
            <i class="fas fa-ban"></i> إلغاء
          </button>
        </div>
      </div>`;
  }

  // ─── تسجيل الحضور ─────────────────────────────────────────
  async function logAttendance(teacherId, sessionId, status, grade, groupId) {
    await _ensureLoaded();
    const todayISO = new Date().toISOString().split('T')[0];

    // إزالة تسجيل سابق لنفس الحصة اليوم
    const oldLog = (window._taLogs || []).find(l =>
      String(l.teacherId) === String(teacherId) &&
      String(l.sessionId) === String(sessionId) &&
      (l.date || '').startsWith(todayISO)
    );
    if (oldLog) {
      window._taLogs = window._taLogs.filter(l => l.id !== oldLog.id);
      try { await StorageEngine.delete('teacherLogs', oldLog.id); } catch(e) {}
    }

    // تأجيل — طلب تاريخ جديد
    if (status === 'postponed') {
      const newDate = prompt('تاريخ التأجيل (YYYY-MM-DD):');
      if (!newDate) return;
    }

    const newLog = {
      id: Date.now(),
      teacherId: Number(teacherId),
      sessionId: String(sessionId),
      status,
      date: new Date().toISOString(),
      grade: grade || '',
      groupId: groupId || null
    };

    if (!window._taLogs) window._taLogs = [];
    window._taLogs.push(newLog);

    try {
      await _ensureTeacherStores();
      await StorageEngine.save('teacherLogs', [newLog]);
    } catch(e) {
      console.warn('[TeachersAttendance] save failed:', e);
    }

    // تحديث TeachersModule لو محمّل
    if (typeof TeachersModule !== 'undefined') {
      TeachersModule._syncLogs && TeachersModule._syncLogs(window._taLogs);
    }

    const labels = { attended:'✅ تم تسجيل حضور المدرس', absent:'❌ تم تسجيل غياب المدرس', postponed:'⏸ تم تسجيل التأجيل', cancelled:'تم إلغاء الحصة' };
    if (typeof showNotification === 'function') showNotification(labels[status] || 'تم التسجيل', 'success');

    // إعادة رسم الواجهة
    renderTodayAttendance();
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
        missing.forEach(n => { if (!db2.objectStoreNames.contains(n)) db2.createObjectStore(n, { keyPath: 'id' }); });
      };
      req.onsuccess = (e) => { StorageEngine.db = e.target.result; resolve(); };
      req.onerror = () => resolve();
    });
  }

  async function refresh() {
    window._taTeachers = null;
    window._taSessions = null;
    window._taLogs     = null;
    await initTeachersAttendance();
  }

  function _esc(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  window.TeachersAttendance = {
    init: initTeachersAttendance,
    log: logAttendance,
    refresh,
  };

  console.log('[teachers-attendance.js] ✅ نظام تحضير المدرسين السريع جاهز');
})();
