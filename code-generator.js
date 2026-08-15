// ============================================================
//  code-generator.js  —  Central Student Code Generator
//  المولّد المركزي لأكواد الطلاب
//
//  يُستخدم من الأنظمة الثلاثة:
//    1. نظام إدارة الدروس (app.js / IndexedDB)
//    2. نظام SMS / الحجز   (auto-activate.js / Firestore)
//    3. المنصة التعليمية   (platform-subscriptions.js / Firebase)
//
//  صيغة الكود:
//    - 12 رقمًا إنجليزيًا فقط  (0-9)
//    - بلا حروف، بلا شرطات، بلا رموز، بلا مسافات
//    - مثال: 182743920561
//
//  ضمانات التفرّد:
//    - IndexedDB: unique index على حقل qrCode
//    - Firestore:  فحص في centerStudents + students قبل الاعتماد
//    - توليد مع retry حتى 20 محاولة، ثم fallback بـ timestamp كامل
// ============================================================

/**
 * يولّد كود خام مكوّن من 12 رقمًا إنجليزيًا فقط.
 *   - أول رقم دائمًا 1-9 (لا يبدأ بصفر)
 *   - 11 رقمًا عشوائيًا بعده
 * @returns {string}  e.g. "182743920561"
 */
function _generateRawCode() {
  const first = Math.floor(1 + Math.random() * 9);           // 1-9
  const rest  = Array.from({ length: 11 }, () =>
    Math.floor(Math.random() * 10)
  ).join('');
  return String(first) + rest;  // 12 أرقام إجمالاً
}

// ──────────────────────────────────────────────────────────────
//  1.  للاستخدام في نظام إدارة الدروس  (IndexedDB / app.js)
//      يتحقق من خلال مصفوفة الطلاب المحليّة (db.students)
// ──────────────────────────────────────────────────────────────

/**
 * يولّد كودًا فريدًا بالتحقق من db.students المحلية.
 * @param {Array} existingStudents  - db.students الحالية
 * @returns {string}
 */
function generateLocalUniqueCode(existingStudents) {
  const usedCodes = new Set(
    (existingStudents || []).map(s => String(s.qrCode || s.centerCode || ''))
  );

  let code;
  let tries = 0;
  do {
    code = _generateRawCode();
    tries++;
  } while (usedCodes.has(code) && tries < 20);

  if (usedCodes.has(code)) {
    // Fallback: timestamp كامل (13 رقمًا → نأخذ 12 بإزالة أول رقم)
    code = String(Date.now()).slice(1);  // 12 رقمًا
  }

  return code;
}

// ──────────────────────────────────────────────────────────────
//  2.  للاستخدام في Firestore  (auto-activate.js / SMS)
//      يتحقق من كلا الـ collections: centerStudents + students
// ──────────────────────────────────────────────────────────────

/**
 * يتحقق أن الكود غير موجود في Firestore.
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} code
 * @returns {Promise<boolean>}
 */
async function _isFirestoreCodeUnique(db, code) {
  const [snap1, snap2] = await Promise.all([
    db.collection('centerStudents').where('centerCode', '==', code).limit(1).get(),
    db.collection('students')
      .where('qrCode', '==', code).limit(1).get(),
  ]);
  return snap1.empty && snap2.empty;
}

/**
 * يولّد كودًا فريدًا مضمونًا مع Firestore.
 * @param {FirebaseFirestore.Firestore} db
 * @returns {Promise<string>}
 */
async function generateFirestoreUniqueCode(db) {
  let code;
  let unique = false;
  let tries  = 0;

  while (!unique && tries < 20) {
    code   = _generateRawCode();
    unique = await _isFirestoreCodeUnique(db, code);
    tries++;
  }

  if (!unique) {
    // Fallback محصّن: timestamp + عشوائي
    code = String(Date.now()).slice(1);       // 12 رقمًا
    // لو لا يزال متكررًا (نادر جدًا) نضيف رقمًا إضافيًا
    if (!(await _isFirestoreCodeUnique(db, code))) {
      code = String(Date.now() + Math.floor(Math.random() * 1000)).slice(1);
    }
  }

  return code;
}

// ──────────────────────────────────────────────────────────────
//  تصدير: Node.js (Firebase Functions) أو Browser (app.js)
// ──────────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    generateLocalUniqueCode,
    generateFirestoreUniqueCode,
  };
} else {
  window.generateLocalUniqueCode    = generateLocalUniqueCode;
  window.generateFirestoreUniqueCode = generateFirestoreUniqueCode;
}
