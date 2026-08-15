// ============================================================
//  halls.js  —  نظام إدارة القاعات الدراسية
//  Classroom Halls Management System
//
//  الميزات:
//    • إضافة / تعديل / حذف قاعات غير محدودة
//    • جدولة حجوزات داخل كل قاعة (يوم + وقت + صف + مجموعة)
//    • كشف التعارض الذكي داخل نفس القاعة
//    • جدول أسبوعي مرئي لكل قاعة
//    • تكامل كامل مع gradesList و db.groups الموجودَين
//
//  التخزين: IndexedDB (StorageEngine) — جدولان:
//    halls     : { id, name, color, createdAt }
//    hallBookings: { id, hallId, day, timeFrom, timeTo,
//                    grade, groupId, notes, createdAt }
// ============================================================

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════
     ثوابت
  ══════════════════════════════════════════════════════════ */
  const ARABIC_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const DAY_KEYS    = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const HALL_COLORS = [
    '#4f46e5', '#0ea5e9', '#10b981', '#f59e0b',
    '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'
  ];

  /* ══════════════════════════════════════════════════════════
     حالة الوحدة
  ══════════════════════════════════════════════════════════ */
  let halls      = [];   // كل القاعات
  let bookings   = [];   // كل الحجوزات
  let activeHallId = null;    // القاعة المفتوحة حالياً
  let editingBookingId = null; // حجز قيد التعديل
  let editingHallId    = null; // قاعة قيد التعديل

  /* ══════════════════════════════════════════════════════════
     IndexedDB helpers (يستخدم StorageEngine الموجود)
  ══════════════════════════════════════════════════════════ */
  async function ensureStores() {
    // جدولا halls و hallBookings مُعرَّفان في StorageEngine (v8 في app.js)
    // نتأكد فقط من أن StorageEngine جاهز ومتصل
    if (!window.StorageEngine) {
      console.error('[Halls] StorageEngine غير متاح — تأكد من تحميل app.js أولاً');
      return;
    }
    if (!StorageEngine.db) {
      await StorageEngine.init();
    }
    if (!StorageEngine.db) {
      console.error('[Halls] فشل الاتصال بـ IndexedDB');
      return;
    }
    const missing = ['halls','hallBookings'].filter(
      n => !StorageEngine.db.objectStoreNames.contains(n)
    );
    if (missing.length > 0) {
      console.error('[Halls] الجداول التالية غير موجودة:', missing.join(', '),
        '— تأكد من استخدام app.js المحدَّث (v8)');
    }
  }

  async function loadData() {
    await ensureStores();
    try {
      halls    = await StorageEngine.getAll('halls')    || [];
      bookings = await StorageEngine.getAll('hallBookings') || [];
    } catch (e) {
      halls    = [];
      bookings = [];
      console.warn('[Halls] load failed:', e);
    }
  }

  async function saveHall(hall) {
    await ensureStores();
    await StorageEngine.save('halls', hall);
  }

  async function saveBooking(booking) {
    await ensureStores();
    await StorageEngine.save('hallBookings', booking);
  }

  async function deleteHallDB(id) {
    await ensureStores();
    await StorageEngine.delete('halls', id);
  }

  async function deleteBookingDB(id) {
    await ensureStores();
    await StorageEngine.delete('hallBookings', id);
  }

  /* ══════════════════════════════════════════════════════════
     منطق كشف التعارض
  ══════════════════════════════════════════════════════════ */
  function toMinutes(timeStr) {
    const [h, m] = (timeStr || '00:00').split(':').map(Number);
    return h * 60 + (m || 0);
  }

  /**
   * يكشف هل الفترة الجديدة تتعارض مع حجوزات موجودة في نفس القاعة ونفس اليوم
   * @param {string} hallId
   * @param {string} day        - e.g. 'Sunday'
   * @param {string} timeFrom   - e.g. '16:00'
   * @param {string} timeTo     - e.g. '18:00'
   * @param {string|null} excludeBookingId  - معرّف الحجز المُعدَّل (يُستثنى من الفحص)
   * @returns {{conflict: boolean, with: object|null}}
   */
  function detectConflict(hallId, day, timeFrom, timeTo, excludeBookingId = null) {
    const newFrom = toMinutes(timeFrom);
    const newTo   = toMinutes(timeTo);

    const same = bookings.filter(b =>
      String(b.hallId) === String(hallId) &&
      b.day === day &&
      String(b.id) !== String(excludeBookingId)
    );

    for (const b of same) {
      const bFrom = toMinutes(b.timeFrom);
      const bTo   = toMinutes(b.timeTo);
      // تعارض: أي تداخل زمني (حتى جزئي)
      if (newFrom < bTo && newTo > bFrom) {
        return { conflict: true, with: b };
      }
    }
    return { conflict: false, with: null };
  }

  /* ══════════════════════════════════════════════════════════
     مساعدات عرض
  ══════════════════════════════════════════════════════════ */
  function gradeName(gradeId) {
    const list = window.gradesList || [];
    const g = list.find(x => String(x.id) === String(gradeId) || String(x.systemCode) === String(gradeId));
    return g ? g.name : (gradeId || '---');
  }

  function groupName(groupId) {
    const groups = (window.db && db.groups) ? db.groups : [];
    const g = groups.find(x => String(x.id) === String(groupId));
    return g ? g.name : (groupId ? 'مجموعة' : 'عام');
  }

  function hallColor(hall) {
    return hall.color || HALL_COLORS[0];
  }

  function _esc(str) {
    return String(str || '').replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function notify(msg, type = 'success') {
    if (typeof showNotification === 'function') showNotification(msg, type);
    else alert(msg);
  }

  /* ══════════════════════════════════════════════════════════
     بناء خيارات الصفوف والمجموعات
  ══════════════════════════════════════════════════════════ */
  function buildGradeOptions(selectedGrade = '') {
    const list = window.gradesList || [];
    return list.map(g =>
      `<option value="${_esc(String(g.id))}" ${String(g.id) === String(selectedGrade) ? 'selected' : ''}>
        ${_esc(g.name)}
      </option>`
    ).join('');
  }

  function buildGroupOptions(gradeId = '', selectedGroupId = '') {
    const allGroups = (window.db && db.groups) ? db.groups : [];
    const filtered  = gradeId
      ? allGroups.filter(g => String(g.grade) === String(gradeId))
      : allGroups;
    let opts = `<option value="">-- كل المجموعات --</option>`;
    opts += filtered.map(g =>
      `<option value="${g.id}" ${String(g.id) === String(selectedGroupId) ? 'selected' : ''}>${_esc(g.name)}</option>`
    ).join('');
    return opts;
  }

  /* ══════════════════════════════════════════════════════════
     الواجهة الرئيسية للقسم
  ══════════════════════════════════════════════════════════ */
  function renderHallsSection() {
    const container = document.getElementById('halls-content');
    if (!container) return;

    if (halls.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:5rem 2rem;color:var(--text-muted);">
          <div style="font-size:4rem;margin-bottom:1rem;opacity:0.2;">🏫</div>
          <p style="font-size:1.15rem;font-weight:700;margin-bottom:0.5rem;">لا توجد قاعات مضافة بعد</p>
          <p style="font-size:0.9rem;margin-bottom:1.5rem;">أضف قاعتك الأولى لتبدأ في جدولة الحصص</p>
          <button onclick="HallsModule.openAddHallModal()"
            style="padding:0.75rem 2rem;background:var(--primary);color:white;border:none;border-radius:12px;font-size:1rem;font-weight:700;cursor:pointer;font-family:inherit;">
            <i class="fas fa-plus"></i> إضافة قاعة
          </button>
        </div>`;
      return;
    }

    // ── شبكة القاعات ──
    let html = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1.2rem;margin-bottom:1.5rem;">
        ${halls.map(h => _hallCard(h)).join('')}
        <div onclick="HallsModule.openAddHallModal()"
          style="border:2px dashed var(--border);border-radius:18px;padding:2rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.5rem;cursor:pointer;min-height:140px;color:var(--text-muted);transition:all 0.2s;"
          onmouseover="this.style.borderColor='var(--primary)';this.style.color='var(--primary)'"
          onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
          <i class="fas fa-plus-circle" style="font-size:2rem;"></i>
          <span style="font-weight:700;">إضافة قاعة جديدة</span>
        </div>
      </div>`;

    container.innerHTML = html;

    // لو في قاعة مفتوحة → اعرض تفاصيلها
    if (activeHallId) renderHallDetail(activeHallId);
  }

  function _hallCard(hall) {
    const color = hallColor(hall);
    const hallBookings = bookings.filter(b => String(b.hallId) === String(hall.id));
    const todayKey = DAY_KEYS[new Date().getDay()];
    const todayCount = hallBookings.filter(b => b.day === todayKey).length;

    return `
      <div onclick="HallsModule.openHallDetail('${hall.id}')"
        style="background:var(--bg-white);border-radius:18px;padding:1.4rem;box-shadow:0 2px 12px rgba(0,0,0,0.06);
               border:1.5px solid var(--border);cursor:pointer;transition:all 0.2s;position:relative;overflow:hidden;"
        onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 24px rgba(0,0,0,0.1)'"
        onmouseout="this.style.transform='';this.style.boxShadow='0 2px 12px rgba(0,0,0,0.06)'">
        <!-- شريط اللون -->
        <div style="position:absolute;top:0;right:0;left:0;height:4px;background:${color};border-radius:18px 18px 0 0;"></div>

        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:0.5rem;">
          <div>
            <div style="width:44px;height:44px;border-radius:12px;background:${color}20;display:flex;align-items:center;justify-content:center;margin-bottom:0.75rem;">
              <i class="fas fa-door-open" style="color:${color};font-size:1.2rem;"></i>
            </div>
            <div style="font-weight:800;font-size:1.05rem;color:var(--text-main);">${_esc(hall.name)}</div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:3px;">
              ${hallBookings.length} حجز إجمالاً
              ${todayCount ? `· <span style="color:${color};font-weight:700;">${todayCount} اليوم</span>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:5px;" onclick="event.stopPropagation()">
            <button onclick="HallsModule.openEditHallModal('${hall.id}')"
              title="تعديل اسم القاعة"
              style="width:30px;height:30px;border:none;background:var(--bg-light);border-radius:8px;cursor:pointer;color:var(--primary);">
              <i class="fas fa-edit" style="font-size:0.75rem;"></i>
            </button>
            <button onclick="HallsModule.deleteHall('${hall.id}')"
              title="حذف القاعة"
              style="width:30px;height:30px;border:none;background:#fef2f2;border-radius:8px;cursor:pointer;color:#ef4444;">
              <i class="fas fa-trash" style="font-size:0.75rem;"></i>
            </button>
          </div>
        </div>

        <!-- أيام النشاط -->
        <div style="display:flex;gap:4px;margin-top:0.9rem;flex-wrap:wrap;">
          ${DAY_KEYS.map((dk, i) => {
            const has = hallBookings.some(b => b.day === dk);
            return has
              ? `<span style="background:${color}20;color:${color};border-radius:6px;padding:2px 8px;font-size:0.72rem;font-weight:700;">${ARABIC_DAYS[i]}</span>`
              : '';
          }).join('')}
        </div>
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════
     تفاصيل القاعة — الجدول الأسبوعي
  ══════════════════════════════════════════════════════════ */
  function renderHallDetail(hallId) {
    activeHallId = hallId;
    const hall = halls.find(h => String(h.id) === String(hallId));
    if (!hall) return;

    const color = hallColor(hall);
    const hallBookings = bookings
      .filter(b => String(b.hallId) === String(hallId))
      .sort((a, b) => toMinutes(a.timeFrom) - toMinutes(b.timeFrom));

    // تجميع بالأيام
    const byDay = {};
    DAY_KEYS.forEach(dk => { byDay[dk] = []; });
    hallBookings.forEach(b => { if (byDay[b.day]) byDay[b.day].push(b); });

    // إضافة div التفاصيل لو مش موجود
    let detailEl = document.getElementById('hall-detail-panel');
    if (!detailEl) {
      detailEl = document.createElement('div');
      detailEl.id = 'hall-detail-panel';
      document.getElementById('halls-content').appendChild(detailEl);
    }

    detailEl.style.cssText = `
      background:var(--bg-white);border-radius:20px;
      box-shadow:0 4px 24px rgba(0,0,0,0.08);
      border:1.5px solid var(--border);overflow:hidden;margin-top:0.5rem;`;

    detailEl.innerHTML = `
      <!-- هيدر القاعة -->
      <div style="background:${color};padding:1.4rem 1.6rem;color:white;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;">
        <div>
          <div style="font-size:1.25rem;font-weight:800;"><i class="fas fa-door-open"></i> ${_esc(hall.name)}</div>
          <div style="font-size:0.85rem;opacity:0.85;margin-top:4px;">${hallBookings.length} حجز مجدوَل هذا الأسبوع</div>
        </div>
        <div style="display:flex;gap:0.6rem;flex-wrap:wrap;">
          <button onclick="HallsModule.openAddBookingModal('${hall.id}')"
            style="padding:0.6rem 1.2rem;background:white;color:${color};border:none;border-radius:10px;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.88rem;">
            <i class="fas fa-plus"></i> إضافة حجز
          </button>
          <button onclick="HallsModule.closeHallDetail()"
            style="padding:0.6rem 0.9rem;background:rgba(255,255,255,0.2);color:white;border:1px solid rgba(255,255,255,0.4);border-radius:10px;cursor:pointer;">
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>

      <!-- الجدول الأسبوعي -->
      <div style="padding:1.4rem;overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;min-width:700px;">
          <thead>
            <tr style="background:var(--bg-light);">
              ${DAY_KEYS.map((dk, i) => `
                <th style="padding:0.75rem 0.5rem;text-align:center;font-size:0.82rem;font-weight:800;
                           color:${dk === DAY_KEYS[new Date().getDay()] ? color : 'var(--text-main)'};
                           border-bottom:2px solid ${dk === DAY_KEYS[new Date().getDay()] ? color : 'var(--border)'};
                           min-width:120px;">
                  ${ARABIC_DAYS[i]}
                  ${dk === DAY_KEYS[new Date().getDay()] ? '<br><span style="font-size:0.65rem;opacity:0.7;">اليوم</span>' : ''}
                </th>`).join('')}
            </tr>
          </thead>
          <tbody>
            <tr style="vertical-align:top;">
              ${DAY_KEYS.map(dk => `
                <td style="padding:0.5rem;border-left:1px solid var(--border);">
                  ${byDay[dk].length === 0
                    ? `<div style="min-height:60px;display:flex;align-items:center;justify-content:center;">
                         <button onclick="HallsModule.openAddBookingModal('${hall.id}','${dk}')"
                           style="color:var(--text-muted);border:1.5px dashed var(--border);background:none;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.75rem;width:100%;">
                           <i class="fas fa-plus"></i>
                         </button>
                       </div>`
                    : byDay[dk].map(b => _bookingCard(b, color)).join('')
                  }
                </td>`).join('')}
            </tr>
          </tbody>
        </table>
      </div>

      <!-- قائمة مدمجة بكل الحجوزات -->
      <div style="padding:0 1.4rem 1.4rem;">
        <div style="font-size:0.82rem;font-weight:800;color:var(--text-muted);margin-bottom:0.75rem;text-transform:uppercase;letter-spacing:0.05em;">
          كل الحجوزات (${hallBookings.length})
        </div>
        ${hallBookings.length === 0
          ? `<div style="text-align:center;padding:2rem;color:var(--text-muted);font-size:0.9rem;">لا توجد حجوزات بعد</div>`
          : `<div style="display:flex;flex-direction:column;gap:0.5rem;">
              ${hallBookings.map(b => _bookingListRow(b, color)).join('')}
             </div>`
        }
      </div>`;
  }

  function _bookingCard(b, color) {
    const gName  = gradeName(b.grade);
    const grpName = groupName(b.groupId);
    return `
      <div style="background:${color}12;border:1.5px solid ${color}30;border-radius:10px;padding:0.55rem 0.65rem;margin-bottom:0.4rem;">
        <div style="font-size:0.78rem;font-weight:800;color:${color};">${_esc(b.timeFrom)} — ${_esc(b.timeTo)}</div>
        <div style="font-size:0.75rem;color:var(--text-main);margin-top:2px;font-weight:700;">${_esc(gName)}</div>
        <div style="font-size:0.72rem;color:var(--text-muted);">${_esc(grpName)}</div>
        <div style="display:flex;gap:4px;margin-top:5px;">
          <button onclick="HallsModule.openEditBookingModal('${b.id}')"
            style="flex:1;font-size:0.68rem;padding:3px 0;border:none;background:white;border-radius:6px;cursor:pointer;color:var(--primary);">
            <i class="fas fa-edit"></i>
          </button>
          <button onclick="HallsModule.deleteBooking('${b.id}')"
            style="flex:1;font-size:0.68rem;padding:3px 0;border:none;background:#fef2f2;border-radius:6px;cursor:pointer;color:#ef4444;">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }

  function _bookingListRow(b, color) {
    const dayLabel = ARABIC_DAYS[DAY_KEYS.indexOf(b.day)] || b.day;
    const gName    = gradeName(b.grade);
    const grpName  = groupName(b.groupId);
    return `
      <div style="display:flex;align-items:center;gap:0.8rem;padding:0.7rem 0.9rem;background:var(--bg-light);border-radius:12px;flex-wrap:wrap;">
        <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></div>
        <div style="font-weight:700;color:${color};min-width:70px;font-size:0.85rem;">${_esc(dayLabel)}</div>
        <div style="font-size:0.82rem;color:var(--text-muted);min-width:90px;">
          <i class="fas fa-clock" style="font-size:0.7rem;margin-left:3px;"></i>${_esc(b.timeFrom)} — ${_esc(b.timeTo)}
        </div>
        <div style="font-size:0.82rem;font-weight:700;flex:1;">${_esc(gName)} · ${_esc(grpName)}</div>
        ${b.notes ? `<div style="font-size:0.75rem;color:var(--text-muted);font-style:italic;">${_esc(b.notes)}</div>` : ''}
        <div style="display:flex;gap:5px;margin-right:auto;">
          <button onclick="HallsModule.openEditBookingModal('${b.id}')"
            style="padding:4px 10px;border:none;background:var(--primary);color:white;border-radius:8px;cursor:pointer;font-size:0.75rem;">
            <i class="fas fa-edit"></i>
          </button>
          <button onclick="HallsModule.deleteBooking('${b.id}')"
            style="padding:4px 10px;border:none;background:#fef2f2;color:#ef4444;border-radius:8px;cursor:pointer;font-size:0.75rem;">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>`;
  }

  function closeHallDetail() {
    activeHallId = null;
    const el = document.getElementById('hall-detail-panel');
    if (el) el.remove();
  }

  /* ══════════════════════════════════════════════════════════
     مودال إضافة / تعديل قاعة
  ══════════════════════════════════════════════════════════ */
  function openAddHallModal() {
    editingHallId = null;
    _showHallModal({ name: '', color: HALL_COLORS[0] });
  }

  function openEditHallModal(hallId) {
    editingHallId = hallId;
    const hall = halls.find(h => String(h.id) === String(hallId));
    if (!hall) return;
    _showHallModal(hall);
  }

  function _showHallModal(hall) {
    _removeModal('hall-name-modal');
    const modal = document.createElement('div');
    modal.id = 'hall-name-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';
    modal.innerHTML = `
      <div style="background:var(--bg-white,#fff);border-radius:20px;padding:1.8rem;max-width:420px;width:94%;direction:rtl;font-family:inherit;box-shadow:0 20px 60px rgba(0,0,0,0.25);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.4rem;">
          <h3 style="margin:0;font-size:1.05rem;font-weight:800;color:var(--primary);">
            <i class="fas fa-door-open"></i> ${editingHallId ? 'تعديل اسم القاعة' : 'إضافة قاعة جديدة'}
          </h3>
          <button onclick="document.getElementById('hall-name-modal').remove()"
            style="background:var(--bg-light,#f1f5f9);border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <label style="display:block;font-size:0.85rem;font-weight:700;margin-bottom:5px;color:var(--text-main);">اسم القاعة</label>
        <input id="hall-modal-name" type="text" value="${_esc(hall.name || '')}"
          placeholder="مثال: قاعة 1 — القاعة الكبيرة ..."
          style="width:100%;padding:0.75rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.95rem;box-sizing:border-box;margin-bottom:1rem;outline:none;"
          onkeydown="if(event.key==='Enter') HallsModule.saveHallModal()">

        <label style="display:block;font-size:0.85rem;font-weight:700;margin-bottom:8px;color:var(--text-main);">لون القاعة</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:1.4rem;">
          ${HALL_COLORS.map(c => `
            <div onclick="document.querySelectorAll('.hall-color-dot').forEach(d=>d.style.transform='');this.style.transform='scale(1.2)';this.dataset.sel='1';window._selectedHallColor='${c}'"
              class="hall-color-dot"
              data-color="${c}"
              style="width:28px;height:28px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${c === (hall.color || HALL_COLORS[0]) ? 'white' : 'transparent'};
                     box-shadow:${c === (hall.color || HALL_COLORS[0]) ? '0 0 0 2px '+c : 'none'};
                     transform:${c === (hall.color || HALL_COLORS[0]) ? 'scale(1.2)' : ''};transition:all 0.15s;">
            </div>`).join('')}
        </div>

        <div style="display:flex;gap:0.75rem;">
          <button onclick="HallsModule.saveHallModal()"
            style="flex:1;padding:0.8rem;border:none;border-radius:10px;background:var(--primary);color:white;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.9rem;">
            <i class="fas fa-save"></i> ${editingHallId ? 'حفظ التعديل' : 'إضافة القاعة'}
          </button>
          <button onclick="document.getElementById('hall-name-modal').remove()"
            style="padding:0.8rem 1rem;border:none;border-radius:10px;background:var(--bg-light,#f1f5f9);cursor:pointer;font-family:inherit;">
            إلغاء
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // تعيين اللون الافتراضي
    window._selectedHallColor = hall.color || HALL_COLORS[0];
    setTimeout(() => document.getElementById('hall-modal-name')?.focus(), 100);
  }

  async function saveHallModal() {
    const name  = document.getElementById('hall-modal-name')?.value.trim();
    const color = window._selectedHallColor || HALL_COLORS[0];
    if (!name) return notify('يرجى كتابة اسم للقاعة', 'error');

    if (editingHallId) {
      const hall = halls.find(h => String(h.id) === String(editingHallId));
      if (!hall) return;
      hall.name  = name;
      hall.color = color;
      await saveHall(hall);
      notify('✅ تم تحديث بيانات القاعة');
    } else {
      const hall = { id: Date.now(), name, color, createdAt: new Date().toISOString() };
      halls.push(hall);
      await saveHall(hall);
      notify('✅ تمت إضافة القاعة بنجاح');
    }

    _removeModal('hall-name-modal');
    renderHallsSection();
    if (activeHallId) renderHallDetail(activeHallId);
  }

  async function deleteHall(hallId) {
    const hall = halls.find(h => String(h.id) === String(hallId));
    if (!hall) return;
    const hallBookings = bookings.filter(b => String(b.hallId) === String(hallId));
    const msg = hallBookings.length
      ? `حذف "${hall.name}" وكل حجوزاتها (${hallBookings.length} حجز)؟ لا يمكن التراجع.`
      : `حذف قاعة "${hall.name}"؟`;
    if (!confirm(msg)) return;

    // حذف الحجوزات
    for (const b of hallBookings) {
      await deleteBookingDB(b.id);
    }
    bookings = bookings.filter(b => String(b.hallId) !== String(hallId));

    await deleteHallDB(hall.id);
    halls = halls.filter(h => String(h.id) !== String(hallId));

    if (String(activeHallId) === String(hallId)) closeHallDetail();
    notify('تم حذف القاعة وكل حجوزاتها');
    renderHallsSection();
  }

  /* ══════════════════════════════════════════════════════════
     مودال إضافة / تعديل حجز
  ══════════════════════════════════════════════════════════ */
  function openAddBookingModal(hallId, presetDay = '') {
    editingBookingId = null;
    const hall = halls.find(h => String(h.id) === String(hallId));
    _showBookingModal({
      hallId,
      day: presetDay || '',
      timeFrom: '',
      timeTo: '',
      grade: window.currentGrade || '',
      groupId: window.currentGroupId || '',
      notes: ''
    }, hall);
  }

  function openEditBookingModal(bookingId) {
    editingBookingId = bookingId;
    const b = bookings.find(x => String(x.id) === String(bookingId));
    if (!b) return;
    const hall = halls.find(h => String(h.id) === String(b.hallId));
    _showBookingModal(b, hall);
  }

  function _showBookingModal(b, hall) {
    _removeModal('hall-booking-modal');
    const color = hall ? hallColor(hall) : 'var(--primary)';
    const hallName = hall ? hall.name : '';

    const modal = document.createElement('div');
    modal.id = 'hall-booking-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);';
    modal.innerHTML = `
      <div style="background:var(--bg-white,#fff);border-radius:20px;padding:1.8rem;max-width:500px;width:96%;max-height:90vh;overflow-y:auto;direction:rtl;font-family:inherit;box-shadow:0 20px 60px rgba(0,0,0,0.28);">

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.4rem;">
          <h3 style="margin:0;font-size:1.05rem;font-weight:800;color:${color};">
            <i class="fas fa-calendar-plus"></i>
            ${editingBookingId ? 'تعديل الحجز' : 'حجز جديد'}
            ${hallName ? `<span style="color:var(--text-muted);font-weight:500;font-size:0.85rem;"> — ${_esc(hallName)}</span>` : ''}
          </h3>
          <button onclick="document.getElementById('hall-booking-modal').remove()"
            style="background:var(--bg-light,#f1f5f9);border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!-- اليوم -->
        <div style="margin-bottom:1rem;">
          <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">📅 اليوم</label>
          <select id="bk-day"
            style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.9rem;background:var(--bg-white);">
            <option value="">-- اختر اليوم --</option>
            ${DAY_KEYS.map((dk, i) =>
              `<option value="${dk}" ${dk === b.day ? 'selected' : ''}>${ARABIC_DAYS[i]}</option>`
            ).join('')}
          </select>
        </div>

        <!-- الوقت -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;margin-bottom:1rem;">
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">🕐 من</label>
            <input id="bk-from" type="time" value="${_esc(b.timeFrom || '')}"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.9rem;box-sizing:border-box;">
          </div>
          <div>
            <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">🕕 إلى</label>
            <input id="bk-to" type="time" value="${_esc(b.timeTo || '')}"
              style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.9rem;box-sizing:border-box;">
          </div>
        </div>

        <!-- الصف -->
        <div style="margin-bottom:1rem;">
          <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">🎓 الصف / المرحلة الدراسية</label>
          <select id="bk-grade" onchange="HallsModule._updateGroupOptions()"
            style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.9rem;background:var(--bg-white);">
            <option value="">-- اختر الصف --</option>
            ${buildGradeOptions(b.grade)}
          </select>
        </div>

        <!-- المجموعة -->
        <div style="margin-bottom:1rem;">
          <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">👥 المجموعة</label>
          <select id="bk-group"
            style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.9rem;background:var(--bg-white);">
            ${buildGroupOptions(b.grade, b.groupId)}
          </select>
        </div>

        <!-- ملاحظات -->
        <div style="margin-bottom:1.4rem;">
          <label style="display:block;font-size:0.84rem;font-weight:700;margin-bottom:5px;">📝 ملاحظات (اختياري)</label>
          <input id="bk-notes" type="text" value="${_esc(b.notes || '')}" placeholder="أي ملاحظة إضافية..."
            style="width:100%;padding:0.7rem;border:1.5px solid var(--border,#e2e8f0);border-radius:10px;font-family:inherit;font-size:0.9rem;box-sizing:border-box;">
        </div>

        <!-- مؤشر التعارض -->
        <div id="conflict-indicator" style="display:none;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;padding:0.75rem 1rem;margin-bottom:1rem;color:#991b1b;font-size:0.85rem;">
          <i class="fas fa-exclamation-triangle"></i> <span id="conflict-msg"></span>
        </div>

        <div style="display:flex;gap:0.75rem;">
          <button onclick="HallsModule.saveBookingModal('${b.hallId || ''}')"
            style="flex:1;padding:0.8rem;border:none;border-radius:10px;background:${color};color:white;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.9rem;">
            <i class="fas fa-save"></i> ${editingBookingId ? 'حفظ التعديل' : 'حفظ الحجز'}
          </button>
          <button onclick="document.getElementById('hall-booking-modal').remove()"
            style="padding:0.8rem 1rem;border:none;border-radius:10px;background:var(--bg-light,#f1f5f9);cursor:pointer;font-family:inherit;">
            إلغاء
          </button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    // تفعيل الكشف اللحظي عن التعارض
    const checkConflict = () => {
      const day     = document.getElementById('bk-day')?.value;
      const tf      = document.getElementById('bk-from')?.value;
      const tt      = document.getElementById('bk-to')?.value;
      const ind     = document.getElementById('conflict-indicator');
      const msgEl   = document.getElementById('conflict-msg');
      if (!day || !tf || !tt || !ind) return;

      if (toMinutes(tt) <= toMinutes(tf)) {
        ind.style.display = 'block';
        msgEl.textContent = 'وقت النهاية يجب أن يكون بعد وقت البداية';
        return;
      }

      const result = detectConflict(b.hallId, day, tf, tt, editingBookingId);
      if (result.conflict) {
        const cw = result.with;
        const dayL = ARABIC_DAYS[DAY_KEYS.indexOf(cw.day)] || cw.day;
        ind.style.display = 'block';
        msgEl.textContent = `تعارض مع حجز موجود: ${dayL} من ${cw.timeFrom} إلى ${cw.timeTo} (${gradeName(cw.grade)} · ${groupName(cw.groupId)})`;
      } else {
        ind.style.display = 'none';
      }
    };

    setTimeout(() => {
      document.getElementById('bk-day')?.addEventListener('change', checkConflict);
      document.getElementById('bk-from')?.addEventListener('change', checkConflict);
      document.getElementById('bk-to')?.addEventListener('change', checkConflict);
    }, 50);
  }

  // تحديث خيارات المجموعة عند تغيير الصف
  function _updateGroupOptions() {
    const gradeId = document.getElementById('bk-grade')?.value || '';
    const sel = document.getElementById('bk-group');
    if (sel) sel.innerHTML = buildGroupOptions(gradeId, '');
  }

  async function saveBookingModal(hallId) {
    const day     = document.getElementById('bk-day')?.value;
    const timeFrom = document.getElementById('bk-from')?.value;
    const timeTo   = document.getElementById('bk-to')?.value;
    const grade    = document.getElementById('bk-grade')?.value || '';
    const groupId  = document.getElementById('bk-group')?.value || '';
    const notes    = document.getElementById('bk-notes')?.value.trim() || '';

    if (!day)     return notify('يرجى اختيار اليوم', 'error');
    if (!timeFrom) return notify('يرجى تحديد وقت البداية', 'error');
    if (!timeTo)   return notify('يرجى تحديد وقت النهاية', 'error');
    if (toMinutes(timeTo) <= toMinutes(timeFrom))
      return notify('وقت النهاية يجب أن يكون بعد وقت البداية', 'error');

    // ── كشف التعارض قبل الحفظ ──
    const targetHallId = editingBookingId
      ? bookings.find(b => String(b.id) === String(editingBookingId))?.hallId
      : hallId;
    const conflict = detectConflict(targetHallId, day, timeFrom, timeTo, editingBookingId);
    if (conflict.conflict) {
      const cw   = conflict.with;
      const dayL = ARABIC_DAYS[DAY_KEYS.indexOf(cw.day)] || cw.day;
      return notify(
        `❌ تعارض في الحجز! القاعة محجوزة ${dayL} من ${cw.timeFrom} إلى ${cw.timeTo} لـ ${gradeName(cw.grade)}`,
        'error'
      );
    }

    if (editingBookingId) {
      const b = bookings.find(x => String(x.id) === String(editingBookingId));
      if (!b) return;
      Object.assign(b, { day, timeFrom, timeTo, grade, groupId, notes });
      await saveBooking(b);
      notify('✅ تم تحديث الحجز');
    } else {
      const b = {
        id: Date.now(),
        hallId: targetHallId,
        day, timeFrom, timeTo, grade, groupId, notes,
        createdAt: new Date().toISOString()
      };
      bookings.push(b);
      await saveBooking(b);
      notify('✅ تم إضافة الحجز بنجاح');
    }

    _removeModal('hall-booking-modal');
    renderHallsSection();
    if (activeHallId) renderHallDetail(activeHallId);
  }

  async function deleteBooking(bookingId) {
    const b = bookings.find(x => String(x.id) === String(bookingId));
    if (!b) return;
    const dayL = ARABIC_DAYS[DAY_KEYS.indexOf(b.day)] || b.day;
    if (!confirm(`حذف هذا الحجز؟\n${dayL} · ${b.timeFrom} — ${b.timeTo} · ${gradeName(b.grade)}`)) return;

    await deleteBookingDB(b.id);
    bookings = bookings.filter(x => String(x.id) !== String(bookingId));
    notify('تم حذف الحجز');
    renderHallsSection();
    if (activeHallId) renderHallDetail(activeHallId);
  }

  /* ══════════════════════════════════════════════════════════
     مساعد إزالة المودال
  ══════════════════════════════════════════════════════════ */
  function _removeModal(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  /* ══════════════════════════════════════════════════════════
     نقطة الدخول الرئيسية — تُستدعى من showSection
  ══════════════════════════════════════════════════════════ */
  async function initHallsSection() {
    await loadData();
    renderHallsSection();
  }

  /* ══════════════════════════════════════════════════════════
     حقن عنصر التنقل وقسم HTML في صفحة app.js
  ══════════════════════════════════════════════════════════ */
  function ensureHallsNav() {
    if (document.getElementById('nav-halls')) return;
    const nav = document.querySelector('.nav-links');
    if (!nav) return;

    const item = document.createElement('li');
    item.className = 'nav-item';
    item.innerHTML = `
      <a href="#" class="nav-link" id="nav-halls" onclick="showSection('halls', this)">
        <i class="fas fa-building" style="color:#8b5cf6;"></i>
        <span>القاعات</span>
      </a>`;

    // أضفه قبل قسم «الإعدادات» أو في آخر القائمة
    const settingsItem = document.getElementById('nav-settings')?.closest('.nav-item');
    nav.insertBefore(item, settingsItem || nav.lastElementChild);
  }

  function ensureHallsSection() {
    if (document.getElementById('halls-section')) return;
    const main = document.querySelector('.main-content');
    if (!main) return;

    const section = document.createElement('section');
    section.id = 'halls-section';
    section.className = 'fade-in';
    section.style.display = 'none';
    section.innerHTML = `
      <!-- ── هيدر القسم ── -->
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:1.5rem;">
        <div>
          <h2 style="margin:0;font-size:1.3rem;font-weight:800;color:var(--text-main);">
            <i class="fas fa-building" style="color:#8b5cf6;margin-left:8px;"></i> إدارة القاعات الدراسية
          </h2>
          <p style="margin:4px 0 0;font-size:0.85rem;color:var(--text-muted);">
            جدولة القاعات مع كشف التعارض التلقائي
          </p>
        </div>
        <button onclick="HallsModule.openAddHallModal()"
          style="padding:0.7rem 1.4rem;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:white;border:none;border-radius:12px;font-weight:700;cursor:pointer;font-family:inherit;font-size:0.9rem;box-shadow:0 4px 12px rgba(139,92,246,0.3);">
          <i class="fas fa-plus"></i> قاعة جديدة
        </button>
      </div>

      <!-- ── المحتوى الديناميكي ── -->
      <div id="halls-content"></div>`;

    main.appendChild(section);
  }

  /* ══════════════════════════════════════════════════════════
     تصدير API عام
  ══════════════════════════════════════════════════════════ */
  window.HallsModule = {
    init: initHallsSection,
    openAddHallModal,
    openEditHallModal,
    saveHallModal,
    deleteHall,
    openHallDetail: (id) => { renderHallDetail(id); },
    closeHallDetail,
    openAddBookingModal,
    openEditBookingModal,
    saveBookingModal,
    deleteBooking,
    _updateGroupOptions,
    ensureUI() {
      ensureHallsNav();
      ensureHallsSection();
    }
  };

  // ── تسجيل تلقائي عند تحميل الصفحة ──
  document.addEventListener('DOMContentLoaded', () => {
    HallsModule.ensureUI();
    console.log('[halls.js] ✅ نظام القاعات جاهز');
  });

})();
