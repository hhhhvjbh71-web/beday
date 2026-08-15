// ============================================================
//  device-sync.js  —  مزامنة الأجهزة عبر Firebase
//
//  الهدف:
//    مزامنة الطلاب والمدفوعات بين أجهزة السنتر المختلفة
//    (لابتوب الحضور ↔ لابتوب الخزينة) عن طريق Firebase
//
//  المجموعات المستخدمة في Firestore:
//    device_students  → بيانات الطلاب الكاملة
//    device_payments  → بيانات المدفوعات الكاملة
//
//  مبدأ التشغيل:
//    - النظام يعمل Offline دائماً
//    - الإنترنت يُستخدم فقط عند الضغط على أزرار الرفع/الاستلام
//    - المزامنة لا تحذف — فقط تُحدّث وتُضيف
// ============================================================

// ─── مفتاح التميّز بين بيانات الأجهزة وبيانات المنصة ────────
const DEVICE_SYNC_COLLECTION_STUDENTS = 'device_students';
const DEVICE_SYNC_COLLECTION_PAYMENTS = 'device_payments';
const DEVICE_SYNC_COLLECTION_ABSENCE  = 'device_absence_sessions';

// ─── مساعد: تحضير Firebase (يستخدم قاعدة مزامنة الأجهزة الجديدة) ──
async function _ensureFirebaseForSync() {
    // window.db يشير لقاعدة مزامنة الأجهزة (ahmedsimer) بعد التعديل
    if (window.db && typeof window.db.collection === 'function') return true;
    // الاستدعاء المباشر لدالة تهيئة قاعدة المزامنة
    if (typeof ensureDeviceSyncFirebaseInitialized === 'function') {
        return await ensureDeviceSyncFirebaseInitialized();
    }
    return false;
}

