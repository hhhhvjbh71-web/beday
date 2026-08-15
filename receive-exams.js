// ============================================================
//  receive-exams.js  v1.0
//  استلام نتائج الاختبارات المُصدَّرة من المنصة التعليمية
//  إلى نظام دفتر الدروس (IndexedDB / app.js)
//
//  آلية الربط: نفس نمط "syncWithPlatform" الموجود في
//  platform-subscriptions.js — قراءة يدوية بضغطة زر من Firestore
//  collection مشترك بين المنصة والسيستم: exported_exam_results
//
//  شكل الوثيقة المتوقع في exported_exam_results (تكتبها المنصة):
//  {
//    quizId, quizTitle, subject, teacherName, examDate,
//    totalPoints, grade (platformCode أو systemCode),
//    exportedAt,
//    received: false,
//    results: [
//      { studentCode, studentName, score, attended (bool) }, ...
//    ]
//  }
//
//  الربط بين الطالبين يتم حصريًا عبر studentCode (qrCode الموحّد) —
//  وليس بالاسم — ولا يُنشأ أي طالب جديد؛ يُتجاهل أي نتيجة لطالب
//  غير موجود بالفعل في db.students.
// ============================================================

(function () {
  'use strict';

  /**
   * زر "استلام الاختبارات" — يفتح نافذة بكل الاختبارات المُصدَّرة
   * من المنصة والمرتبطة بنفس الصف الحالي (currentGrade) ولم تُستلم بعد.
   *
   * ملاحظة: هذه الوظيفة مرتبطة بقاعدة بيانات المنصة التعليمية
   * التي تم إلغاء ربطها بهذا المشروع. الوظيفة معطّلة مؤقتاً.
   */
  async function showReceiveExamsModal() {
    // قاعدة بيانات المنصة التعليمية غير مفعّلة في هذا المشروع
    showNotification('❌ استلام الاختبارات من المنصة غير مفعّل في هذا المشروع.', 'error');
    return;

    const existingModal = document.getElementById('receive-exams-modal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'receive-exams-modal';
    modal.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:99999',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(0,0,0,0.55)', 'backdrop-filter:blur(3px)'
    ].join(';');

    modal.innerHTML = `
      <div id="receive-exams-inner" style="
          background:var(--bg-white,#fff); border-radius:20px; padding:2rem;
          max-width:640px; width:94%; max-height:85vh; overflow-y:auto;
          box-shadow:0 25px 60px rgba(0,0,0,0.3); direction:rtl; font-family:inherit;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.2rem;">
          <h2 style="margin:0;color:var(--primary,#4f46e5);font-size:1.2rem;font-weight:800;">
            <i class="fas fa-cloud-download-alt" style="margin-left:8px;"></i>
            استلام الاختبارات من المنصة التعليمية
          </h2>
          <button onclick="document.getElementById('receive-exams-modal').remove()"
            style="background:var(--bg-light,#f1f5f9);border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;">
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div id="receive-exams-list-body" style="min-height:120px;">
          <div style="text-align:center;padding:2rem;opacity:0.6;">
            <i class="fas fa-spinner fa-spin"></i> جاري البحث عن اختبارات جديدة...
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    await _loadPendingExportedExams();
  }

  async function _loadPendingExportedExams() {
    const body = document.getElementById('receive-exams-list-body');
    if (!body) return;

    let pending = [];
    try {
      // نجيب كل الوثائق غير المُستلمة، ثم نفلتر بالصف محليًا
      // (تفاديًا للاعتماد على composite index في Firestore)
      const snap = await window.db.collection('exported_exam_results')
        .where('received', '==', false)
        .get();

      snap.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const examGradeSystem = (typeof normalizeGrade === 'function')
          ? normalizeGrade(data.grade)
          : String(data.grade || '');

        if (typeof currentGrade === 'undefined' || String(examGradeSystem) === String(currentGrade)) {
          pending.push({ id: docSnap.id, ...data, _systemGrade: examGradeSystem });
        }
      });
    } catch (err) {
      console.error('[receive-exams] فشل جلب الاختبارات المصدَّرة:', err);
      body.innerHTML = `<p style="text-align:center;color:#991b1b;padding:2rem;">
        ❌ تعذّر الاتصال بالمنصة. تحقق من الإنترنت وحاول مرة أخرى.</p>`;
      return;
    }

    if (pending.length === 0) {
      body.innerHTML = `<p style="text-align:center;opacity:0.6;padding:2rem;">
        لا توجد اختبارات جديدة بانتظار الاستلام لهذا الصف حاليًا.</p>`;
      return;
    }

    body.innerHTML = pending.map((exam) => {
      const studentCount = Array.isArray(exam.results) ? exam.results.length : 0;
      const examDateLabel = exam.examDate
        ? new Date(exam.examDate).toLocaleDateString('ar-EG')
        : (exam.exportedAt ? new Date(exam.exportedAt).toLocaleDateString('ar-EG') : '--');

      return `
        <div style="border:1.5px solid var(--border,#e2e8f0); border-radius:14px; padding:1rem 1.2rem; margin-bottom:0.9rem;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.75rem;">
            <div>
              <div style="font-weight:800; font-size:1.02rem; color:var(--text-main,#1e293b);">
                ${escapeHtmlForReceive(exam.quizTitle || 'اختبار بدون عنوان')}
              </div>
              <div style="font-size:0.82rem; color:var(--text-muted,#64748b); margin-top:4px; line-height:1.8;">
                📚 ${escapeHtmlForReceive(exam.subject || 'عام')} &nbsp;|&nbsp;
                👨‍🏫 ${escapeHtmlForReceive(exam.teacherName || '--')} &nbsp;|&nbsp;
                📅 ${examDateLabel}<br>
                👥 عدد الطلاب: ${studentCount} &nbsp;|&nbsp;
                🎯 الدرجة الكلية: ${exam.totalPoints ?? '--'}
              </div>
            </div>
            <button onclick="window._confirmReceiveExportedExam('${exam.id}')"
              style="flex-shrink:0; padding:0.55rem 1.1rem; border:none; border-radius:10px;
                     background:linear-gradient(135deg,#16a34a,#15803d); color:#fff; font-weight:700;
                     cursor:pointer; font-family:inherit; font-size:0.88rem;">
              <i class="fas fa-download"></i> استلام
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  function escapeHtmlForReceive(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /**
   * تنفيذ الاستلام الفعلي لاختبار واحد:
   *  - منع التكرار (لو سبق استلامه)
   *  - إنشاء exam بنفس شكل handleAddExam بالضبط
   *  - رصد الدرجات تلقائيًا لكل طالب موجود بالفعل في السيستم (ربط بـ qrCode فقط)
   *  - وضع الغائبين (attended === false) كغائبين (mark = -1)
   *  - تحديث Firestore بأن الاختبار تم استلامه
   */
  async function receiveExportedExam(exportId) {
    if (!window.db) return;

    // 0) تأكيد بيانات db محليًا جاهزة
    if (!db || !Array.isArray(db.exams) || !Array.isArray(db.scores) || !Array.isArray(db.students)) {
      showNotification('❌ بيانات البرنامج غير جاهزة بعد، أعد المحاولة بعد لحظات', 'error');
      return;
    }

    let docRef, data;
    try {
      docRef = window.db.collection('exported_exam_results').doc(exportId);
      const docSnap = await docRef.get();
      if (!docSnap.exists) {
        showNotification('❌ هذا الاختبار لم يعد موجودًا على المنصة', 'error');
        return;
      }
      data = docSnap.data() || {};
    } catch (err) {
      showNotification('❌ فشل الاتصال بالمنصة: ' + (err.message || err), 'error');
      return;
    }

    // ── منع التكرار: هل هذا الاختبار مُستلم بالفعل محليًا؟ ──
    if (data.received === true) {
      showNotification('⚠️ هذا الاختبار تم استلامه بالفعل ولن يُستورد مرة أخرى', 'warning');
      const modal = document.getElementById('receive-exams-modal');
      if (modal) modal.remove();
      return;
    }
    const alreadyLocal = db.exams.find(e => e.platformQuizId && String(e.platformQuizId) === String(data.quizId || exportId));
    if (alreadyLocal) {
      showNotification('⚠️ هذا الاختبار موجود بالفعل داخل السيستم، لن يتم إنشاء نسخة جديدة', 'warning');
      try { await docRef.set({ received: true, receivedAt: new Date().toISOString() }, { merge: true }); } catch (e) {}
      return;
    }

    const examGradeSystem = (typeof normalizeGrade === 'function')
      ? normalizeGrade(data.grade)
      : (typeof currentGrade !== 'undefined' ? currentGrade : String(data.grade || ''));

    // ── 1) إنشاء الاختبار بنفس شكل handleAddExam بالضبط ──
    const newExam = {
      id: Date.now(),
      title: data.quizTitle || 'اختبار من المنصة',
      maxMarks: data.totalPoints || 100,
      grade: examGradeSystem,
      groupId: null, // اختبار عام على مستوى الصف — يظهر لكل مجموعات الصف (نفس منطق renderExams)
      source: 'platform',
      platformQuizId: data.quizId || exportId,
      platformExamDate: data.examDate || data.exportedAt || null
    };

    // ── 2) رصد الدرجات تلقائيًا — ربط بالكود الموحّد (qrCode) فقط ──
    const results = Array.isArray(data.results) ? data.results : [];
    let matchedCount = 0;
    let skippedCount = 0;
    const newScores = [];

    results.forEach((r) => {
      const code = String(r.studentCode || '').trim();
      if (!code) { skippedCount++; return; }

      // البحث الحصري بالكود الموحّد داخل طلاب السيستم الفعليين
      const localStudent = db.students.find(s => String(s.qrCode || s.centerCode || '') === code);
      if (!localStudent) { skippedCount++; return; } // لا يُنشأ طالب جديد أبدًا

      matchedCount++;
      const isAbsent = r.attended === false;
      newScores.push({
        id: Date.now() + Math.random(),
        examId: newExam.id,
        studentId: localStudent.id,
        mark: isAbsent ? -1 : (typeof r.score === 'number' ? r.score : Number(r.score) || 0),
        date: new Date().toISOString()
      });
    });

    if (matchedCount === 0) {
      showNotification('⚠️ لا يوجد أي طالب من نتائج هذا الاختبار مسجّل بالفعل في السيستم، لم يتم الاستيراد', 'warning');
      return;
    }

    // ── 3) الحفظ محليًا ──
    db.exams.push(newExam);
    newScores.forEach(sc => db.scores.push(sc));
    await db.save('exams');
    await db.save('scores');

    // ── 4) تحديث الواجهة فورًا (نفس ما تفعله بقية الدوال في البرنامج) ──
    if (typeof renderExams === 'function') renderExams();
    if (typeof updateDashboardStats === 'function') updateDashboardStats();

    // ── 5) تسجيل في Activity Log إن وُجد ──
    if (typeof RBAC !== 'undefined' && RBAC.log) {
      RBAC.log('receive_platform_exam', `${newExam.title} | من المنصة | طلاب تم رصدهم: ${matchedCount} | تم تجاهلهم: ${skippedCount}`);
    }

    // ── 6) تعليم الاختبار كمُستلم في Firestore (منع التكرار) ──
    try {
      await docRef.set({
        received: true,
        receivedAt: new Date().toISOString(),
        receivedCount: matchedCount,
        skippedCount: skippedCount
      }, { merge: true });
    } catch (err) {
      console.warn('[receive-exams] تعذّر تعليم الاختبار كمُستلم على المنصة (سيُحاول لاحقًا):', err);
    }

    showNotification(
      `✅ تم استلام "${newExam.title}" — تم رصد ${matchedCount} طالب${skippedCount ? `، وتجاهل ${skippedCount} (غير مسجلين في السيستم)` : ''}`,
      'success'
    );

    // إغلاق المودال وتحديث القائمة (في حال بقيت اختبارات أخرى معلّقة)
    const modal = document.getElementById('receive-exams-modal');
    if (modal) {
      await _loadPendingExportedExams();
    }
  }

  async function _confirmReceiveExportedExam(exportId) {
    await receiveExportedExam(exportId);
  }

  window.showReceiveExamsModal        = showReceiveExamsModal;
  window.receiveExportedExam          = receiveExportedExam;
  window._confirmReceiveExportedExam  = _confirmReceiveExportedExam;

  console.log('[receive-exams.js] ✅ تم تحميل نظام استلام الاختبارات من المنصة');
})();