// ─── مساعد: حالة الزر أثناء العملية ─────────────────────────
function _setBtnLoading(btnId, text) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${text}`;
}
function _setBtnReady(btnId, icon, text) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = false;
    btn.innerHTML = `<i class="fas ${icon}"></i> ${text}`;
}

// ============================================================
//  0. مزامنة جلسة أرشفة غياب واحدة (تُستدعى تلقائياً بعد كل عملية أرشفة)
//     — بدون زر، بدون رسالة خطأ للمستخدم لو الجهاز أوفلاين، فقط
//       محاولة صامتة لرفع نفس الجلسة اللي اتحفظت محلياً بالفعل.
// ============================================================
async function syncAbsenceSessionToCloud(session) {
    if (!session || !session.id) return;
    try {
        const firebaseReady = await _ensureFirebaseForSync();
        if (!firebaseReady) return; // العمل أوفلاين طبيعي — الجلسة محفوظة محلياً بالفعل

        const firestore = window.db;
        const docRef = firestore.collection(DEVICE_SYNC_COLLECTION_ABSENCE).doc(String(session.id));
        await docRef.set({
            ...session,
            _syncedAt: new Date().toISOString(),
            _deviceId: _getDeviceId(),
        }, { merge: true });
    } catch (err) {
        console.warn('[DeviceSync] تعذّرت مزامنة جلسة الأرشفة (ستبقى محفوظة محلياً وتُحاول لاحقاً):', err);
    }
}

// ============================================================
//  1. رفع الطلاب إلى السحابة
// ============================================================
async function uploadStudentsToCloud() {
    const btnId = 'btn-upload-students';
    _setBtnLoading(btnId, 'جاري رفع الطلاب...');

    try {
        showNotification('🔗 جاري الاتصال بالسحابة لرفع بيانات الطلاب...', 'info');

        const firebaseReady = await _ensureFirebaseForSync();
        if (!firebaseReady) {
            showNotification('❌ Firebase غير متاح. تأكد من اتصالك بالإنترنت وحاول مجدداً.', 'error');
            return;
        }

        // جلب الطلاب من IndexedDB
        if (!StorageEngine.db) await StorageEngine.init();
        const allStudents = await StorageEngine.getAll('students');

        if (!allStudents || allStudents.length === 0) {
            showNotification('⚠️ لا يوجد طلاب لرفعهم.', 'warning');
            return;
        }

        const firestore = window.db;
        let batch = firestore.batch();
        let batchCount = 0;
        let uploadCount = 0;

        for (const student of allStudents) {
            if (!student.id) continue;

            // نرفع بيانات الطالب كاملة — بدون حذف أي حقل
            const docRef = firestore
                .collection(DEVICE_SYNC_COLLECTION_STUDENTS)
                .doc(String(student.id));

            const payload = {
                ...student,
                _syncedAt: new Date().toISOString(),
                _deviceId: _getDeviceId(),
            };

            batch.set(docRef, payload, { merge: true });
            batchCount++;
            uploadCount++;

            // Firestore batch limit = 500
            if (batchCount >= 400) {
                await batch.commit();
                batch = firestore.batch();
                batchCount = 0;
            }
        }

        if (batchCount > 0) await batch.commit();

        showNotification(`✅ تم رفع ${uploadCount} طالب إلى السحابة بنجاح!`, 'success');
        if (typeof RBAC !== 'undefined') RBAC.log('upload_students_cloud', `${uploadCount} طالب`);

        // تحديث وقت آخر مزامنة
        _saveLastSyncTime('students_upload');

    } catch (err) {
        console.error('[DeviceSync] Upload students error:', err);
        showNotification('❌ حدث خطأ أثناء رفع الطلاب: ' + err.message, 'error');
    } finally {
        _setBtnReady(btnId, 'fa-cloud-upload-alt', 'رفع الطلاب إلى السحابة');
        _renderSyncStatus();
    }
}

// ============================================================
//  2. استلام الطلاب من السحابة
// ============================================================
async function downloadStudentsFromCloud() {
    const btnId = 'btn-download-students';
    _setBtnLoading(btnId, 'جاري استلام الطلاب...');

    try {
        showNotification('🔗 جاري الاتصال بالسحابة لاستلام بيانات الطلاب...', 'info');

        const firebaseReady = await _ensureFirebaseForSync();
        if (!firebaseReady) {
            showNotification('❌ Firebase غير متاح. تأكد من اتصالك بالإنترنت وحاول مجدداً.', 'error');
            return;
        }

        if (!StorageEngine.db) await StorageEngine.init();

        // جلب الطلاب الحاليين (للتحقق من التكرار)
        const localStudents = await StorageEngine.getAll('students');
        const localById = new Map(localStudents.map(s => [String(s.id), s]));
        const localByQr = new Map(
            localStudents
                .filter(s => s.qrCode)
                .map(s => [String(s.qrCode), s])
        );

        // جلب الطلاب من Firebase
        const snapshot = await window.db
            .collection(DEVICE_SYNC_COLLECTION_STUDENTS)
            .get();

        if (snapshot.empty) {
            showNotification('⚠️ لا يوجد طلاب في السحابة بعد. ارفع الطلاب أولاً من الجهاز الآخر.', 'warning');
            return;
        }

        let addedCount = 0;
        let updatedCount = 0;

        for (const doc of snapshot.docs) {
            const cloudStudent = { ...doc.data() };

            // حذف حقول الـ sync المساعدة
            delete cloudStudent._syncedAt;
            delete cloudStudent._deviceId;

            const idKey   = String(cloudStudent.id   || '');
            const qrKey   = String(cloudStudent.qrCode || '');

            // البحث عن الطالب محلياً بـ id أو qrCode
            const existing = localById.get(idKey) || (qrKey ? localByQr.get(qrKey) : null);

            if (existing) {
                // تحديث البيانات مع الحفاظ على الـ id المحلي
                const updated = {
                    ...existing,
                    ...cloudStudent,
                    id: existing.id, // الحفاظ على الـ id المحلي دائماً
                };
                await StorageEngine.save('students', updated);
                // تحديث الذاكرة
                const idx = db.students.findIndex(s => s.id === existing.id);
                if (idx !== -1) db.students[idx] = updated;
                updatedCount++;
            } else {
                // طالب جديد — إضافته مباشرة
                await StorageEngine.save('students', cloudStudent);
                db.students.push(cloudStudent);
                // تحديث الـ maps لتجنب تكرار نفس الطالب في دورة نفس الـ snapshot
                if (idKey) localById.set(idKey, cloudStudent);
                if (qrKey) localByQr.set(qrKey, cloudStudent);
                addedCount++;
            }
        }

        showNotification(
            `✅ تم استلام الطلاب من السحابة: ${addedCount} جديد، ${updatedCount} محدَّث.`,
            'success'
        );

        if (typeof RBAC !== 'undefined')
            RBAC.log('download_students_cloud', `${addedCount} جديد، ${updatedCount} محدَّث`);

        _saveLastSyncTime('students_download');

        // تحديث الواجهة
        if (typeof renderStudents === 'function') renderStudents();
        if (typeof syncUIWithContext === 'function') syncUIWithContext();

    } catch (err) {
        console.error('[DeviceSync] Download students error:', err);
        showNotification('❌ حدث خطأ أثناء استلام الطلاب: ' + err.message, 'error');
    } finally {
        _setBtnReady(btnId, 'fa-cloud-download-alt', 'استلام الطلاب من السحابة');
        _renderSyncStatus();
    }
}

// ============================================================
//  3. رفع المدفوعات إلى السحابة
// ============================================================
async function uploadPaymentsToCloud() {
    const btnId = 'btn-upload-payments';
    _setBtnLoading(btnId, 'جاري رفع المدفوعات...');

    try {
        showNotification('🔗 جاري الاتصال بالسحابة لرفع بيانات المدفوعات...', 'info');

        const firebaseReady = await _ensureFirebaseForSync();
        if (!firebaseReady) {
            showNotification('❌ Firebase غير متاح. تأكد من اتصالك بالإنترنت وحاول مجدداً.', 'error');
            return;
        }

        if (!StorageEngine.db) await StorageEngine.init();
        const allPayments = await StorageEngine.getAll('payments');

        if (!allPayments || allPayments.length === 0) {
            showNotification('⚠️ لا يوجد مدفوعات لرفعها.', 'warning');
            return;
        }

        const firestore = window.db;
        let batch = firestore.batch();
        let batchCount = 0;
        let uploadCount = 0;

        for (const payment of allPayments) {
            if (!payment.id) continue;

            const docRef = firestore
                .collection(DEVICE_SYNC_COLLECTION_PAYMENTS)
                .doc(String(payment.id));

            const payload = {
                ...payment,
                _syncedAt: new Date().toISOString(),
                _deviceId: _getDeviceId(),
            };

            batch.set(docRef, payload, { merge: true });
            batchCount++;
            uploadCount++;

            if (batchCount >= 400) {
                await batch.commit();
                batch = firestore.batch();
                batchCount = 0;
            }
        }

        if (batchCount > 0) await batch.commit();

        showNotification(`✅ تم رفع ${uploadCount} دفعة إلى السحابة بنجاح!`, 'success');
        if (typeof RBAC !== 'undefined') RBAC.log('upload_payments_cloud', `${uploadCount} دفعة`);

        _saveLastSyncTime('payments_upload');

    } catch (err) {
        console.error('[DeviceSync] Upload payments error:', err);
        showNotification('❌ حدث خطأ أثناء رفع المدفوعات: ' + err.message, 'error');
    } finally {
        _setBtnReady(btnId, 'fa-cloud-upload-alt', 'رفع المدفوعات إلى السحابة');
        _renderSyncStatus();
    }
}

// ============================================================
//  4. استلام المدفوعات من السحابة
// ============================================================
async function downloadPaymentsFromCloud() {
    const btnId = 'btn-download-payments';
    _setBtnLoading(btnId, 'جاري استلام المدفوعات...');

    try {
        showNotification('🔗 جاري الاتصال بالسحابة لاستلام بيانات المدفوعات...', 'info');

        const firebaseReady = await _ensureFirebaseForSync();
        if (!firebaseReady) {
            showNotification('❌ Firebase غير متاح. تأكد من اتصالك بالإنترنت وحاول مجدداً.', 'error');
            return;
        }

        if (!StorageEngine.db) await StorageEngine.init();

        const localPayments = await StorageEngine.getAll('payments');
        const localById = new Map(localPayments.map(p => [String(p.id), p]));

        const snapshot = await window.db
            .collection(DEVICE_SYNC_COLLECTION_PAYMENTS)
            .get();

        if (snapshot.empty) {
            showNotification('⚠️ لا يوجد مدفوعات في السحابة بعد. ارفع المدفوعات أولاً من الجهاز الآخر.', 'warning');
            return;
        }

        let addedCount = 0;
        let updatedCount = 0;

        for (const doc of snapshot.docs) {
            const cloudPayment = { ...doc.data() };

            delete cloudPayment._syncedAt;
            delete cloudPayment._deviceId;

            const idKey = String(cloudPayment.id || '');
            const existing = localById.get(idKey);

            if (existing) {
                const updated = { ...existing, ...cloudPayment, id: existing.id };
                await StorageEngine.save('payments', updated);
                const idx = db.payments.findIndex(p => p.id === existing.id);
                if (idx !== -1) db.payments[idx] = updated;
                updatedCount++;
            } else {
                await StorageEngine.save('payments', cloudPayment);
                db.payments.push(cloudPayment);
                if (idKey) localById.set(idKey, cloudPayment);
                addedCount++;
            }
        }

        showNotification(
            `✅ تم استلام المدفوعات من السحابة: ${addedCount} جديدة، ${updatedCount} محدَّثة.`,
            'success'
        );

        if (typeof RBAC !== 'undefined')
            RBAC.log('download_payments_cloud', `${addedCount} جديدة، ${updatedCount} محدَّثة`);

        _saveLastSyncTime('payments_download');

        // تحديث واجهة المالية إن كانت مفتوحة
        if (typeof renderFinances === 'function') renderFinances();
        if (typeof renderMonthlySubscriptionTables === 'function') renderMonthlySubscriptionTables();

    } catch (err) {
        console.error('[DeviceSync] Download payments error:', err);
        showNotification('❌ حدث خطأ أثناء استلام المدفوعات: ' + err.message, 'error');
    } finally {
        _setBtnReady(btnId, 'fa-cloud-download-alt', 'استلام المدفوعات من السحابة');
        _renderSyncStatus();
    }
}

// ============================================================
//  مساعدات داخلية
// ============================================================

/** مُعرِّف الجهاز — يُولَّد مرة واحدة ويُحفظ في localStorage */
function _getDeviceId() {
    let id = localStorage.getItem('_device_sync_id');
    if (!id) {
        id = 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        localStorage.setItem('_device_sync_id', id);
    }
    return id;
}

/** حفظ وقت آخر مزامنة */
function _saveLastSyncTime(key) {
    const times = JSON.parse(localStorage.getItem('_device_sync_times') || '{}');
    times[key] = new Date().toISOString();
    localStorage.setItem('_device_sync_times', JSON.stringify(times));
}

/** قراءة وقت آخر مزامنة */
function _getLastSyncTime(key) {
    const times = JSON.parse(localStorage.getItem('_device_sync_times') || '{}');
    if (!times[key]) return null;
    return new Date(times[key]).toLocaleString('ar-EG');
}

/** تحديث جدول حالة المزامنة في الواجهة */
function _renderSyncStatus() {
    const container = document.getElementById('device-sync-status');
    if (!container) return;

    const rows = [
        { key: 'students_upload',   label: 'آخر رفع للطلاب' },
        { key: 'students_download', label: 'آخر استلام للطلاب' },
        { key: 'payments_upload',   label: 'آخر رفع للمدفوعات' },
        { key: 'payments_download', label: 'آخر استلام للمدفوعات' },
    ];

    container.innerHTML = rows
        .map(r => {
            const t = _getLastSyncTime(r.key);
            return `
            <div style="display:flex; justify-content:space-between; align-items:center;
                        padding:0.5rem 0; border-bottom:1px solid var(--border); font-size:0.85rem;">
                <span style="color:var(--text-muted);">${r.label}</span>
                <span style="font-weight:600; color:${t ? 'var(--accent)' : '#94a3b8'};">
                    ${t || 'لم تتم بعد'}
                </span>
            </div>`;
        })
        .join('');
}

// ─── تصدير عالمي ─────────────────────────────────────────────
window.uploadStudentsToCloud   = uploadStudentsToCloud;
window.downloadStudentsFromCloud = downloadStudentsFromCloud;
window.uploadPaymentsToCloud   = uploadPaymentsToCloud;
window.downloadPaymentsFromCloud = downloadPaymentsFromCloud;
window._renderSyncStatus       = _renderSyncStatus;

// تحديث حالة المزامنة عند تحميل الصفحة
document.addEventListener('DOMContentLoaded', () => {
    // تأجير قليلاً لضمان تحميل الـ DOM بالكامل
    setTimeout(_renderSyncStatus, 1000);
});
